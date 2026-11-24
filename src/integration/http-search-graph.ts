import {
  ComputeRegistry,
  INPUT_NODE_ID,
  evaluateSyncComputeGraph,
  type ComputeGraphSpec,
} from "../core/compute-graph.ts";
import type { MemorySearchResult } from "../core/types.ts";

export interface ClauseContribution {
  /** Position of the clause in the request's clause list. */
  index: number;
  /** Returned memories this clause surfaced (it may have surfaced more). */
  contributed: number;
  /** Returned memories that no other clause surfaced. */
  exclusive: number;
}

export interface FusedCandidate {
  result: MemorySearchResult;
  sources: Set<number>;
}

export interface HttpClauseHitBatch {
  readonly clauseIndex: number;
  readonly appendOnly: boolean;
  readonly results: readonly MemorySearchResult[];
}

export interface HttpSearchGraphContext {
  readonly limit: number;
  readonly clauseCount: number;
}

export interface FusedHttpState {
  readonly primary: readonly FusedCandidate[];
  readonly adjacentById: ReadonlyMap<string, FusedCandidate>;
  readonly primaryById: ReadonlyMap<string, FusedCandidate>;
  readonly appendedById: ReadonlyMap<string, MemorySearchResult>;
}

export interface HttpSearchGraphOutput {
  readonly selected: readonly FusedCandidate[];
  readonly clauses: ClauseContribution[];
  readonly appended: readonly MemorySearchResult[];
}

function isTailContext(result: MemorySearchResult): boolean {
  return (
    result.neighborhood === "previous_turn" ||
    result.neighborhood === "next_turn" ||
    result.neighborhood === "due_today"
  );
}

function compareCandidates(left: FusedCandidate, right: FusedCandidate): number {
  return (
    right.result.combinedScore - left.result.combinedScore ||
    left.result.memory.id.localeCompare(right.result.memory.id)
  );
}

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

function trackAppended(
  byId: Map<string, MemorySearchResult>,
  results: readonly MemorySearchResult[],
): void {
  for (const result of results) {
    const prior = byId.get(result.memory.id);
    if (!prior || result.combinedScore > prior.combinedScore) byId.set(result.memory.id, result);
  }
}

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

function numParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function buildHttpSearchRegistry(): ComputeRegistry<HttpSearchGraphContext> {
  const registry = new ComputeRegistry<HttpSearchGraphContext>();
  const pureOp = {
    version: "1.0.0",
    effect: "pure" as const,
    cacheable: true,
    parallelSafe: true,
    resources: { execution: "sync" as const, backend: "js" as const },
  };

  registry.register(
    "fuse_clause_hits",
    (inputs) => {
      const batches = (inputs.default as readonly HttpClauseHitBatch[] | undefined) ?? [];
      const primaryById = new Map<string, FusedCandidate>();
      const adjacentById = new Map<string, FusedCandidate>();
      const appendedById = new Map<string, MemorySearchResult>();
      for (const batch of batches) {
        if (batch.appendOnly) {
          trackAppended(appendedById, batch.results);
          continue;
        }
        for (const result of batch.results) {
          trackCandidate(
            isTailContext(result) ? adjacentById : primaryById,
            batch.clauseIndex,
            result,
          );
        }
      }
      const primary = [...primaryById.values()].sort(compareCandidates);
      return { primary, adjacentById, primaryById, appendedById } satisfies FusedHttpState;
    },
    { ...pureOp, contract: "memory.rank_fusion" },
  );

  registry.register(
    "select_supplemental_tail",
    (inputs, context, params) => {
      const state = inputs.default as FusedHttpState;
      const maxDue = Math.max(0, Math.floor(numParam(params, "maxDue", 2)));
      const maxNeighbors = Math.max(0, Math.floor(numParam(params, "maxNeighbors", 2)));
      const maxTotal = Math.max(0, Math.floor(numParam(params, "maxTotal", 4)));
      const candidates = [...state.adjacentById.values()].filter(
        (entry) => !state.primaryById.has(entry.result.memory.id),
      );
      const due = candidates
        .filter((entry) => entry.result.neighborhood === "due_today")
        .sort(compareCandidates)
        .slice(0, Math.min(maxDue, context.limit));
      const dueIds = new Set(due.map((entry) => entry.result.memory.id));
      const neighbors = candidates
        .filter(
          (entry) =>
            entry.result.neighborhood !== "due_today" && !dueIds.has(entry.result.memory.id),
        )
        .sort(compareCandidates)
        .slice(0, Math.min(maxNeighbors, context.limit));
      return [...due, ...neighbors].slice(0, Math.min(maxTotal, context.limit));
    },
    { ...pureOp, contract: "memory.neighborhood_expand" },
  );

  registry.register(
    "stitch_http_page",
    (inputs, context) => {
      const state = inputs.fused as FusedHttpState;
      const tail = (inputs.tail as readonly FusedCandidate[] | undefined) ?? [];
      const hits = state.primary.slice(0, Math.max(0, context.limit - tail.length));
      const selected = appendTailNeighbors(hits, tail);
      const page = new Set(selected.map((entry) => entry.result.memory.id));
      const appended = [...state.appendedById.values()]
        .filter((result) => !page.has(result.memory.id))
        .sort((a, b) => b.combinedScore - a.combinedScore || a.memory.id.localeCompare(b.memory.id))
        .slice(0, context.limit);
      return {
        selected,
        clauses: summariseClauses(selected, context.clauseCount),
        appended,
      } satisfies HttpSearchGraphOutput;
    },
    { ...pureOp, contract: "memory.context_assemble" },
  );

  return registry;
}

export const HTTP_SEARCH_COMPUTE_REGISTRY = buildHttpSearchRegistry();

export const DEFAULT_HTTP_SEARCH_GRAPH: ComputeGraphSpec = {
  id: "http-multi-clause-fusion-v1",
  nodes: [
    { id: "fuse", op: "fuse_clause_hits" },
    {
      id: "tail",
      op: "select_supplemental_tail",
      params: { maxDue: 2, maxNeighbors: 2, maxTotal: 4 },
    },
    { id: "stitch", op: "stitch_http_page" },
  ],
  edges: [
    { from: INPUT_NODE_ID, to: "fuse" },
    { from: "fuse", to: "tail" },
    { from: "fuse", to: "stitch", port: "fused" },
    { from: "tail", to: "stitch", port: "tail" },
  ],
  output: "stitch",
};

/** Run multi-clause fusion, supplemental tail selection, and page stitching through ComputeGraph. */
export function executeHttpSearchGraph(
  batches: readonly HttpClauseHitBatch[],
  context: HttpSearchGraphContext,
  graph: ComputeGraphSpec = DEFAULT_HTTP_SEARCH_GRAPH,
): HttpSearchGraphOutput {
  return evaluateSyncComputeGraph<
    readonly HttpClauseHitBatch[],
    HttpSearchGraphOutput,
    HttpSearchGraphContext
  >(graph, HTTP_SEARCH_COMPUTE_REGISTRY, batches, context);
}
