import {
  ComputeRegistry,
  INPUT_NODE_ID,
  executeComputeGraph,
  type ComputeGraphSpec,
  type ComputeMemoCache,
  type PhysicalPlanOptions,
} from "../compute-graph.ts";
import { calendarDay, eventWindowEnd, eventWindowStart, futureDueDays } from "../event-time.ts";
import { normalize } from "../memory-normalization.ts";
import { recallTriggersFromStoredMarkers } from "../recall-triggers.ts";
import { hostTimeZone, queryEventWindow, referenceTimeZone } from "../store/advanced-query.ts";
import { hybridScore, lexicalTextScore, searchTerms } from "../store/search-ranking.ts";
import type { MemoryContext, MemorySearchResult, NodeRelation, TesseraHit } from "../types.ts";
import type {
  MemoryEntity,
  MemoryEntityQuery,
  MemoryHybridPage,
  MemoryVectorQuery,
  SourceNeighbor,
} from "./backend.ts";
import { evidenceShortlist } from "./evidence-ranking.ts";
import {
  MAX_LEAF_CONTEXT_RESULTS,
  appendLeafPeers,
  attachedTesserae,
  boundedGraphHops,
  expandNodeHops,
  hydrateCandidates,
  projectResultChains,
  searchLimit,
  searchNodeIds,
  type MemoryQueryOptions,
  type MemorySnapshotPort,
  type SearchCandidate,
} from "./hydration.ts";
import { rankLocalLogOdds } from "./local-log-odds.ts";
import { searchableMemory } from "./model.ts";
import { rerankCandidatesWithGraph } from "./piecewise-rerank.ts";

export interface EngineSearchInput {
  readonly text: string;
  readonly options: MemoryQueryOptions;
  readonly callerNow?: string;
  readonly semantic?: MemoryVectorQuery;
  readonly exact?: RegExp;
}

export interface AnalyzedSearchQuery {
  readonly text: string;
  readonly limit: number;
  readonly options: MemoryQueryOptions;
  readonly callerNow: string;
  readonly semantic?: MemoryVectorQuery;
  readonly exact?: RegExp;
  readonly temporalWindow?: { from?: string; to?: string };
  readonly baseQuery: MemoryEntityQuery;
}

export interface SearchBatchState {
  readonly results: MemorySearchResult[];
  readonly exactMiss: boolean;
}

export interface ExpandedSearchState {
  readonly results: MemorySearchResult[];
  readonly relations: NodeRelation[];
  readonly exactMiss: boolean;
}

async function lexicalRecall(
  port: MemorySnapshotPort,
  text: string,
  query: MemoryEntityQuery,
  options: MemoryQueryOptions,
  limit: number,
  exact?: RegExp,
): Promise<MemorySearchResult[]> {
  const entities = await port.scan({ ...query, text });
  const matches = exact
    ? entities.filter(
        (entity) => entity.kind === "memory" && exact.test(normalize(entity.value.statement)),
      )
    : entities;
  return hydrateCandidates(port, matches, options, false, (candidates) =>
    candidates.slice(0, limit),
  );
}

function selectStandardHybrid(
  ranked: readonly SearchCandidate[],
  text: string,
  limit: number,
  rerankGraph: ComputeGraphSpec | false | undefined,
  turnMeta?: ReadonlyMap<string, { sourceSessionId?: string | null; turnOrdinal?: number | null }>,
): SearchCandidate[] {
  if (rerankGraph === false) return ranked.slice(0, limit);
  const ordered = rerankCandidatesWithGraph(
    ranked.map((candidate) => {
      const meta = turnMeta?.get(candidate.memory.id);
      return {
        candidate,
        id: candidate.memory.id,
        statement: candidate.memory.statement,
        combinedScore: candidate.combinedScore,
        eventTime: candidate.memory.eventTime,
        createdAt: candidate.memory.createdAt,
        sessionId:
          candidate.memory.sourceSessionId ??
          candidate.memory.sessionId ??
          meta?.sourceSessionId ??
          null,
        nodeId: candidate.memory.nodeId,
        evidenceId: candidate.memory.evidenceId,
        turnOrdinal: meta?.turnOrdinal ?? null,
        markers: candidate.memory.markers,
        stateKey: candidate.memory.stateKey,
        predicateKey: candidate.memory.predicateKey,
        supersedesId: candidate.memory.supersedesId,
        relatedMemoryIds: candidate.memory.relatedMemoryIds,
      };
    }),
    text,
    rerankGraph,
  );
  return ordered
    .slice(0, limit)
    .map(({ candidate, combinedScore }) => ({ ...candidate, combinedScore }));
}

function selectLocalHybrid(
  candidates: readonly SearchCandidate[],
  page: MemoryHybridPage,
  text: string,
  shortlist: boolean | undefined,
  rerankGraph: ComputeGraphSpec | false | undefined,
  limit: number,
): SearchCandidate[] {
  const byId = new Map(page.candidates.map((row) => [row.entity.value.id, row]));
  const ranked = rankLocalLogOdds(candidates, ({ memory }) => {
    const { recordScore, bm25 } = byId.get(memory.id)!;
    return { id: memory.id, vectorScore: recordScore, bm25 };
  }).map(({ candidate, score }) => ({ ...candidate, combinedScore: score }));
  const selected = shortlist
    ? evidenceShortlist(ranked, page.vectorIds, page.lexicalIds, limit)
    : selectStandardHybrid(ranked, text, limit, rerankGraph, byId);
  const query = normalize(text);
  const terms = searchTerms(query);
  return selected.map((candidate) => {
    const { memory, node } = candidate;
    const { recordScore, bm25 } = byId.get(memory.id)!;
    const triggers = recallTriggersFromStoredMarkers(memory.markers).join(" ");
    const lexicalScore = lexicalTextScore(
      query,
      `${memory.statement} ${node.canonicalName} ${node.summary} ${triggers}`,
      terms,
    );
    const recallReason =
      recordScore > 0
        ? bm25 > 0 || lexicalScore > 0
          ? "hybrid_match"
          : "vector_match"
        : "lexical_match";
    return { ...candidate, lexicalScore, vectorScore: recordScore, recallReason };
  });
}

async function semanticRecall(
  port: MemorySnapshotPort,
  text: string,
  query: MemoryEntityQuery,
  options: MemoryQueryOptions,
  semantic: MemoryVectorQuery,
  limit: number,
): Promise<MemorySearchResult[]> {
  if (!port.hasVectorIndex || !port.vectorCandidates) {
    throw new Error("This memory backend has no vector index");
  }
  if (semantic.mode === "hybrid" && port.hybridCandidates) {
    const page = port.hybridCandidates({ ...query, text, limit: 100 }, semantic);
    return hydrateCandidates(
      port,
      page.candidates.map(({ entity }) => entity),
      options,
      false,
      (candidates) =>
        selectLocalHybrid(
          candidates,
          page,
          text,
          options.evidenceShortlist,
          options.rerankGraph,
          limit,
        ),
    );
  }
  const semanticLimit = semantic.mode === "vector" ? 512 : 256;
  const vectors = port.vectorCandidates({ ...query, limit: semanticLimit }, semantic);
  const lexical = semantic.mode === "vector" ? [] : await port.scan({ ...query, text, limit: 256 });
  const candidates = new Map(
    [...lexical, ...vectors.map((item) => item.entity)].map((entity) => [entity.value.id, entity]),
  );
  const scores = new Map(vectors.map((item) => [item.entity.value.id, item]));
  const queryText = normalize(text);
  const terms = searchTerms(queryText);
  return hydrateCandidates(port, [...candidates.values()], options, false, (projected) => {
    const ranked = projected
      .map((result): SearchCandidate => {
        const score = scores.get(result.memory.id);
        const vectorScore = score?.recordScore ?? 0;
        const triggers = recallTriggersFromStoredMarkers(result.memory.markers).join(" ");
        const lexicalScore = lexicalTextScore(
          queryText,
          `${result.memory.statement} ${result.node.canonicalName} ${result.node.summary} ${triggers}`,
          terms,
        );
        const combinedScore =
          semantic.mode === "vector" ? vectorScore : hybridScore(lexicalScore, vectorScore, 0);
        const recallReason = score
          ? lexicalScore
            ? "hybrid_match"
            : "vector_match"
          : "lexical_match";
        return { ...result, lexicalScore, vectorScore, combinedScore, recallReason };
      })
      .sort((left, right) => right.combinedScore - left.combinedScore);
    if (semantic.mode !== "hybrid" || !options.evidenceShortlist) return ranked.slice(0, limit);
    return evidenceShortlist(
      ranked,
      vectors.map((item) => item.entity.value.id),
      lexical.flatMap((item) => (item.kind === "memory" ? [item.value.id] : [])),
      limit,
    );
  });
}

function executeChannelRecall(
  port: MemorySnapshotPort,
  text: string,
  query: MemoryEntityQuery,
  options: MemoryQueryOptions,
  limit: number,
  semantic?: MemoryVectorQuery,
  exact?: RegExp,
): Promise<MemorySearchResult[]> {
  return semantic
    ? semanticRecall(port, text, query, options, semantic, limit)
    : lexicalRecall(port, text, query, options, limit, exact);
}

function mergeTemporalWindow(
  normal: readonly MemorySearchResult[],
  windowed: readonly MemorySearchResult[],
  limit: number,
): MemorySearchResult[] {
  if (!windowed.length) return [...normal];
  const maxNormal = normal.reduce((max, item) => Math.max(max, item.combinedScore), 0);
  const boosted = windowed.slice(0, Math.ceil(limit / 2)).map((item) => ({
    ...item,
    combinedScore: item.combinedScore + maxNormal + 1,
  }));
  const seen = new Set(boosted.map(({ memory }) => memory.id));
  return [...boosted, ...normal.filter(({ memory }) => !seen.has(memory.id))].slice(0, limit);
}

function isAdjacentTurn(result: MemorySearchResult): boolean {
  return result.neighborhood === "previous_turn" || result.neighborhood === "next_turn";
}

function capTailScores(
  floor: number | undefined,
  items: readonly MemorySearchResult[],
): MemorySearchResult[] {
  if (floor === undefined) return [...items];
  return items.map((item, index) => ({
    ...item,
    combinedScore: Math.min(item.combinedScore, Math.max(0, floor - (index + 1) * 1e-6)),
  }));
}

function isDueMemoryCandidate(
  entity: MemoryEntity,
  seen: ReadonlySet<string>,
  zone: string,
  today: string,
): entity is Extract<MemoryEntity, { kind: "memory" }> {
  if (entity.kind !== "memory" || seen.has(entity.value.id)) return false;
  const time = entity.value.eventTime;
  if (!time) return false;
  const anchor = new Date(time);
  if (!Number.isFinite(anchor.getTime()) || calendarDay(anchor, zone) >= today) return false;
  return futureDueDays(entity.value.statement, anchor, zone).includes(today);
}

async function scanDueTodayCandidates(
  port: MemorySnapshotPort,
  results: readonly MemorySearchResult[],
  options: MemoryQueryOptions,
  refDate: Date,
  zone: string,
  today: string,
): Promise<Extract<MemoryEntity, { kind: "memory" }>[]> {
  const seen = new Set(results.map(({ memory }) => memory.id));
  const windowFrom = new Date(refDate.getTime() - 45 * 86_400_000).toISOString();
  const windowTo = refDate.toISOString();
  const matches: Extract<MemoryEntity, { kind: "memory" }>[] = [];
  for (let page = 0; page < 4; page += 1) {
    const rows = await port.scan({
      kind: "memory",
      scope: options.scope,
      excludeScope: options.excludeScope,
      sessionId: options.sessionId,
      eventTimeFrom: windowFrom,
      eventTimeTo: windowTo,
      limit: 512,
      offset: page * 512,
    });
    for (const entity of rows) {
      if (isDueMemoryCandidate(entity, seen, zone, today)) matches.push(entity);
    }
    if (rows.length < 512) break;
  }
  matches.sort(
    (a, b) =>
      (b.value.eventTime ?? "").localeCompare(a.value.eventTime ?? "") ||
      a.value.id.localeCompare(b.value.id),
  );
  return matches;
}

async function collectMatchingSourceNeighbors(
  port: MemorySnapshotPort,
  results: readonly MemorySearchResult[],
  analysis: AnalyzedSearchQuery,
): Promise<MemorySearchResult[]> {
  const out = [...results];
  const { options, semantic, text, baseQuery, limit } = analysis;
  if (!options.expandSourceContext || semantic?.mode !== "hybrid") return out;
  if (!port.adjacentSources || !out.length || limit < 10) return out;
  const terms = searchTerms(normalize(text)).filter((term) => /\p{L}/u.test(term));
  const seen = new Set(out.map(({ memory }) => memory.id));
  const matches: Array<SourceNeighbor & { overlap: number }> = [];
  for (const [anchorIndex, anchor] of out.slice(0, 2).entries()) {
    for (const neighbor of port.adjacentSources(anchor.evidence, {
      ...baseQuery,
      scope: anchor.memory.scope,
      limit: 8,
    })) {
      const { id, statement } = neighbor.entity.value;
      if (seen.has(id)) continue;
      seen.add(id);
      const tokens = new Set(searchTerms(normalize(statement)));
      const overlap = terms.filter((term) => tokens.has(term)).length;
      if (overlap > 0 || anchorIndex === 0) matches.push({ ...neighbor, overlap });
    }
  }
  matches.sort((a, b) => b.overlap - a.overlap);
  const relation = new Map(matches.map(({ entity, relation }) => [entity.value.id, relation]));
  const neighbors = await hydrateCandidates(
    port,
    matches.map(({ entity }) => entity),
    { ...options, limit },
    false,
    (rows) => rows.slice(0, 2),
  );
  const pivot = Math.min(out.length, limit - neighbors.length);
  const floor = out.slice(0, pivot).at(-1)?.combinedScore;
  out.splice(
    pivot,
    out.length - pivot,
    ...capTailScores(
      floor,
      neighbors.map((result) => ({ ...result, neighborhood: relation.get(result.memory.id) })),
    ),
  );
  return out;
}

async function spliceDueReminders(
  port: MemorySnapshotPort,
  results: readonly MemorySearchResult[],
  analysis: AnalyzedSearchQuery,
): Promise<MemorySearchResult[]> {
  const out = [...results];
  const { options, limit } = analysis;
  if (!options.dueReminders || analysis.exact) return out;
  const reference = options.now ?? analysis.callerNow;
  const refDate = new Date(reference);
  if (!Number.isFinite(refDate.getTime())) return out;
  const zone = options.now ? referenceTimeZone(reference, refDate) : hostTimeZone(refDate);
  const today = calendarDay(refDate, zone);
  const candidates = await scanDueTodayCandidates(port, out, options, refDate, zone, today);
  if (!candidates.length) return out;
  const projected = await hydrateCandidates(port, candidates, options, false, (rows) =>
    rows.slice(0, Math.min(2, limit)),
  );
  if (!projected.length) return out;
  const tail = out.filter(isAdjacentTurn);
  const ranked = out.filter((item) => !isAdjacentTurn(item));
  const keepRanked = Math.max(0, limit - projected.length - tail.length);
  const kept = ranked.slice(0, keepRanked);
  const floor = kept.at(-1)?.combinedScore;
  const due = capTailScores(
    floor,
    projected.map((item) => ({ ...item, neighborhood: "due_today" as const })),
  );
  return [...kept, ...due, ...capTailScores(due.at(-1)?.combinedScore ?? floor, tail)].slice(
    0,
    limit,
  );
}

async function searchIndependentTesserae(
  port: MemorySnapshotPort,
  text: string,
  options: MemoryQueryOptions,
  results: readonly MemorySearchResult[],
): Promise<TesseraHit[]> {
  const attached = await attachedTesserae(port, results);
  if (!options.findTesserae) return attached;
  const rows = await port.scan({ kind: "tessera", text, limit: 50 });
  const matches = rows.flatMap((row) => (row.kind === "tessera" ? [row.value] : []));
  const ids = [...new Set(matches.flatMap(({ memoryId }) => (memoryId ? [memoryId] : [])))];
  const owners = await port.scan({ kind: "memory", ids, sessionId: options.sessionId });
  const visible = new Set(
    owners.flatMap((row) =>
      row.kind === "memory" && searchableMemory(row.value, options, port.now) ? [row.value.id] : [],
    ),
  );
  const independent = matches
    .filter(({ memoryId }) => !memoryId || visible.has(memoryId))
    .slice(0, Math.min(options.limit ?? 8, 10))
    .map((item, rank) => ({ ...item, score: 1 / (rank + 1) }));
  return [...new Map([...attached, ...independent].map((item) => [item.id, item])).values()];
}

function buildSearchRegistry(): ComputeRegistry<MemorySnapshotPort> {
  const registry = new ComputeRegistry<MemorySnapshotPort>();
  const readOp = (
    contract: string,
    deps: readonly ("storage_snapshot" | "clock")[] = ["storage_snapshot"],
  ) => ({
    version: "1.0.0",
    effect: "read" as const,
    contract,
    externalDeps: deps,
    cacheable: false,
    parallelSafe: false,
    resources: { execution: "async_io" as const },
  });

  registry.register(
    "analyze_search_query",
    async (inputs, port): Promise<AnalyzedSearchQuery> => {
      const req = inputs.default as EngineSearchInput;
      if (!req.text.trim()) throw new Error("Search query is required");
      const limit = searchLimit(req.options.limit);
      boundedGraphHops(req.options.graphHops);
      const eventTimeFrom = eventWindowStart(req.options.eventTimeFrom) ?? undefined;
      const eventTimeTo = eventWindowEnd(req.options.eventTimeTo) ?? undefined;
      const options = { ...req.options, eventTimeFrom, eventTimeTo };
      const callerNow = req.callerNow ?? port.now;
      let temporalWindow: { from?: string; to?: string } | undefined;
      if (!req.exact && !eventTimeFrom && !eventTimeTo) {
        const reference = options.now ?? callerNow;
        const zone = options.now ? undefined : hostTimeZone(new Date(reference));
        const temporal = queryEventWindow(req.text, reference, zone);
        if (temporal.from || temporal.to) temporalWindow = temporal;
      }
      const baseQuery: MemoryEntityQuery = {
        kind: "memory",
        nodeIds: await searchNodeIds(port, options.nodeName),
        scope: options.scope,
        excludeScope: options.excludeScope,
        sessionId: options.sessionId,
        eventTimeFrom,
        eventTimeTo,
        limit: 512,
      };
      return {
        text: req.text,
        limit,
        options,
        callerNow,
        semantic: req.semantic,
        exact: req.exact,
        temporalWindow,
        baseQuery,
      };
    },
    readOp("memory.query_analysis", ["storage_snapshot", "clock"]),
  );

  registry.register(
    "recall_primary_candidates",
    async (inputs, port): Promise<SearchBatchState> => {
      const analysis = inputs.default as AnalyzedSearchQuery;
      const results = await executeChannelRecall(
        port,
        analysis.text,
        analysis.baseQuery,
        analysis.options,
        analysis.limit,
        analysis.semantic,
        analysis.exact,
      );
      return { results, exactMiss: Boolean(analysis.exact && !results.length) };
    },
    readOp("memory.candidate_recall"),
  );

  registry.register(
    "recall_temporal_window",
    async (inputs, port): Promise<SearchBatchState> => {
      const state = inputs.candidates as SearchBatchState;
      const analysis = inputs.analysis as AnalyzedSearchQuery;
      if (state.exactMiss || analysis.exact || !analysis.temporalWindow) return state;
      const windowed = await executeChannelRecall(
        port,
        analysis.text,
        {
          ...analysis.baseQuery,
          eventTimeFrom: analysis.temporalWindow.from,
          eventTimeTo: analysis.temporalWindow.to,
        },
        {
          ...analysis.options,
          eventTimeFrom: analysis.temporalWindow.from,
          eventTimeTo: analysis.temporalWindow.to,
        },
        analysis.limit,
        analysis.semantic,
      );
      return {
        exactMiss: false,
        results: mergeTemporalWindow(state.results, windowed, analysis.limit),
      };
    },
    readOp("memory.candidate_recall"),
  );

  registry.register(
    "expand_search_neighbors",
    async (inputs, port): Promise<ExpandedSearchState> => {
      const state = inputs.candidates as SearchBatchState;
      const analysis = inputs.analysis as AnalyzedSearchQuery;
      if (state.exactMiss) return { results: [], relations: [], exactMiss: true };
      const stepOptions = { ...analysis.options, limit: analysis.limit };
      const withTurns = await collectMatchingSourceNeighbors(port, state.results, analysis);
      const withDue = await spliceDueReminders(port, withTurns, {
        ...analysis,
        options: stepOptions,
      });
      const includeLeaves = Boolean(stepOptions.expandLeafContext || stepOptions.graphHops);
      const seeds = includeLeaves
        ? withDue.slice(0, MAX_LEAF_CONTEXT_RESULTS).map(({ memory }) => memory.id)
        : [];
      const relations = await expandNodeHops(port, withDue, stepOptions);
      const budget = Math.min(MAX_LEAF_CONTEXT_RESULTS, stepOptions.limit - withDue.length);
      if (includeLeaves) {
        await appendLeafPeers(port, withDue, seeds, analysis.baseQuery, stepOptions, budget);
      }
      return { results: withDue, relations, exactMiss: false };
    },
    readOp("memory.neighborhood_expand"),
  );

  registry.register(
    "assemble_search_context",
    async (inputs, port): Promise<MemoryContext> => {
      const expanded = inputs.expanded as ExpandedSearchState;
      const analysis = inputs.analysis as AnalyzedSearchQuery;
      if (expanded.exactMiss) {
        return { results: [], relations: [], retrieval: { mode: "lexical", degraded: false } };
      }
      const stepOptions = { ...analysis.options, limit: analysis.limit };
      const results = expanded.results;
      const tesserae = await searchIndependentTesserae(port, analysis.text, stepOptions, results);
      return {
        results,
        relations: expanded.relations,
        chainEdges: projectResultChains(port, results, stepOptions.sessionId),
        retrieval: { mode: analysis.semantic ? "hybrid" : "lexical", degraded: false },
        ...(tesserae.length ? { tesserae } : {}),
      };
    },
    readOp("memory.context_assemble"),
  );

  return registry;
}

export const ENGINE_SEARCH_REGISTRY = buildSearchRegistry();

export const DEFAULT_ENGINE_SEARCH_GRAPH: ComputeGraphSpec = {
  id: "engine-production-search-v1",
  nodes: [
    { id: "analyze", op: "analyze_search_query", contract: "memory.query_analysis" },
    { id: "recall", op: "recall_primary_candidates", contract: "memory.candidate_recall" },
    { id: "temporal", op: "recall_temporal_window", contract: "memory.candidate_recall" },
    { id: "expand", op: "expand_search_neighbors", contract: "memory.neighborhood_expand" },
    { id: "assemble", op: "assemble_search_context", contract: "memory.context_assemble" },
  ],
  edges: [
    { from: INPUT_NODE_ID, to: "analyze" },
    { from: "analyze", to: "recall" },
    { from: "recall", to: "temporal", port: "candidates" },
    { from: "analyze", to: "temporal", port: "analysis" },
    { from: "temporal", to: "expand", port: "candidates" },
    { from: "analyze", to: "expand", port: "analysis" },
    { from: "expand", to: "assemble", port: "expanded" },
    { from: "analyze", to: "assemble", port: "analysis" },
  ],
  output: "assemble",
};

/** Execute the production MemoryEngine search ComputeGraph against a narrow snapshot port. */
export function executeEngineSearchGraph(
  input: EngineSearchInput,
  port: MemorySnapshotPort,
  spec: ComputeGraphSpec = DEFAULT_ENGINE_SEARCH_GRAPH,
  registry: ComputeRegistry<MemorySnapshotPort> = ENGINE_SEARCH_REGISTRY,
  memo?: ComputeMemoCache,
  planOptions?: PhysicalPlanOptions,
): Promise<MemoryContext> {
  return executeComputeGraph<EngineSearchInput, MemoryContext, MemorySnapshotPort>(
    spec,
    registry,
    input,
    port,
    memo,
    planOptions,
  );
}
