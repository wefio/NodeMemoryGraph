import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { syncRecordEmbeddings } from "../../src/core/embedding-sync.ts";
import { NmgStore } from "../../src/core/store.ts";
import type { HistoryRole, MemoryActor, MemoryMarker } from "../../src/core/types.ts";

const BASE_RETRIEVAL_GUIDANCE =
  "[NMG retrieval guidance] Treat relevant user facts, preferences, constraints, " +
  "tools, and prior experiences as evidence for a personalized answer. Apply them " +
  "to the current request even when the final answer did not appear verbatim in " +
  "history. Do not invent unsupported user details.";
const FORGET_RETRIEVAL_GUIDANCE = BASE_RETRIEVAL_GUIDANCE.replace(
  "history. Do not invent",
  "history. A line beginning with [forget] is a revocation boundary, not an active " +
    "fact: do not use or reconstruct that content, and prefer an answer independent " +
    "of it. Do not invent",
);
const PROJECTED_CONTROL_MARKERS = new Set(["forget"]);

type OmniRetrievedMemory = {
  memoryId: string;
  nodeId: string;
  statement: string;
  markers: MemoryMarker[];
  eventTime: string | null;
  score: number;
  sourceRef: string | null;
};

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
  /** Enable QPP-triggered pool re-selection for matched benchmark ablations. */
  secondPass?: boolean;
  /** First progressive evidence target; omitted to preserve the Top-1 experiment. */
  qppInitialEvidenceTarget?: number;
  /** Optional retrieval-confidence threshold for matched QPP ablations. */
  qppThreshold?: number;
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
  readonly #secondPass: boolean;
  readonly #qppInitialEvidenceTarget?: number;
  readonly #qppThreshold?: number;

  constructor(root: string, options: OmniMemEvalBridgeOptions = {}) {
    this.#root = resolve(root);
    this.#embeddingClient = options.embeddingClient;
    this.#embeddingBatchSize = Math.max(
      1,
      Math.min(Math.trunc(options.embeddingBatchSize ?? 64), 2_048),
    );
    this.#secondPass = options.secondPass ?? false;
    this.#qppInitialEvidenceTarget = positiveNumber(options.qppInitialEvidenceTarget);
    this.#qppThreshold = finiteNumber(options.qppThreshold);
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
    for (const [index, message] of messages.entries()) {
      if (!message || typeof message.content !== "string" || !message.content.trim()) continue;
      const role = historyRole(message.role);
      const sourceRef =
        `omnimemeval:${userKey(userId)}:${conversation}:${index}:` +
        createHash("sha256").update(`${role}\0${message.content}`).digest("hex").slice(0, 16);
      const history = store.appendHistory({
        content: message.content,
        role,
        sessionId,
        sourceMessageId: String(index),
        sourceRef,
      });
      const forgetTarget = role === "user" ? explicitForgetTarget(message.content) : null;
      if (forgetTarget) {
        forgetMatchingMemories(store, forgetTarget);
        store.remember({
          statement: forgetTarget,
          markers: [{ kind: "forget", attributes: { effect: "revoke" } }],
          nodeName: "Revoked memory boundary",
          nodeSummary: "User-requested memory revocation boundary.",
          memoryType: "constraint",
          sourceActor: "user",
          truthStatus: "asserted",
          evidenceHistoryId: history.id,
          tier: 0,
          importance: 1,
          scope: { benchmark: "OmniMemEval", user: userKey(userId) },
          writeReason: "explicit_user_forget_request",
          writeSource: "user",
        });
        added += 1;
        continue;
      }
      store.remember({
        statement: message.content,
        nodeName,
        nodeSummary,
        memoryType: "conversation_evidence",
        sourceActor: memoryActor(role),
        truthStatus: role === "user" ? "asserted" : "unverified",
        evidenceHistoryId: history.id,
        eventTime: message.chat_time,
        tier: 2,
        importance: role === "user" ? 0.6 : 0.4,
        scope: { benchmark: "OmniMemEval", user: userKey(userId) },
      });
      added += 1;
    }
    return { added };
  }

  async #search(
    userId: string,
    query: string,
    topK: number,
  ): Promise<{
    text: string;
    retrievalMode: "lexical" | "records";
    memories: OmniRetrievedMemory[];
  }> {
    if (!query.trim()) throw new Error("query must not be empty");
    const limit = Math.max(1, Math.min(Math.trunc(topK || 10), 50));
    const store = this.#store(userId);
    let semantic: { queryVector: readonly number[]; model: string } | undefined;
    if (this.#embeddingClient) {
      await this.#syncSemanticIndex(store);
      const [queryVector] = await this.#embeddingClient.embedQueries([query]);
      if (!queryVector) throw new Error("embedding client returned no query vector");
      semantic = { queryVector, model: this.#embeddingClient.indexId };
    }
    const context = store.searchContext(
      query,
      {
        limit,
        maxTier: 3,
        graphHops: 1,
        vectorGranularity: semantic ? "records" : undefined,
        sourceActor: prefersAssistantEvidence(query) ? undefined : "user",
        secondPass: this.#secondPass,
        initialEvidenceTarget: this.#qppInitialEvidenceTarget,
        qppThreshold: this.#qppThreshold,
        activeGraphBudget: {
          maxEvidence: limit,
          maxTokens: Math.max(1_000, limit * 300),
        },
      },
      semantic,
    );
    const memories = context.results.map((result) => ({
      memoryId: result.memory.id,
      nodeId: result.node.id,
      statement: result.memory.statement,
      markers: result.memory.markers,
      eventTime: result.memory.eventTime,
      score: result.combinedScore,
      sourceRef: result.evidence.sourceRef,
    }));
    const includeTime = needsTemporalContext(query);
    // Contradiction annotations are NMG's own retrieval product: when a
    // retrieved memory contradicts another memory (claims metadata), the
    // note is rendered into the context regardless of the caller.
    const notes = store.contradictionNotes(memories.map((m) => m.memoryId));
    const projection = projectMemoryContext(memories, includeTime, notes);
    return {
      retrievalMode: semantic ? "records" : "lexical",
      text:
        projection.lines.length === 0
          ? ""
          : [
              projection.hasForget ? FORGET_RETRIEVAL_GUIDANCE : BASE_RETRIEVAL_GUIDANCE,
              ...projection.lines,
            ].join("\n"),
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

function projectMemoryContext(
  memories: readonly OmniRetrievedMemory[],
  includeTime: boolean,
  notes: ReadonlyMap<string, string>,
): { lines: string[]; hasForget: boolean } {
  const projectedKinds = new Set<string>();
  const lines: string[] = [];
  for (const memory of memories) {
    const controlKinds = [
      ...new Set(
        memory.markers
          .map((marker) => marker.kind.trim().toLowerCase())
          .filter((kind) => PROJECTED_CONTROL_MARKERS.has(kind)),
      ),
    ];
    const visibleKinds = controlKinds.filter((kind) => !projectedKinds.has(kind));
    if (controlKinds.length > 0 && visibleKinds.length === 0) continue;
    visibleKinds.forEach((kind) => projectedKinds.add(kind));

    const base =
      includeTime && memory.eventTime
        ? `[${memory.eventTime}] ${memory.statement}`
        : memory.statement;
    const rendered = visibleKinds.length > 0 ? `[${visibleKinds.join(",")}] ${base}` : base;
    const note = notes.get(memory.memoryId);
    lines.push(note ? `${rendered}\n${note}` : rendered);
  }
  return { lines, hasForget: projectedKinds.has("forget") };
}

function prefersAssistantEvidence(query: string): boolean {
  return /\b(?:assistant|previous\s+(?:chat|conversation)|earlier\s+(?:you|we)|you\s+(?:said|suggested|recommended|provided|mentioned|told|wrote|created|made|gave|listed|outlined|explained)|we\s+(?:discussed|talked|decided)|(?:(?:can|could)\s+you|you\s+could)\s+remind\s+me|your\s+(?:answer|response|recommendation|list|example))\b/iu.test(
    query,
  );
}

function needsTemporalContext(query: string): boolean {
  return /\b(?:when|date|days?|weeks?|months?|years?|before|after|first|last|recent|recently|ago|long|yesterday|today|tomorrow|since|until|during|between|january|february|march|april|may|june|july|august|september|october|november|december)\b|(?:19|20)\d{2}/iu.test(
    query,
  );
}

function explicitForgetTarget(content: string): string | null {
  const match = content
    .trim()
    .match(
      /^(?:please\s+)?(?:i\s+(?:want|need|would\s+like)\s+you\s+to\s+)?(?:forget|erase|remove|delete)\s+(?:about\s+|that\s+)?(.+?)\s*[.!?]*$/iu,
    );
  const target = match?.[1]?.trim();
  return target && forgetTerms(target).size >= 2 ? target : null;
}

function forgetMatchingMemories(store: NmgStore, target: string): void {
  const targetTerms = forgetTerms(target);
  const candidates = store.searchContext(target, {
    sourceActor: "user",
    includeHistorical: false,
    maxTier: 3,
    limit: 50,
    graphHops: 0,
    retrievalMode: "fts5",
    persistTrace: false,
  }).results;
  for (const candidate of candidates) {
    if (candidate.memory.markers.some((marker) => marker.kind === "forget")) continue;
    const candidateTerms = forgetTerms(candidate.memory.statement);
    let shared = 0;
    for (const term of targetTerms) {
      if (candidateTerms.has(term)) shared += 1;
    }
    const targetCoverage = shared / targetTerms.size;
    const candidateCoverage = shared / Math.max(1, candidateTerms.size);
    if (shared >= 2 && (targetCoverage >= 0.5 || candidateCoverage >= 0.6)) {
      store.deleteMemory(candidate.memory.id);
    }
  }
}

function forgetTerms(text: string): Set<string> {
  const stop = new Set([
    "about",
    "after",
    "also",
    "and",
    "are",
    "been",
    "being",
    "but",
    "can",
    "did",
    "does",
    "for",
    "from",
    "had",
    "has",
    "have",
    "into",
    "that",
    "the",
    "their",
    "them",
    "they",
    "this",
    "was",
    "were",
    "with",
    "would",
    "your",
    "you",
    "feel",
    "felt",
  ]);
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (term) => term.length >= 3 && !stop.has(term),
    ),
  );
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

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function finiteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

async function run(): Promise<void> {
  const root =
    process.env.NMG_OMNI_DATA_DIR?.trim() || resolve(process.cwd(), ".nmg", "omnimemeval");
  const embeddingClient = createEmbeddingClientFromEnv();
  const bridge = new OmniMemEvalBridge(root, {
    embeddingClient,
    embeddingBatchSize: process.env.NMG_EMBED_BATCH_SIZE
      ? Number(process.env.NMG_EMBED_BATCH_SIZE)
      : undefined,
    secondPass: process.env.NMG_QPP_SECOND_PASS === "1",
    qppInitialEvidenceTarget: process.env.NMG_QPP_INITIAL_EVIDENCE_TARGET
      ? Number(process.env.NMG_QPP_INITIAL_EVIDENCE_TARGET)
      : undefined,
    qppThreshold: process.env.NMG_QPP_THRESHOLD ? Number(process.env.NMG_QPP_THRESHOLD) : undefined,
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
