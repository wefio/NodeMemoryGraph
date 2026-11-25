import { createHash } from "node:crypto";
import type { ComputeGraphSpec } from "../core/compute-graph.ts";
import { getSharedRuntimeScheduler } from "../core/runtime/scheduler.ts";
import type { MemoryEngine } from "../core/memory/engine.ts";
import type { MemoryInput } from "../core/memory/model.ts";
import { sortResultsChronologically } from "../core/memory/page-stitch-operators.ts";
import type { EmbeddingClient } from "../core/embedding-provider.ts";
import type { MemoryContext, MemorySearchResult } from "../core/types.ts";
import { projectAmlMemory, projectAmlMultimodalMemory } from "./aml-projection.ts";
import { fitExplicitSearchPage, type ExplicitSearchPageBudget } from "./explicit-search-page.ts";
import { renderHttpProfileSupplement } from "./http-profile-view.ts";
import { executeHttpSearchGraph, type HttpClauseHitBatch } from "./http-search-graph.ts";
import { preprocessHttpMessage } from "./http-write-preprocess.ts";
import { normalizeContent } from "./multimodal-content.ts";
import type { HttpMemoryMessage } from "./memory-http-protocol.ts";

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
    searchGraph?: ComputeGraphSpec;
    rerankGraph?: ComputeGraphSpec | false;
    configIdentity?: string;
    writePreprocessGraph?: ComputeGraphSpec;
    profileGraph?: ComputeGraphSpec;
    preprocessMessages?: boolean;
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
      await getSharedRuntimeScheduler().runTask(
        async () => {
          const docs = vectorIndex.pending(this.client!.indexId, this.backfillLimit);
          if (docs.length) {
            const vectors = await this.client!.embedDocuments(
              docs.map((document) => document.text),
            );
            vectorIndex.save(this.client!.indexId, docs, vectors);
          }
        },
        { priority: "background", effect: "read", label: "http_vector_backfill" },
      );
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
      const preprocessed = this.options.preprocessMessages
        ? preprocessHttpMessage(message.role, statement, this.options.writePreprocessGraph)
        : undefined;
      return {
        statement,
        memoryType: preprocessed?.memoryType ?? "event",
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
        supersedeScan: false,
        writeSource: "import",
        writeReason: "aml_history_import",
        sourceRef,
        ...(preprocessed?.recallTriggers.length
          ? { recallTriggers: [...preprocessed.recallTriggers] }
          : {}),
        markers: [
          { kind: "aml_session", attributes: { session_id: sessionId } },
          { kind: "aml_request_id", attributes: { value: requestId } },
          ...(preprocessed?.markers ?? []),
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

  async profileSummary(query: string, now?: string): Promise<string> {
    if (!this.options.preprocessMessages) return "";
    const records = await this.engine.readProfileCandidates({
      sourceActor: "user",
      memoryTypes: ["constraint", "preference"],
      limit: 200,
      now: now ?? new Date().toISOString(),
    });
    return renderHttpProfileSupplement(records, query, undefined, this.options.profileGraph);
  }

  /** Canonical single-clause HTTP search with vector backfill, chronological sort option, and page fit. */
  async searchSingleClause(
    query: string,
    limit: number,
    options: {
      readonly now?: string;
      readonly sortResultsByTime?: boolean;
      readonly budget?: ExplicitSearchPageBudget;
    } = {},
  ): Promise<{ raw: MemoryContext; page: MemoryContext; profile: string }> {
    if (this.options.allowBackfill !== false) await this.backfillVectors();
    const raw = await this.searchFeature(query, limit, { now: options.now });
    const fitted = fitExplicitSearchPage(
      raw,
      { query, limit, persistTrace: false },
      options.budget,
    );
    const page = options.sortResultsByTime
      ? { ...fitted, results: sortResultsChronologically(fitted.results) }
      : fitted;
    const profile = this.options.preprocessMessages
      ? await this.profileSummary(query, options.now)
      : "";
    return { raw, page, profile };
  }

  async record(id: string) {
    return this.engine.record(id);
  }

  async searchFeature(text: string, limit: number, context: { now?: string } = {}) {
    const options = {
      ...HTTP_MEMORY_SEARCH_PROFILE,
      limit,
      ...(this.options.rerankGraph !== undefined ? { rerankGraph: this.options.rerankGraph } : {}),
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
    const batches: HttpClauseHitBatch[] = [];
    let records = false;
    for (const [index, query] of queries.entries()) {
      // User isolation is the physical manifest/partition boundary, including
      // legacy rows whose pre-upgrade scope differs. No session filter.
      const texts = features?.[index]?.length ? features[index]! : [query];
      const isAppendOnly = Boolean(appendOnly[index]);
      for (const text of texts) {
        const pageResult = await this.searchFeature(text, limit, context);
        records ||= pageResult.retrieval?.mode === "hybrid";
        batches.push({ clauseIndex: index, appendOnly: isAppendOnly, results: pageResult.results });
      }
    }
    const { selected, clauses, appended } = executeHttpSearchGraph(
      batches,
      { limit, clauseCount: queries.length },
      this.options.searchGraph,
    );
    return {
      retrievalMode: records ? "records" : "lexical",
      memories: selected.map((entry) => projectHttpMemory(entry.result, queries[0] ?? "")),
      clauses,
      appended: appended.map((result) => projectHttpMemory(result, queries[0] ?? "")),
    };
  }
}
