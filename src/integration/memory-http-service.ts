import { createHash } from "node:crypto";
import type { MemoryEngine } from "../core/memory/engine.ts";
import type { MemoryInput } from "../core/memory/model.ts";
import type { EmbeddingClient } from "../core/embedding-provider.ts";
import type { MemorySearchResult } from "../core/types.ts";
import { projectAmlMemory, projectAmlMultimodalMemory } from "./aml-projection.ts";
import { normalizeContent } from "./multimodal-content.ts";
import { extractiveNodeSummary } from "./extractive-summaries.ts";
import type { HttpMemoryMessage } from "./memory-http-protocol.ts";

type ClauseContribution = {
  /** Position of the clause in the request's clause list. */
  index: number;
  /** Returned memories this clause surfaced (it may have surfaced more). */
  contributed: number;
  /** Returned memories that no other clause surfaced. */
  exclusive: number;
};

type FusedCandidate = { result: MemorySearchResult; sources: Set<number> };

function trackAppended(
  byId: Map<string, MemorySearchResult>,
  results: readonly MemorySearchResult[],
) {
  for (const result of results) {
    const prior = byId.get(result.memory.id);
    if (!prior || result.combinedScore > prior.combinedScore) byId.set(result.memory.id, result);
  }
}

/** Keep the highest-scoring occurrence of a memory, remembering every clause
 * that surfaced it. */
function trackCandidate(
  byId: Map<string, FusedCandidate>,
  index: number,
  result: MemorySearchResult,
): void {
  const prior = byId.get(result.memory.id);
  if (!prior) {
    byId.set(result.memory.id, { result, sources: new Set([index]) });
    return;
  }
  prior.sources.add(index);
  if (result.combinedScore > prior.result.combinedScore) prior.result = result;
}

/** Per-clause attribution over the returned page. */
function summariseClauses(
  selected: readonly FusedCandidate[],
  clauseCount: number,
): ClauseContribution[] {
  const clauses: ClauseContribution[] = Array.from({ length: clauseCount }, (_unused, index) => ({
    index,
    contributed: 0,
    exclusive: 0,
  }));
  for (const entry of selected) {
    for (const source of entry.sources) {
      const clause = clauses[source];
      if (clause) clause.contributed += 1;
    }
    if (entry.sources.size !== 1) continue;
    const [only] = [...entry.sources];
    const clause = only === undefined ? undefined : clauses[only];
    if (clause) clause.exclusive += 1;
  }
  return clauses;
}

function isTailContext(result: MemorySearchResult): boolean {
  return (
    result.neighborhood === "previous_turn" ||
    result.neighborhood === "next_turn" ||
    result.neighborhood === "due_today"
  );
}

function compareCandidates(a: FusedCandidate, b: FusedCandidate): number {
  return (
    b.result.combinedScore - a.result.combinedScore ||
    a.result.memory.id.localeCompare(b.result.memory.id)
  );
}

function selectTailCandidates(
  byId: ReadonlyMap<string, FusedCandidate>,
  adjacentById: ReadonlyMap<string, FusedCandidate>,
  limit: number,
): FusedCandidate[] {
  const candidates = [...adjacentById.values()].filter(
    (entry) => !byId.has(entry.result.memory.id),
  );
  const due = candidates
    .filter((entry) => entry.result.neighborhood === "due_today")
    .sort(compareCandidates)
    .slice(0, Math.min(2, limit));
  const dueIds = new Set(due.map((entry) => entry.result.memory.id));
  const neighbors = candidates
    .filter(
      (entry) => entry.result.neighborhood !== "due_today" && !dueIds.has(entry.result.memory.id),
    )
    .sort(compareCandidates)
    .slice(0, Math.min(2, limit));
  return [...due, ...neighbors].slice(0, Math.min(4, limit));
}

/** Place source-turn neighbors at the tail without letting project()'s ordinal
 * rank score (1 / (index + 1)) outrank real direct hits during clause fusion. */
function appendTailNeighbors(
  hits: readonly FusedCandidate[],
  neighbors: readonly FusedCandidate[],
): FusedCandidate[] {
  if (!neighbors.length) return [...hits];
  const floor = hits.at(-1)?.result.combinedScore;
  const capped = neighbors.map((entry, index) => {
    const combinedScore =
      floor === undefined
        ? entry.result.combinedScore
        : Math.min(entry.result.combinedScore, Math.max(0, floor - (index + 1) * 1e-6));
    return combinedScore === entry.result.combinedScore
      ? entry
      : { ...entry, result: { ...entry.result, combinedScore } };
  });
  return [...hits, ...capped];
}

// Fixed service profile, independent of agent sessions, online feedback and AG
// disclosure. These are the same store/search primitives used by NmgService.
export const HTTP_MEMORY_SEARCH_PROFILE = Object.freeze({
  maxTier: 3 as const,
  graphHops: 1,
  expandSourceContext: true,
  persistTrace: false,
});

export function projectHttpMemory(result: MemorySearchResult, query: string) {
  const markers = result.memory.markers ?? [];
  if (
    !markers.some((marker) => marker.kind === "aml_content") ||
    markers.some((marker) => marker.kind === "forget")
  ) {
    return projectAmlMemory(result.memory, query, result.combinedScore);
  }
  const parts = normalizeContent(JSON.parse(result.evidence.content));
  if (!Array.isArray(parts)) throw new Error("Stored structured evidence is not a parts array");
  return projectAmlMultimodalMemory(result.memory, query, result.combinedScore, parts);
}

export const DEFAULT_BACKFILL_LIMIT = 32;
const MAX_BACKFILL_LIMIT = 1024;

function resolveBackfillLimit(explicit?: number): number {
  const rawEnv =
    typeof process !== "undefined" ? process.env?.NMG_EMBED_BACKFILL_LIMIT?.trim() : undefined;
  const candidate = explicit !== undefined ? explicit : rawEnv ? Number(rawEnv) : undefined;
  if (candidate === undefined || !Number.isInteger(candidate) || candidate < 1) {
    return DEFAULT_BACKFILL_LIMIT;
  }
  return Math.min(MAX_BACKFILL_LIMIT, candidate);
}

/** HTTP evidence semantics over the caller's already-isolated memory engine. */
export class HttpMemoryService {
  private readonly engine: MemoryEngine;
  private readonly client?: EmbeddingClient;
  private readonly backfillLimit: number;
  private readonly options: {
    allowBackfill?: boolean;
    backfillLimit?: number;
    isDeferredEmbedding?: (error: unknown) => boolean;
  };

  constructor(
    engine: MemoryEngine,
    client?: EmbeddingClient,
    options: HttpMemoryService["options"] = {},
  ) {
    this.engine = engine;
    this.client = client;
    this.options = options;
    this.backfillLimit = resolveBackfillLimit(options.backfillLimit);
  }

  /** The last backfill failure, for /admin/status. Deliberately not thrown: see backfillVectors. */
  private lastBackfillError: string | null = null;

  /** Bounded vector backfill that never fails its caller: the worst case is a record that keeps
   *  scoring lexically until a later fold tries again. */
  private async backfillVectors(): Promise<void> {
    const vectorIndex = this.engine.backend.vectorIndex;
    if (!this.client || !vectorIndex) return;
    try {
      const docs = vectorIndex.pending(this.client.indexId, this.backfillLimit);
      if (docs.length) {
        const vectors = await this.client.embedDocuments(docs.map((document) => document.text));
        vectorIndex.save(this.client.indexId, docs, vectors);
      }
      this.lastBackfillError = null;
    } catch (error) {
      // EmbeddingPreparation is control flow, not a failure: `runPart` expects it to unwind the
      // SQLite session so the documents can be embedded outside it, then re-enters. Swallowing it
      // here looked like success and silently dropped the records - the write completed with a
      // snapshot that never contained them, and only the fold/searchability test noticed.
      if (this.options.isDeferredEmbedding?.(error)) throw error;
      this.lastBackfillError = String((error as { code?: string })?.code ?? error);
    }
  }

  get backfillStatus(): string | null {
    return this.lastBackfillError;
  }

  async rememberBatch(
    userId: string,
    sessionId: string,
    requestId: string,
    messages: readonly HttpMemoryMessage[],
    operationId?: string,
  ) {
    // Node-summary compensation without an LLM writer. The identity name below
    // stays the stable session key; entity terms land on the non-identity
    // summary face so later batches can never split the node.
    const sessionDate = messages.find((message) => message.chat_time)?.chat_time?.slice(0, 10);
    const nodeSummary = extractiveNodeSummary(
      messages.map(
        (message) =>
          message.indexText ?? (typeof message.content === "string" ? message.content : ""),
      ),
      sessionDate,
    );
    const inputs = messages.map((message): MemoryInput => {
      const sourceRef = `aml:${createHash("sha256")
        .update(JSON.stringify([userId, sessionId, requestId, message.source_message_id]))
        .digest("hex")}`;
      const structured = typeof message.content !== "string";
      const source = structured ? JSON.stringify(message.content) : message.content;
      const view = structured ? message.indexText : message.content;
      if (typeof source !== "string" || typeof view !== "string" || !view.trim()) {
        throw new Error("Structured source requires a prepared nonempty retrieval view");
      }
      // Preserve original parts in native history, never in the embedding text.
      // Per-image hashes inside the view keep different structured evidence from
      // collapsing into one plain-text memory; the content hash below stays in
      // marker attributes instead of polluting the retrieval statement.
      const statement = view;
      return {
        statement,
        nodeName: `AML session ${sessionId}`,
        nodeSummary,
        memoryType: "event",
        // Attribution follows the supplied message role. A derived retrieval
        // view changes indexing text, never who asserted the evidence.
        sourceActor: message.role,
        truthStatus: "asserted",
        importedEvidence: {
          role: message.role,
          sessionId,
          content: source,
          sourceMessageId: message.source_message_id,
          sourceRef,
        },
        eventTime: message.chat_time,
        scope: { aml_user: userId },
        tier: 2,
        residence: "ltg",
        sessionId: null,
        writeSource: "import",
        writeReason: "aml_history_import",
        sourceRef,
        markers: [
          { kind: "aml_session", attributes: { session_id: sessionId } },
          { kind: "aml_request_id", attributes: { value: requestId } },
          ...(structured
            ? [
                {
                  kind: "aml_content",
                  attributes: {
                    format: "ordered-parts-v1",
                    source_role: message.role,
                    source_sha: createHash("sha256").update(source).digest("hex"),
                  },
                },
              ]
            : []),
        ],
      };
    });
    // Same ordered, transactional primitive as daemon rememberBatch. The
    // outer manifest commit also makes multiple internal batches atomic.
    const batchId =
      operationId ??
      createHash("sha256")
        .update(
          JSON.stringify([
            userId,
            sessionId,
            requestId,
            messages.map((message) => message.source_message_id),
          ]),
        )
        .digest("hex");
    await this.engine.rememberMany(inputs, batchId);
    // Bounded like the search path: a fold must not embed a whole partition's backlog in one
    // request. Without the cap the cost and the duration of one fold are unbounded in the number
    // of vectorless records, so a single call can both burn the provider budget and run into the
    // invocation ceiling. Later folds continue where this one stopped.
    // A vector backfill is an optimisation, not part of the write's contract. Before this
    // guard a provider timeout threw out of here, out of the fold, and into `mutateUser`, which
    // re-ran the whole attempt (up to twelve times, each paying the timeout again): that is how
    // 2026-10-30 produced Adds at 15-55 s and seventeen kills at the 120 s ceiling. The records
    // are already stored; leaving them vectorless costs lexical scoring until a later fold
    // backfills them, which is strictly better than failing the write.
    if (this.client) await this.backfillVectors();
    return { added: messages.length };
  }

  async close() {
    await this.engine.backend.close();
  }

  async record(id: string) {
    return this.engine.record(id);
  }

  async searchFeature(text: string, limit: number, context: { now?: string } = {}) {
    const options = {
      ...HTTP_MEMORY_SEARCH_PROFILE,
      limit,
      ...(context.now ? { now: context.now, dueReminders: true } : {}),
    };
    const client = this.client;
    const vectorIndex = this.engine.backend.vectorIndex;
    if (!client || !vectorIndex?.has(client.indexId)) return this.engine.search(text, options);
    try {
      const [vector] = await client.embedQueries([text]);
      if (vector?.length && vectorIndex.has(client.indexId, vector.length))
        return this.engine.search(text, options, {
          indexId: client.indexId,
          vector,
          mode: "hybrid",
        });
    } catch (error) {
      if (this.options.isDeferredEmbedding?.(error)) throw error;
    }
    return this.engine.search(text, options);
  }

  /** Search the ranked clauses into one page and the append-only clauses into a
   * separate supplement. Append-only results never compete for the page slots:
   * they are returned as `appended`, deduplicated against the page, so a
   * retrieval dimension that is broad but imprecise cannot crowd out evidence.
   *
   * `features[i]` optionally lists several texts to search for clause `i` — the
   * whole clause (which is what the embedding model's own window sees) plus its
   * windows. Every feature is searched and results fuse by identity on the highest
   * score, so a clause scores a record by its *best* matching feature instead of a
   * pooled average; a long query keeps both its opening and a later passage. One
   * feature per clause is the previous behaviour, byte for byte. */
  async search(
    queries: string[],
    limit: number,
    appendOnly: readonly boolean[] = [],
    features?: readonly (readonly string[])[],
    context: { now?: string } = {},
  ) {
    if (this.options.allowBackfill !== false) await this.backfillVectors();
    // Track which clauses surfaced each memory, so a caller can see whether the
    // retrieval dimension it added actually contributed to the page.
    const byId = new Map<string, FusedCandidate>();
    const adjacentById = new Map<string, FusedCandidate>();
    const appendedById = new Map<string, MemorySearchResult>();
    let records = false;
    for (const [index, query] of queries.entries()) {
      // User isolation is the physical manifest/partition boundary, including
      // legacy rows whose pre-upgrade scope differs. No session filter.
      const texts = features?.[index]?.length ? features[index]! : [query];
      for (const text of texts) {
        const pageResult = await this.searchFeature(text, limit, context);
        records ||= pageResult.retrieval?.mode === "hybrid";
        if (appendOnly[index]) {
          trackAppended(appendedById, pageResult.results);
          continue;
        }
        // Attribution stays per clause: a chunk of clause i contributes to i.
        for (const result of pageResult.results) {
          trackCandidate(isTailContext(result) ? adjacentById : byId, index, result);
        }
      }
    }
    // Fuse clauses by identity, keep native scores, apply the AML hard cap.
    const ranked = [...byId.values()].sort(compareCandidates);
    const tail = selectTailCandidates(byId, adjacentById, limit);
    const hits = ranked.slice(0, limit - tail.length);
    const selected = appendTailNeighbors(hits, tail);
    const page = new Set(selected.map((entry) => entry.result.memory.id));
    const appended = [...appendedById.values()]
      .filter((result) => !page.has(result.memory.id))
      .sort((a, b) => b.combinedScore - a.combinedScore || a.memory.id.localeCompare(b.memory.id))
      .slice(0, limit);
    return {
      retrievalMode: records ? "records" : "lexical",
      memories: selected.map((entry) => projectHttpMemory(entry.result, queries[0] ?? "")),
      clauses: summariseClauses(selected, queries.length),
      appended: appended.map((result) => projectHttpMemory(result, queries[0] ?? "")),
    };
  }
}
