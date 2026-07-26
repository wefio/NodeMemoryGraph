import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

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

/**
 * Runtime-neutral bridge used by OmniMemEval's Python client.
 *
 * Each benchmark user receives an isolated SQLite database. The bridge calls
 * NMG's public store methods; it does not duplicate graph or retrieval logic.
 */
export class OmniMemEvalBridge {
  readonly #root: string;
  readonly #stores = new Map<string, NmgStore>();

  constructor(root: string) {
    this.#root = resolve(root);
    mkdirSync(this.#root, { recursive: true });
  }

  handle(request: OmniRequest): unknown {
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

  #add(userId: string, messages: readonly OmniMessage[], conversationId?: string): {
    added: number;
  } {
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

    return { added };
  }

  #search(userId: string, query: string, topK: number): {
    text: string;
    memories: Array<{
      memoryId: string;
      nodeId: string;
      statement: string;
      score: number;
      sourceRef: string | null;
    }>;
  } {
    if (!query.trim()) throw new Error("query must not be empty");
    const limit = Math.max(1, Math.min(Math.trunc(topK || 10), 50));
    const context = this.#store(userId).searchContext(query, {
      limit,
      maxTier: 3,
      graphHops: 1,
      activeGraphBudget: {
        maxEvidence: limit,
        maxTokens: Math.max(1_000, limit * 300),
      },
    });
    const memories = context.results.map((result) => ({
      memoryId: result.memory.id,
      nodeId: result.node.id,
      statement: result.memory.statement,
      score: result.combinedScore,
      sourceRef: result.evidence.sourceRef,
    }));
    return {
      text: memories.map((memory) => memory.statement).join("\n"),
      memories,
    };
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
  const bridge = new OmniMemEvalBridge(root);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of input) {
    if (!line.trim()) continue;
    let response: OmniResponse;
    let requestId: string | number = "unknown";
    try {
      const request = JSON.parse(line) as OmniRequest;
      if (request.id === undefined) throw new Error("request id is required");
      requestId = request.id;
      response = { id: request.id, result: bridge.handle(request) };
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
