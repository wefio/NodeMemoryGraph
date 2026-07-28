import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { OpenAIEmbeddingClient } from "../../src/core/openai-embedding.ts";
import { syncRecordEmbeddings } from "../../src/core/embedding-sync.ts";
import { NmgStore } from "../../src/core/store.ts";
import type { HistoryRole, MemoryActor } from "../../src/core/types.ts";

export interface OmniMessage {
  role?: string;
  content: string;
  chat_time?: string;
}

export type OmniRequest =
  | {
      id: string | number;
      op: "add";
      userId: string;
      messages: OmniMessage[];
      conversationId?: string;
    }
  | {
      id: string | number;
      op: "search";
      userId: string;
      query: string;
      topK: number;
    }
  | {
      id: string | number;
      op: "delete";
      userId: string;
    }
  | {
      id: string | number;
      op: "close";
    };

export interface OmniResponse {
  id: string | number;
  result?: unknown;
  error?: string;
}

export interface OmniEmbeddingClient {
  readonly indexId: string;
  embedQueries(inputs: string[]): Promise<number[][]>;
  embedDocuments(inputs: string[]): Promise<number[][]>;
}

export interface OmniMemEvalBridgeOptions {
  embeddingClient?: OmniEmbeddingClient;
  embeddingBatchSize?: number;
}

/**
 * Runtime-neutral bridge used by OmniMemEval's Python client.
 *
 * Each benchmark user receives an isolated SQLite database. The bridge calls
 * NMG's public store methods; it does not duplicate graph or retrieval logic.
 */
export class OmniMemEvalBridge {
  readonly #root: string;
  readonly #stores = new Map<string, NmgStore>();
  readonly #embeddingClient?: OmniEmbeddingClient;
  readonly #embeddingBatchSize: number;

  constructor(root: string, options: OmniMemEvalBridgeOptions = {}) {
    this.#root = resolve(root);
    this.#embeddingClient = options.embeddingClient;
    this.#embeddingBatchSize = Math.max(
      1,
      Math.min(Math.trunc(options.embeddingBatchSize ?? 64), 2_048),
    );
    mkdirSync(this.#root, { recursive: true });
  }

  handle(request: OmniRequest): unknown | Promise<unknown> {
    switch (request.op) {
      case "add":
        return this.#add(request.userId, request.messages, request.conversationId);
      case "search":
        return this.#search(request.userId, request.query, request.topK);
      case "delete":
        this.deleteUser(request.userId);
        return { deleted: true };
      case "close":
        this.close();
        return { closed: true };
    }
  }

  close(): void {
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
  }

  deleteUser(userId: string): void {
    const key = userKey(userId);
    this.#stores.get(key)?.close();
    this.#stores.delete(key);
    const database = this.#databasePath(key);
    for (const suffix of ["", "-shm", "-wal"]) rmSync(`${database}${suffix}`, { force: true });
  }

  async #add(
    userId: string,
    messages: readonly OmniMessage[],
    conversationId?: string,
  ): Promise<{ added: number }> {
    if (!Array.isArray(messages)) throw new Error("messages must be an array");
    const store = this.#store(userId);
    const conversation = conversationId?.trim() || batchIdentity(messages);
    const sessionId = `${userKey(userId)}:${conversation}`;
    const nodeName = `Conversation ${conversation}`;
    const nodeSummary = messages
      .map((message) => `${message.role ?? "user"}: ${message.content}`)
      .join(" ")
      .slice(0, 1_500);
    let added = 0;

    messages.forEach((message, index) => {
      if (!message || typeof message.content !== "string" || !message.content.trim()) return;
      const role = historyRole(message.role);
      const sourceRef = `omnimemeval:${userKey(userId)}:${conversation}:${index}:` +
        createHash("sha256").update(`${role}\0${message.content}`).digest("hex").slice(0, 16);
      store.remember({
        statement: message.content,
        nodeName,
        nodeSummary,
        memoryType: "conversation_evidence",
        sourceActor: memoryActor(role),
        truthStatus: role === "user" ? "asserted" : "unverified",
        evidence: message.content,
        eventTime: message.chat_time,
        sessionId,
        sourceRef,
        tier: 2,
        importance: role === "user" ? 0.6 : 0.4,
        scope: { benchmark: "OmniMemEval", user: userKey(userId) },
      });
      added += 1;
    });

    if (this.#embeddingClient) {
      await syncRecordEmbeddings(
        store,
        this.#embeddingClient,
        this.#embeddingBatchSize,
      );
    }
    return { added };
  }

  async #search(userId: string, query: string, topK: number): Promise<{
    text: string;
    retrievalMode: "lexical" | "records";
    memories: Array<{
      memoryId: string;
      nodeId: string;
      statement: string;
      eventTime: string | null;
      score: number;
      sourceRef: string | null;
    }>;
  }> {
    if (!query.trim()) throw new Error("query must not be empty");
    const limit = Math.max(1, Math.min(Math.trunc(topK || 10), 50));
    const store = this.#store(userId);
    let semantic:
      | { queryVector: readonly number[]; model: string }
      | undefined;
    if (this.#embeddingClient) {
      await this.#syncSemanticIndex(store);
      const [queryVector] = await this.#embeddingClient.embedQueries([query]);
      if (!queryVector) throw new Error("embedding client returned no query vector");
      semantic = { queryVector, model: this.#embeddingClient.indexId };
    }
    const context = store.searchContext(query, {
      limit,
      maxTier: 3,
      graphHops: 1,
      vectorGranularity: semantic ? "records" : undefined,
      sourceActor: prefersAssistantEvidence(query) ? undefined : "user",
      activeGraphBudget: {
        maxEvidence: limit,
        maxTokens: Math.max(1_000, limit * 300),
      },
      // LongMemEval questions can require composing several turns from one
      // conversation. The generic store keeps a conservative two-record
      // per-node cap; this benchmark adapter explicitly opts into the larger
      // evidence budget while the default remains unchanged for Pi memory.
      maxResultsPerNode: limit,
    }, semantic);
    const memories = context.results.map((result) => ({
      memoryId: result.memory.id,
      nodeId: result.node.id,
      statement: result.memory.statement,
      eventTime: result.memory.eventTime,
      score: result.combinedScore,
      sourceRef: result.evidence.sourceRef,
    }));
    const includeTime = needsTemporalContext(query);
    // Contradiction annotations are NMG's own retrieval product: when a
    // retrieved memory contradicts another memory (claims metadata), the
    // note is rendered into the context regardless of the caller.
    const notes = store.contradictionNotes(memories.map((m) => m.memoryId));
    return {
      retrievalMode: semantic ? "records" : "lexical",
      text: memories
        .map((memory) => {
          const base =
            includeTime && memory.eventTime
              ? `[${memory.eventTime}] ${memory.statement}`
              : memory.statement;
          const note = notes.get(memory.memoryId);
          return note ? `${base}\n${note}` : base;
        })
        .join("\n"),
      memories,
    };
  }

  async #syncSemanticIndex(store: NmgStore): Promise<void> {
    const client = this.#embeddingClient;
    if (!client) return;
    const health = store.embeddingIndexHealth(client.indexId);
    if (
      health?.status === "ready" &&
      health.targets.includes("records") &&
      health.pending.records === 0
    ) {
      return;
    }
    await syncRecordEmbeddings(store, client, this.#embeddingBatchSize);
  }

  #store(userId: string): NmgStore {
    const key = userKey(userId);
    let store = this.#stores.get(key);
    if (!store) {
      store = new NmgStore(this.#databasePath(key));
      this.#stores.set(key, store);
    }
    return store;
  }

  #databasePath(key: string): string {
    return resolve(this.#root, `${key}.sqlite`);
  }
}

function prefersAssistantEvidence(query: string): boolean {
  return /\b(?:assistant|you said|previous chat)\b/iu.test(query);
}

function needsTemporalContext(query: string): boolean {
  return /\b(?:when|date|days?|weeks?|months?|years?|before|after|first|last|recent|recently|ago|long|yesterday|today|tomorrow|since|until|during|between|january|february|march|april|may|june|july|august|september|october|november|december)\b|(?:19|20)\d{2}/iu
    .test(query);
}

function userKey(userId: string): string {
  if (!userId?.trim()) throw new Error("userId must not be empty");
  return createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

function batchIdentity(messages: readonly OmniMessage[]): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash.update(message.role ?? "user").update("\0");
    hash.update(message.chat_time ?? "").update("\0");
    hash.update(message.content ?? "").update("\0");
  }
  return `batch-${hash.digest("hex").slice(0, 16)}`;
}

function historyRole(role?: string): HistoryRole {
  return role === "assistant" || role === "tool" || role === "system" ? role : "user";
}

function memoryActor(role: HistoryRole): MemoryActor {
  return role === "system" ? "agent" : role;
}

async function run(): Promise<void> {
  const root = process.env.NMG_OMNI_DATA_DIR?.trim() ||
    resolve(process.cwd(), ".nmg", "omnimemeval");
  const embeddingClient = process.env.NMG_EMBED_BASE_URL
    ? new OpenAIEmbeddingClient({
        baseUrl: process.env.NMG_EMBED_BASE_URL,
        apiKey: process.env.NMG_EMBED_API_KEY,
        model: process.env.NMG_EMBED_MODEL,
        profile: process.env.NMG_EMBED_PROFILE as "bge-en" | "plain" | "qwen3" | undefined,
        queryTemplate: process.env.NMG_EMBED_QUERY_TEMPLATE,
        documentTemplate: process.env.NMG_EMBED_DOCUMENT_TEMPLATE,
        dimensions: process.env.NMG_EMBED_DIMENSIONS
          ? Number(process.env.NMG_EMBED_DIMENSIONS)
          : undefined,
      })
    : undefined;
  const bridge = new OmniMemEvalBridge(root, {
    embeddingClient,
    embeddingBatchSize: process.env.NMG_EMBED_BATCH_SIZE
      ? Number(process.env.NMG_EMBED_BATCH_SIZE)
      : undefined,
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of input) {
    if (!line.trim()) continue;
    let response: OmniResponse;
    let requestId: string | number = "unknown";
    try {
      const request = JSON.parse(line) as OmniRequest;
      if (request.id === undefined) throw new Error("request id is required");
      requestId = request.id;
      response = { id: request.id, result: await bridge.handle(request) };
    } catch (error) {
      response = {
        id: requestId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  bridge.close();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
