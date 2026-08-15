import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { createJudgeClientFromEnv, type JudgeClient } from "./judge-provider.ts";
import { syncRecordEmbeddings } from "../../src/core/embedding-sync.ts";
import { NmgStore } from "../../src/core/store.ts";
import { loadPrompts, renderDisclosure } from "../../src/prompts/load.ts";
import type { HistoryRole, MemoryActor, MemoryMarker, PerfSnapshot, DuplicateCandidate } from "../../src/core/types.ts";
import { CachedOmniEmbeddingClient } from "./embedding-cache.ts";

const nmgPrompts = loadPrompts();
const PROJECTED_CONTROL_MARKERS = new Set(["forget"]);

type OmniRetrievedMemory = {
  memoryId: string;
  nodeId: string;
  statement: string;
  markers: MemoryMarker[];
  eventTime: string | null;
  score: number;
  sourceRef: string | null;
  /** Post-retrieval chain expansion: which chain this member belongs to, its
   *  position within the chain, and whether it is temporal or logical. The
   *  presentation layer renders these as numbered lines + a chain block so
   *  the model sees order (causal / chronological), not an isolated list. */
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
  /** Override the persistent content-addressed embedding cache location. */
  embeddingCachePath?: string;
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
  readonly #judge?: JudgeClient;

  constructor(root: string, options: OmniMemEvalBridgeOptions = {}) {
    this.#root = resolve(root);
    if (options.embeddingClient) {
      this.#embeddingCache = new CachedOmniEmbeddingClient(
        resolve(options.embeddingCachePath ?? resolve(this.#root, "embedding-cache.sqlite")),
        options.embeddingClient,
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
    this.#judge = createJudgeClientFromEnv();
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
    // Supersession judge tasks are collected during the (serial) write pass,
    // then the LLM calls run concurrently so the judge is not an ingestion
    // bottleneck; only the small applySupersession writes stay serial.
    const judgeTasks: Array<{
      statement: string;
      cands: DuplicateCandidate[];
      newMemoryId: string;
    }> = [];
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
        const remembered = store.remember({
          statement: forgetTarget,
          markers: [{ kind: "forget", attributes: { effect: "revoke" } }],
          nodeName: "Revoked memory boundary",
          nodeSummary: "User-requested memory revocation boundary.",
          memoryType: "constraint",
          sourceActor: "user",
          truthStatus: "asserted",
          evidenceHistoryId: history.id,
          // A revocation is critical when its subject is queried, but it is not
          // a global resident constraint. Keeping it in the searchable tier
          // prevents an unrelated revocation from crowding out exact evidence.
          tier: 2,
          importance: 1,
          scope: { benchmark: "OmniMemEval", user: userKey(userId) },
          writeReason: "explicit_user_forget_request",
          writeSource: "user",
        });
        if (remembered.memory) memories.push(remembered.memory.statement);
        added += 1;
        continue;
      }
      const remembered = store.remember({
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
      if (remembered.memory) memories.push(remembered.memory.statement);
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
          .filter((c) => !c.eventTime || !Number.isFinite(newTime) || Date.parse(c.eventTime) < newTime)
          .filter((c) => c.priority === "transition" || c.priority === "polarity")
          .slice(0, 3);
        if (cands.length) {
          judgeTasks.push({ statement: message.content, cands, newMemoryId: remembered.memory.id });
        }
      }
      added += 1;
    }
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
        progressiveWarmDisclosure: false,
        tieredDisclosure: true,
        initialEvidenceTarget: this.#qppInitialEvidenceTarget,
        qppThreshold: this.#qppThreshold,
        strongHitTopGap: this.#strongHitTopGap,
        strongHitInitialTarget: this.#strongHitInitialTarget,
        expandChains: true,
        activeGraphBudget: {
          maxNodes: limit,
          maxEvidence: limit,
          maxTokens: Math.max(1_000, limit * 300),
          maxTierBudget: limit,
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
      chainId: result.chainId,
      chainPosition: result.chainPosition,
      chainType: result.chainType,
      chainMemberships: result.chainMemberships,
    }));
    const includeTime = needsTemporalContext(query);
    // Contradiction annotations are NMG's own retrieval product: when a
    // retrieved memory contradicts another memory (claims metadata), the
    // note is rendered into the context regardless of the caller.
    const notes = store.contradictionNotes(memories.map((m) => m.memoryId));
    // A/B/C experiment switch (docs: presentation-layer render modes).
    // "numeric" is the default; env override lets the eval harness A/B/C the
    // same questions without rebuilding.
    const renderMode: MemoryRenderMode =
      process.env.NMG_RENDER_MODE === "id" || process.env.NMG_RENDER_MODE === "none"
        ? process.env.NMG_RENDER_MODE
        : "numeric";
    const chainEdges = new Map<string, Array<{ sourceMemoryId: string; targetMemoryId: string }>>();
    for (const e of context.chainEdges ?? []) {
      const list = chainEdges.get(e.chainId) ?? [];
      list.push({ sourceMemoryId: e.sourceMemoryId, targetMemoryId: e.targetMemoryId });
      chainEdges.set(e.chainId, list);
    }
    const projection = projectMemoryContext(memories, includeTime, notes, renderMode, chainEdges);
    appendFileSync(
      this.#perfLogPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        userId,
        topK: limit,
        retrievalMode: semantic ? "records" : "lexical",
        resultCount: memories.length,
        timings: context.timings,
      })}\n`,
      "utf8",
    );
    return {
      retrievalMode: semantic ? "records" : "lexical",
      timings: context.timings,
      text:
        projection.lines.length === 0
          ? ""
          : [
              renderDisclosure(nmgPrompts.search_disclosure, {
                count: String(projection.lines.length),
                // The OmniMemEval protocol has no nmg_get step; the next-step hint
                // is intentionally empty so the answer follows the data directly.
                next_step: "",
                forget_hint: projection.hasForget ? nmgPrompts.forget_hint : "",
              }),
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

export type MemoryRenderMode = "none" | "numeric" | "id";

const UUID_SEGMENT_ENDS = [8, 13, 18, 23, 36];

/** Shortest per-id prefix that is unique within the given id set. Extends by
 *  UUID segment (8-4-4-4-12) until no other id in the set shares the prefix,
 *  so rendered identifiers are short, stable and collision-free locally. */
function shortestUniquePrefixes(ids: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const id of ids) {
    let prefix = "";
    for (const end of UUID_SEGMENT_ENDS) {
      prefix = id.slice(0, end);
      if (!ids.some((other) => other !== id && other.startsWith(prefix))) break;
    }
    result.set(id, prefix);
  }
  return result;
}

/** Spreadsheet-style column label (A, B, …, Z, AA, AB, …) for a 0-based
 *  row index — the letter part of the `<A:short-id>` line tag. */
function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function projectMemoryContext(
  memories: readonly OmniRetrievedMemory[],
  includeTime: boolean,
  notes: ReadonlyMap<string, string>,
  renderMode: MemoryRenderMode = "numeric",
  chainEdges: ReadonlyMap<string, Array<{ sourceMemoryId: string; targetMemoryId: string }>> = new Map(),
): { lines: string[]; hasForget: boolean } {
  const idPrefixes =
    renderMode === "id" ? shortestUniquePrefixes(memories.map((m) => m.memoryId)) : new Map<string, string>();
  const projectedKinds = new Set<string>();
  const lines: string[] = [];
  const indexByMemory = new Map<string, number>();
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

    // Revoked records surface their metadata (id, time) but not their
    // statement: the model sees the revocation without content to cite.
    const forget = visibleKinds.includes("forget");
    const base =
      includeTime && memory.eventTime
        ? `[${memory.eventTime}] ${memory.statement}`
        : memory.statement;
    const rendered = forget
      ? `${nmgPrompts.forget_redacted} memory=${memory.memoryId}${memory.eventTime ? `; time=${memory.eventTime}` : ""}`
      : visibleKinds.length > 0
        ? `[${visibleKinds.join(",")}] ${base}`
        : base;
    const note = notes.get(memory.memoryId);
    // Render modes: "numeric" prefixes each line with 1., 2., … so the chain
    // block can reference members by index; "id" prefixes with [<short-uuid>
    // — a stable real memory identifier wrapped in <> so it cannot be mistaken
    // for content; "none" renders bare lines and drops the chain block.
    let numbered: string;
    if (renderMode === "none") {
      numbered = rendered;
    } else if (renderMode === "id") {
      const short = idPrefixes.get(memory.memoryId);
      numbered = short === undefined ? rendered : `<${columnLetter(lines.length)}:${short}> ${rendered}`;
    } else {
      numbered = `${lines.length + 1}. ${rendered}`;
    }
    indexByMemory.set(memory.memoryId, lines.length);
    lines.push(note ? `${numbered}\n${note}` : numbered);
  }
  // Independent chain block: members grouped per chain, ordered by their
  // chain position (causal order for logical chains, chronological for
  // temporal chains), referenced by line number. The chains stay separate
  // from the numbered lines so the memory list stays clean.
  const chains = new Map<
    string,
    { chainType: string; topic?: string; members: Array<{ id: string; position: number }> }
  >();
  for (const memory of memories) {
    // A memory can belong to several chains: render it in every chain block.
    const memberships =
      memory.chainMemberships ??
      (memory.chainId
        ? [{ chainId: memory.chainId, position: memory.chainPosition ?? 0, chainType: memory.chainType }]
        : []);
    for (const membership of memberships) {
      const chain = chains.get(membership.chainId) ?? {
        chainType: membership.chainType ?? "memory",
        topic: membership.topic,
        members: [],
      };
      if (!chain.topic && membership.topic) chain.topic = membership.topic;
      chain.members.push({ id: memory.memoryId, position: membership.position });
      chains.set(membership.chainId, chain);
    }
  }
  if (chains.size > 0 && renderMode !== "none") {
    lines.push("");
    for (const [chainId, chain] of chains) {
      chain.members.sort((a, b) => a.position - b.position);
      const label = chain.topic ? `${chain.chainType} chain: ${chain.topic}` : `${chain.chainType} chain`;
      if (renderMode === "id") {
        // Mermaid-flavoured chain block. Explicit DAG edges (memory_chain_edges)
        // render the chain as a branching flowchart (`A --> B & C`); a purely
        // linear temporal chain renders as a timeline (time : member). When a
        // chain has no explicit edges (legacy position-only membership) we fall
        // back to adjacency between adjacent positions.
        const edges = chainEdges.get(chainId);
        if (edges && edges.length > 0) {
          const adj = new Map<string, string[]>();
          const inDeg = new Map<string, number>();
          for (const e of edges) {
            const list = adj.get(e.sourceMemoryId) ?? [];
            list.push(e.targetMemoryId);
            adj.set(e.sourceMemoryId, list);
            inDeg.set(e.targetMemoryId, (inDeg.get(e.targetMemoryId) ?? 0) + 1);
          }
          const isLinear =
            [...adj.values()].every((ts) => ts.length <= 1) &&
            [...inDeg.values()].every((d) => d <= 1) &&
            edges.length === chain.members.length - 1;
          if (chain.chainType === "temporal" && isLinear) {
            // Walk the single path from the unique source for a chronological
            // timeline; append any disconnected members by insertion order.
            const posByMemory = new Map(chain.members.map((m) => [m.id, m.position]));
            let cur = [...adj.keys()].find((s) => !inDeg.has(s));
            const order: string[] = [];
            while (cur !== undefined && !order.includes(cur)) {
              order.push(cur);
              cur = adj.get(cur)?.[0];
            }
            const walked = new Set(order);
            for (const m of chain.members) if (!walked.has(m.id)) order.push(m.id);
            lines.push(`[${label}]`);
            lines.push("timeline");
            for (const id of order) {
              const p = idPrefixes.get(id);
              if (p === undefined) continue;
              const mem = memories.find((m) => m.memoryId === id);
              const time = mem?.eventTime ?? String((posByMemory.get(id) ?? 0) + 1);
              lines.push(`  ${time} : ${p}`);
            }
          } else {
            lines.push(`[${label}]`);
            lines.push("flowchart LR");
            for (const [s, ts] of adj) {
              const sp = idPrefixes.get(s);
              if (sp === undefined) continue;
              const targets = ts
                .map((t) => idPrefixes.get(t))
                .filter((x): x is string => x !== undefined);
              if (targets.length === 0) continue;
              lines.push(`  ${sp} --> ${targets.join(" & ")}`);
            }
          }
        } else {
          // Fallback: no explicit edges — use position order (legacy chains).
          if (chain.chainType === "temporal") {
            lines.push(`[${label}]`);
            lines.push("timeline");
            for (const member of chain.members) {
              const p = idPrefixes.get(member.id);
              if (p === undefined) continue;
              const mem = memories.find((m) => m.memoryId === member.id);
              const time = mem?.eventTime ?? String(member.position + 1);
              lines.push(`  ${time} : ${p}`);
            }
          } else {
            const fallback: string[] = [];
            for (let i = 0; i + 1 < chain.members.length; i += 1) {
              const a = idPrefixes.get(chain.members[i].id);
              const b = idPrefixes.get(chain.members[i + 1].id);
              if (a !== undefined && b !== undefined) fallback.push(`  ${a} --> ${b}`);
            }
            if (fallback.length > 0) {
              lines.push(`[${label}]`);
              lines.push("flowchart LR");
              lines.push(...fallback);
            }
          }
        }
      } else {
        const seq = chain.members
          .map((member) => indexByMemory.get(member.id))
          .filter((i): i is number => i !== undefined)
          .map((i) => `#${i + 1}`)
          .join(" → ");
        if (seq) lines.push(`[${label}] ${seq}`);
      }
    }
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

async function run(): Promise<void> {
  const root =
    process.env.NMG_OMNI_DATA_DIR?.trim() || resolve(process.cwd(), ".nmg", "omnimemeval");
  const embeddingClient = createEmbeddingClientFromEnv();
  const bridge = new OmniMemEvalBridge(root, {
    embeddingClient,
    embeddingBatchSize: process.env.NMG_EMBED_BATCH_SIZE
      ? Number(process.env.NMG_EMBED_BATCH_SIZE)
      : undefined,
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
