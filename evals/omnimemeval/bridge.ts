import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { createJudgeClientFromEnv, type JudgeClient } from "./judge-provider.ts";
import {
  syncLeafEmbeddings,
  syncNodeEmbeddings,
  syncRecordEmbeddings,
} from "../../src/core/embedding-sync.ts";
import { NmgStore } from "../../src/core/store.ts";
import { renderEvidenceSurface } from "../../src/integration/agent-surface.ts";
import { searchMemoryContext } from "../../src/integration/search.ts";
import { loadPrompts, renderDisclosure } from "../../src/prompts/load.ts";
import type {
  HistoryRole,
  MemoryActor,
  MemoryMarker,
  PerfSnapshot,
  DuplicateCandidate,
  RememberInput,
  RememberResult,
} from "../../src/core/types.ts";
import { CachedOmniEmbeddingClient } from "./embedding-cache.ts";

const nmgPrompts = loadPrompts();

/** Shared embedding cache for all evals. Embeddings are content-hashed
 *  (index_id, input_kind, text_hash), so the same text under the same model
 *  yields the same key in every eval — one cache serves them all and avoids a
 *  new ~1GB duplicate per eval variant (measured 27% redundancy across caches
 *  before merging; see evals/omnimemeval/merge-embedding-caches.mjs and
 *  docs). Override per-eval with `embeddingCachePath` ONLY when true isolation
 *  is required; otherwise reuse the shared cache. */
const SHARED_EMBED_CACHE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".benchmarks",
  "shared-embedding-cache.sqlite",
);

export type OmniRetrievedMemory = {
  memoryId: string;
  nodeId: string;
  statement: string;
  markers: MemoryMarker[];
  eventTime: string | null;
  score: number;
  /** True only for the Active Graph's ranked evidence prefix. Chain/block
   *  recall supplements are false even when they appear before top_k. */
  ranked?: boolean;
  sourceRef: string | null;
  /** Post-retrieval chain expansion: which chain this member belongs to, its
   *  position within the chain, and whether it is temporal or logical. The
   *  shared Agent Surface projects this metadata into bounded structure. */
  chainId?: string;
  chainPosition?: number;
  chainType?: string;
  /** Full chain memberships (a memory can belong to several chains). */
  chainMemberships?: Array<{
    chainId: string;
    position: number;
    chainType?: string;
    topic?: string;
  }>;
  /** Bounded verbatim excerpt of the backing evidence record, so retrieval
   *  audits can match gold evidence against the exact source text rather than
   *  the rendered statement alone. */
  evidenceExcerpt?: string;
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
  /** Override the strong-hit margin (relative top1→top2 gap); 1 disables it. */
  strongHitTopGap?: number;
  /** Override the strong-hit first-pass target. */
  strongHitInitialTarget?: number;
  /** Persist core retrieval timings independently of disposable user databases. */
  perfLogPath?: string;
  /** Leaf-block summary routing (SearchOptions.leafBlockRouting): queries are
   *  matched against block semantic summaries and hit blocks pull their
   *  verbatim members into the context. Requires summaries to have been
   *  written via drainLeafSummaries; a no-op otherwise. */
  leafBlockRouting?: boolean;
  /** Override the persistent content-addressed embedding cache location. */
  embeddingCachePath?: string;
  /** Require every embedding to exist in the shared cache. Provider I/O is
   * disabled and any miss fails closed with an explicit cache error. */
  embeddingCacheOnly?: boolean;
  /** Eval-only benchmark construction: after ingest, link same-session
   *  conversation memories into chains. "temporal" orders by eventTime,
   *  "logical" by message order, "both" creates both chains, "none"
   *  (default) leaves BEAM chain-free. Synthetic, explicit benchmark
   *  construction — not runtime auto-inference. */
  chainInjection?: "temporal" | "logical" | "both" | "none";
  /** Shared character budget for all appended (non-ranked) context sections:
   *  chain expansion and block-routed members. Over-budget members are
   *  skipped, never truncated. Omitted uses the core's finite default; the
   *  benchmark also records the resolved value so runs remain comparable. */
  appendedMaxChars?: number;
  chainExpansionMaxChains?: number;
  chainExpansionMaxHops?: number;
  chainExpansionMaxMemoryHops?: number;
  appendedMaxRatio?: number;
  /** Rebuildable per-scope write index. Enabled by default after the local
   * ingestion ablation showed lower CPU and RSS with identical persisted output. */
  scopeWriteIndex?: boolean;
  /** Ordered remember transaction size. Set to 1 to retain per-message commits. */
  writeBatchSize?: number;
}

/**
 * Runtime-neutral bridge used by OmniMemEval's Python client.
 *
 * Each benchmark user receives an isolated SQLite database. The bridge calls
 * NMG's public store methods; it does not duplicate graph or retrieval logic.
 */
const MAX_OPEN_STORES = 128;

export class OmniMemEvalBridge {
  readonly #root: string;
  readonly #stores = new Map<string, NmgStore>();
  readonly #embeddingClient?: OmniEmbeddingClient;
  readonly #embeddingCache?: CachedOmniEmbeddingClient;
  readonly #embeddingBatchSize: number;
  readonly #secondPass: boolean;
  readonly #qppInitialEvidenceTarget?: number;
  readonly #qppThreshold?: number;
  readonly #strongHitTopGap?: number;
  readonly #strongHitInitialTarget?: number;
  readonly #perfLogPath: string;
  readonly #leafBlockRouting: boolean;
  readonly #judge?: JudgeClient;
  readonly #chainInjection: "temporal" | "logical" | "both" | "none";
  readonly #appendedMaxChars?: number;
  readonly #chainExpansionMaxChains?: number;
  readonly #chainExpansionMaxHops?: number;
  readonly #chainExpansionMaxMemoryHops?: number;
  readonly #appendedMaxRatio?: number;
  readonly #scopeWriteIndex: boolean;
  readonly #writeBatchSize: number;

  constructor(root: string, options: OmniMemEvalBridgeOptions = {}) {
    this.#root = resolve(root);
    if (options.embeddingClient) {
      this.#embeddingCache = new CachedOmniEmbeddingClient(
        resolve(options.embeddingCachePath ?? SHARED_EMBED_CACHE),
        options.embeddingClient,
        { cacheOnly: options.embeddingCacheOnly },
      );
      this.#embeddingClient = this.#embeddingCache;
    }
    this.#embeddingBatchSize = Math.max(
      1,
      Math.min(Math.trunc(options.embeddingBatchSize ?? 64), 2_048),
    );
    this.#secondPass = options.secondPass ?? true;
    this.#qppInitialEvidenceTarget = positiveNumber(options.qppInitialEvidenceTarget);
    this.#qppThreshold = finiteNumber(options.qppThreshold);
    this.#strongHitTopGap = finiteNumber(options.strongHitTopGap);
    this.#strongHitInitialTarget = positiveNumber(options.strongHitInitialTarget);
    this.#perfLogPath = resolve(options.perfLogPath ?? resolve(this.#root, "search-perf.jsonl"));
    this.#leafBlockRouting = options.leafBlockRouting ?? false;
    this.#judge = createJudgeClientFromEnv();
    this.#chainInjection = options.chainInjection ?? "none";
    this.#appendedMaxChars = positiveNumber(options.appendedMaxChars);
    this.#chainExpansionMaxChains = positiveNumber(options.chainExpansionMaxChains);
    this.#chainExpansionMaxHops = finiteNumber(options.chainExpansionMaxHops);
    this.#chainExpansionMaxMemoryHops = finiteNumber(options.chainExpansionMaxMemoryHops);
    this.#appendedMaxRatio = finiteNumber(options.appendedMaxRatio);
    this.#scopeWriteIndex = options.scopeWriteIndex ?? true;
    this.#writeBatchSize = Math.max(1, Math.min(Math.trunc(options.writeBatchSize ?? 32), 512));
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
    this.#embeddingCache?.close();
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
  ): Promise<{ added: number; memories: string[] }> {
    if (!Array.isArray(messages)) throw new Error("messages must be an array");
    const store = this.#store(userId);
    const conversation = conversationId?.trim() || batchIdentity(messages);
    const sessionId = `${userKey(userId)}:${conversation}`;
    const nodeName = `Conversation ${batchIdentity(messages)}`;
    const nodeSummary = messages
      .map((message) => `${message.role ?? "user"}: ${message.content}`)
      .join(" ")
      .slice(0, 1_500);
    let added = 0;
    const memories: string[] = [];
    // Conversation-evidence memories of this add, kept in message order so the
    // eval-only chain injection (below) can link them into chains.
    const dialogMemories: Array<{ memoryId: string; eventTime?: string; order: number }> = [];
    // Supersession judge tasks are collected during the (serial) write pass,
    // then the LLM calls run concurrently so the judge is not an ingestion
    // bottleneck; only the small applySupersession writes stay serial.
    const judgeTasks: Array<{
      statement: string;
      cands: DuplicateCandidate[];
      newMemoryId: string;
    }> = [];
    type PendingWrite = { index: number; message: OmniMessage; input: RememberInput };
    let pending: PendingWrite[] = [];
    const acceptRemembered = (entry: PendingWrite, remembered: RememberResult): void => {
      const { index, message } = entry;
      if (remembered.memory) {
        memories.push(remembered.memory.statement);
        dialogMemories.push({
          memoryId: remembered.memory.id,
          eventTime: message.chat_time,
          order: index,
        });
      }
      // Simulate the NMG plugin's write path: when the new statement shares
      // tokens with same-scope memories, ask the external LLM judge whether
      // any candidate is a stale predecessor; if so mark it superseded so
      // retrieval surfaces the current value instead of the stale one. The
      // judge call itself is deferred to the parallel pass after the loop.
      if (this.#judge && remembered.supersedeCandidates?.length && remembered.memory) {
        const newTime = message.chat_time ? Date.parse(message.chat_time) : Number.NaN;
        // A candidate can only be the stale predecessor of a newer value, so
        // drop candidates that are not strictly older than this statement.
        // Keep the core store's ordering (transition-name hits first, then
        // similarity) — re-sorting by similarity here would push a real
        // predecessor (low lexical overlap) back out of the top-k.
        // Throttle the LLM judge (ingest cost): only deterministic strong
        // signals (transition-name hit / polarity flip) are worth a judge call;
        // plain token-overlap candidates are usually "keep" and would only slow
        // ingestion. Weak candidates are skipped entirely — the strong signals
        // are exactly the supersession scenarios ("from X to Y", negated update)
        // that need the LLM to confirm the stale predecessor.
        const cands = remembered.supersedeCandidates
          .filter(
            (c) => !c.eventTime || !Number.isFinite(newTime) || Date.parse(c.eventTime) < newTime,
          )
          .filter((c) => c.priority === "transition" || c.priority === "polarity")
          .slice(0, 3);
        if (cands.length) {
          judgeTasks.push({ statement: message.content, cands, newMemoryId: remembered.memory.id });
        }
      }
      added += 1;
    };
    const flushPending = (): void => {
      if (pending.length === 0) return;
      const results =
        this.#writeBatchSize > 1
          ? store.rememberMany(pending.map((entry) => entry.input))
          : pending.map((entry) => store.remember(entry.input));
      for (let index = 0; index < pending.length; index += 1) {
        acceptRemembered(pending[index]!, results[index]!);
      }
      pending = [];
    };

    for (const [index, message] of messages.entries()) {
      if (!message || typeof message.content !== "string" || !message.content.trim()) continue;
      const role = historyRole(message.role);
      const actor = memoryActor(role);
      const sourceRef =
        `omnimemeval:${userKey(userId)}:${conversation}:${index}:` +
        createHash("sha256").update(`${role}\0${message.content}`).digest("hex").slice(0, 16);
      const forgetTarget = role === "user" ? explicitForgetTarget(message.content) : null;
      if (forgetTarget) {
        flushPending();
        const history = store.appendHistory({
          content: message.content,
          role,
          sessionId,
          sourceMessageId: String(index),
          sourceRef,
        });
        forgetMatchingMemories(store, forgetTarget);
        const remembered = store.remember({
          statement: forgetTarget,
          markers: [{ kind: "forget", attributes: { effect: "revoke" } }],
          nodeName: "Revoked memory boundary",
          nodeSummary: "User-requested memory revocation boundary.",
          memoryType: "constraint",
          sourceActor: "user",
          truthStatus: "asserted",
          evidenceHistoryId: history.id,
          tier: 2,
          importance: 1,
          scope: { benchmark: "OmniMemEval", user: userKey(userId) },
          writeReason: "explicit_user_forget_request",
          writeSource: "user",
          supersedeScan: this.#judge !== undefined,
        });
        if (remembered.memory) memories.push(remembered.memory.statement);
        added += 1;
        continue;
      }
      const history = store.appendHistory({
        content: message.content,
        role,
        sessionId,
        sourceMessageId: String(index),
        sourceRef,
      });
      pending.push({
        index,
        message,
        input: {
          statement: message.content,
          nodeName,
          nodeSummary,
          memoryType: "conversation_evidence",
          sourceActor: actor,
          truthStatus: role === "user" ? "asserted" : "unverified",
          evidenceHistoryId: history.id,
          eventTime: message.chat_time,
          tier: 2,
          importance: role === "user" ? 0.6 : 0.4,
          scope: { benchmark: "OmniMemEval", user: userKey(userId) },
          supersedeScan: this.#judge !== undefined,
        },
      });
      if (pending.length >= this.#writeBatchSize) flushPending();
    }
    flushPending();
    // Parallel judge pass (bounded concurrency), then serial supersession.
    if (this.#judge && judgeTasks.length) {
      const CONCURRENCY = 8;
      for (let i = 0; i < judgeTasks.length; i += CONCURRENCY) {
        const batch = judgeTasks.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((task) =>
            this.#judge!.judge({
              statement: task.statement,
              candidates: [],
              supersedeCandidates: task.cands,
            }),
          ),
        );
        for (let j = 0; j < batch.length; j++) {
          const judgement = results[j];
          if (judgement.supersede && judgement.supersededMemoryId) {
            try {
              store.applySupersession({
                newMemoryId: batch[j].newMemoryId,
                supersededMemoryId: judgement.supersededMemoryId,
              });
            } catch {
              // A bad supersession target must not break ingestion.
            }
          }
        }
      }
    }
    // Chain-injection lock: logical only. BEAM 4-way A/B (2026-08-16): logical
    // 0.6867 is the best; temporal 0.6755; both 0.5624 collapses from context
    // bloat. The temporal/both branches are commented out as experiment record.
    if (this.#chainInjection === "logical" && dialogMemories.length > 0) {
      const topic = `Conversation ${batchIdentity(messages)}`;
      // if (this.#chainInjection === "temporal" || this.#chainInjection === "both") {
      //   const sorted = [...dialogMemories].sort((a, b) => {
      //     const ta = a.eventTime ? Date.parse(a.eventTime) : Number.NaN;
      //     const tb = b.eventTime ? Date.parse(b.eventTime) : Number.NaN;
      //     const fa = Number.isFinite(ta);
      //     const fb = Number.isFinite(tb);
      //     if (fa && fb) return ta - tb;
      //     if (fa) return -1;
      //     if (fb) return 1;
      //     return a.order - b.order;
      //   });
      //   const chain = store.createMemoryChain({ chainType: "temporal", topic, ownerSessionId: sessionId });
      //   sorted.forEach((m, i) => store.addMemoryToChain({ chainId: chain.id, memoryId: m.memoryId, position: i }));
      // }
      const chain = store.createMemoryChain({
        chainType: "logical",
        topic,
        ownerSessionId: sessionId,
      });
      [...dialogMemories]
        .sort((a, b) => a.order - b.order)
        .forEach((m, i) =>
          store.addMemoryToChain({ chainId: chain.id, memoryId: m.memoryId, position: i }),
        );
    }
    return { added, memories };
  }

  async #search(
    userId: string,
    query: string,
    topK: number,
  ): Promise<{
    text: string;
    retrievalMode: "lexical" | "records";
    memories: OmniRetrievedMemory[];
    timings?: PerfSnapshot;
  }> {
    if (!query.trim()) throw new Error("query must not be empty");
    // OmniMemEval calls this top_k. NMG treats it as the normal evidence budget;
    // QPP grows a dynamic Fibonacci window and may enter the bounded expansion
    // envelope when the normal budget is insufficient.
    const limit = Math.max(1, Math.min(Math.trunc(topK || 10), 50));
    const store = this.#store(userId);
    if (this.#embeddingClient) {
      await this.#syncSemanticIndex(store);
    }
    const context = await searchMemoryContext(
      store,
      this.#embeddingClient,
      query,
      {
        limit,
        maxTier: 3,
        graphHops: 1,
        vectorGranularity: this.#embeddingClient ? "records" : undefined,
        secondPass: this.#secondPass,
        progressiveWarmDisclosure: false,
        tieredDisclosure: true,
        initialEvidenceTarget: this.#qppInitialEvidenceTarget,
        qppThreshold: this.#qppThreshold,
        strongHitTopGap: this.#strongHitTopGap,
        strongHitInitialTarget: this.#strongHitInitialTarget,
        expandChains: true,
        leafBlockRouting: this.#leafBlockRouting,
        appendedMaxChars: this.#appendedMaxChars,
        chainExpansionMaxChains: this.#chainExpansionMaxChains,
        chainExpansionMaxHops: this.#chainExpansionMaxHops,
        chainExpansionMaxMemoryHops: this.#chainExpansionMaxMemoryHops,
        appendedMaxRatio: this.#appendedMaxRatio,
        activeGraphBudget: {
          maxNodes: limit,
          maxEvidence: limit,
          maxTokens: Math.max(1_000, limit * 300),
          maxTierBudget: limit,
        },
      },
    );
    const rankedMemoryIds = new Set(context.activeGraph.memoryIds);
    const memories = context.results.map((result) => ({
      memoryId: result.memory.id,
      nodeId: result.node.id,
      statement: result.memory.statement,
      markers: result.memory.markers,
      eventTime: result.memory.eventTime,
      score: result.combinedScore,
      ranked: rankedMemoryIds.has(result.memory.id),
      sourceRef: result.evidence.sourceRef,
      chainId: result.chainId,
      chainPosition: result.chainPosition,
      chainType: result.chainType,
      chainMemberships: result.chainMemberships,
      evidenceExcerpt: result.evidence.content.slice(0, 500),
    }));
    const hasForget = context.results.some(({ memory }) =>
      memory.markers.some((marker) => marker.kind === "forget"),
    );
    appendFileSync(
      this.#perfLogPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        userId,
        topK: limit,
        retrievalMode: context.retrieval?.mode === "hybrid" ? "records" : "lexical",
        resultCount: memories.length,
        timings: context.timings,
      })}\n`,
      "utf8",
    );
    return {
      retrievalMode: context.retrieval?.mode === "hybrid" ? "records" : "lexical",
      timings: context.timings,
      text:
        context.results.length === 0
          ? ""
          : renderEvidenceSurface(context, {
              preamble: renderDisclosure(nmgPrompts.get_disclosure, {}),
              postamble: renderDisclosure(nmgPrompts.get_disclosure_metadata, {
                count: String(context.results.length),
                // OmniMemEval has no separate nmg_get round; the bridge therefore
                // exposes the same exact-evidence surface in this response.
                next_step: "",
                forget_hint: hasForget ? nmgPrompts.forget_hint : "",
              }),
            }),
      memories,
    };
  }

  async #syncSemanticIndex(store: NmgStore): Promise<void> {
    const client = this.#embeddingClient;
    if (!client) return;
    const health = store.embeddingIndexHealth(client.indexId);
    const recordsDone =
      health?.status === "ready" &&
      health.targets.includes("records") &&
      health.pending.records === 0;
    // Leaf embeddings only matter when block-summary routing is on; their
    // staleness includes semantic-summary writes (setLeafSummary bumps the
    // block's updated_at), so summarized blocks are re-embedded once here.
    const leavesDone =
      !this.#leafBlockRouting ||
      (health?.status === "ready" &&
        health.targets.includes("leaves") &&
        health.pending.leaves === 0);
    const nodesDone =
      !this.#leafBlockRouting ||
      (health?.status === "ready" &&
        health.targets.includes("nodes") &&
        health.pending.nodes === 0);
    if (!recordsDone) await syncRecordEmbeddings(store, client, this.#embeddingBatchSize);
    if (!leavesDone) await syncLeafEmbeddings(store, client, this.#embeddingBatchSize);
    if (!nodesDone) await syncNodeEmbeddings(store, client, this.#embeddingBatchSize);
  }

  #store(userId: string): NmgStore {
    const key = userKey(userId);
    let store = this.#stores.get(key);
    if (!store) {
      store = new NmgStore(this.#databasePath(key), undefined, {
        scopeWriteIndex: this.#scopeWriteIndex,
      });
      this.#stores.set(key, store);
      // Keep the open-store cache bounded: every open NmgStore pins a SQLite
      // connection (plus its WAL readers), and long benchmarks can otherwise
      // exhaust process handles long before the map is ever evicted. Close the
      // least-recently-used store once the cache exceeds a fixed cap.
      if (this.#stores.size > MAX_OPEN_STORES) {
        const oldestKey = this.#stores.keys().next().value as string | undefined;
        if (oldestKey !== undefined && oldestKey !== key) {
          this.#stores.get(oldestKey)?.close();
          this.#stores.delete(oldestKey);
        }
      }
    }
    return store;
  }

  #databasePath(key: string): string {
    return resolve(this.#root, `${key}.sqlite`);
  }
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
  // "agent"/"explicit"/"session" are harness-internal roles with no memory
  // actor equivalent; attribute them to the system rather than inventing an
  // author category that MemoryActor does not model.
  return role === "system" || role === "explicit" || role === "session" ? "system" : role;
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function finiteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function environmentFlag(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
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
    embeddingCacheOnly: environmentFlag(process.env.NMG_EMBED_CACHE_ONLY),
    secondPass: process.env.NMG_QPP_SECOND_PASS !== "0",
    qppInitialEvidenceTarget: process.env.NMG_QPP_INITIAL_EVIDENCE_TARGET
      ? Number(process.env.NMG_QPP_INITIAL_EVIDENCE_TARGET)
      : undefined,
    qppThreshold: process.env.NMG_QPP_THRESHOLD ? Number(process.env.NMG_QPP_THRESHOLD) : undefined,
    strongHitTopGap: process.env.NMG_QPP_STRONG_HIT_TOP_GAP
      ? Number(process.env.NMG_QPP_STRONG_HIT_TOP_GAP)
      : undefined,
    strongHitInitialTarget: process.env.NMG_QPP_STRONG_HIT_INITIAL_TARGET
      ? Number(process.env.NMG_QPP_STRONG_HIT_INITIAL_TARGET)
      : undefined,
    chainInjection: process.env.NMG_CHAIN_INJECTION === "logical" ? "logical" : "none",
    appendedMaxChars: Number(process.env.NMG_APPENDED_MAX_CHARS ?? 16_000),
    scopeWriteIndex: process.env.NMG_SCOPE_WRITE_INDEX !== "0",
    writeBatchSize: Number(process.env.NMG_WRITE_BATCH_SIZE ?? 32),
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
