/**
 * retrieval cluster of NmgStore methods — official TypeScript mixin pattern
 * (docs/design/store-cluster-split.md, cluster-dag.test.ts).
 *
 * The mixin adds the cluster's methods to any base class; store.ts assembles
 * NmgStore = withGraph(withRetrieval(withWrites(withMaintenance(Base)))).
 * Method bodies use `this.` exactly as they did in the monolith: the final
 * class's prototype chain resolves cross-cluster and base-helper calls.
 * Cluster files import no store code — types and utilities only, so the
 * module graph stays acyclic (DAG).
 */
import type { Constructor } from "./store-ctor.ts";
import { randomUUID } from "node:crypto";
import { extractEventWindow } from "./advanced-query.ts";
import { nowMs, PerfTimer, SECTION } from "../perf.ts";
import type { PerfSnapshot } from "../perf.ts";
import {
  activeGraphBudget,
  activeGraphBudgetLedger,
  activeGraphExpansions,
  estimateResultTokens,
  expandActiveGraphBudget,
  fibonacciEvidenceBudgets,
  queryAssociationEdges,
  selectWithinActiveGraphBudget,
  stableTaskId,
} from "./active-graph.ts";
import { computeQppComponents, qppCandidates, shouldTriggerSecondPass } from "../qpp.ts";
import {
  DEFAULT_INITIAL_EVIDENCE_TARGET,
  STRONG_HIT_INITIAL_TARGET,
  STRONG_HIT_TOP_GAP,
} from "../qpp.ts";
import { propagateEdgeActivation, type EdgePropagationResult } from "../edge-activation.ts";
import {
  contextUsefulness,
  ftsExpression,
  hybridScore,
  lexicalScore,
  mergeSemanticCandidates,
  normalize,
  normalizeStatement,
  queryOverlapTerms,
  recallHitTerms,
  recallReason,
  termOverlapScore,
  type StoreRow as Row,
} from "./search-ranking.ts";
import { clamp, effectiveFilterDimensions, mapSearchResult, matchesScope } from "./rows.ts";
import { cosineSimilarity } from "../vector.ts";
import { storedVector } from "./vector-codec.ts";
import type {
  ActiveGraph,
  ActiveGraphBudget,
  ActiveGraphBudgetUsage,
  ActiveGraphSelection,
  LeafBlock,
  HistoryRecord,
  MemoryContext,
  MemoryRecord,
  MemoryChainType,
  MemoryChainEdgeType,
  MemorySearchResult,
  MemoryTier,
  NodeRelation,
  NodeRoute,
  NodeRouteSignalItem,
  QppTriggerDecision,
  RecallCue,
  RecallIndex,
  RetrievalFilterUsage,
  RetrievalTraceInput,
  SearchOptions,
  VectorEmbedder,
} from "../types.ts";
import {
  DEFAULT_APPENDED_BASE_CHARS,
  DEFAULT_APPENDED_MAX_CHARS,
  DEFAULT_APPENDED_MAX_RATIO,
} from "../types.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  MIN_WARM_DISCLOSURE_SIZE,
  SUPERSEDE_SUCCESSOR_BOOST,
  TEMPORAL_ASOF_BOOST,
  TEMPORAL_ASOF_DECAY_DAYS,
} from "./graph-policy.ts";

const MAX_SEARCH_CANDIDATES = 500;

function rankMainCandidates(
  query: string,
  direct: readonly MemorySearchResult[],
  related: readonly MemorySearchResult[],
  edgeProjection: EdgePropagationResult,
): MemorySearchResult[] {
  return [...direct, ...related]
    .filter(
      (result, index, all) =>
        all.findIndex((candidate) => candidate.memory.id === result.memory.id) === index,
    )
    .sort((left, right) => contextUsefulness(query, right) - contextUsefulness(query, left))
    .map((result) => {
      if (result.path) return result;
      const path = edgeProjection.paths.get(result.node.id);
      return path && path.length > 0 ? { ...result, path } : result;
    });
}

function buildActiveGraphSelections(
  query: string,
  results: readonly MemorySearchResult[],
  directMemoryIds: ReadonlySet<string>,
  attachmentIds: ReadonlySet<string>,
): ActiveGraphSelection[] {
  return results.map((result, index) => ({
    memoryId: result.memory.id,
    nodeId: result.node.id,
    source: directMemoryIds.has(result.memory.id)
      ? "direct"
      : attachmentIds.has(result.memory.id)
        ? "open_attachment"
        : "graph_expansion",
    reason: recallReason(result),
    rank: index + 1,
    tier: result.memory.tier,
    estimatedTokens: estimateResultTokens(result),
    scores: {
      lexical: result.lexicalScore,
      vector: result.vectorScore,
      route: result.routeScore,
      combined: result.combinedScore,
      usefulness: contextUsefulness(query, result),
    },
  }));
}

function markDuplicateResults(results: MemorySearchResult[]): void {
  const seen = new Map<string, string>();
  for (const result of results) {
    const normalized = normalizeStatement(result.memory.statement);
    const kept = seen.get(normalized);
    if (kept !== undefined) result.duplicateOf = kept;
    else seen.set(normalized, result.memory.id);
  }
}

export function withRetrieval<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    // Base-class and cross-cluster members (resolved at assembly time)
    declare protected db: DatabaseSync;
    declare protected embedder: VectorEmbedder;

    // graph cluster
    declare getRelations: (nodeIds: string[], maxHops?: number) => NodeRelation[];
    declare routeNodes: (query: string, limit?: number) => NodeRoute[];
    declare routeNodesByVector: (
      queryVector: readonly number[],
      model: string,
      limit?: number,
      candidateNodeIds?: string[],
      activationMode?: "cosine" | "hierarchical-activation",
      sessionId?: string,
    ) => NodeRoute[];
    declare routeLeafBlocksByVector: (
      queryVector: readonly number[],
      model: string,
      nodeIds?: string[],
      limit?: number,
      candidateBlockIds?: string[],
    ) => Array<{ block: LeafBlock; score: number }>;

    // cross-cluster (maintenance / base)
    declare protected resolveActiveNodeName: (nodeName: string) => string;
    declare protected ftsCandidates: (query: string, limit: number) => string[];
    declare protected evidenceIds: (memoryId: string) => string[];
    declare protected evidenceRecords: (ids: string[]) => HistoryRecord[];
    declare protected resultsForNode: (
      nodeId: string,
      maxTier: MemoryTier,
      limit: number,
      memoryId?: string,
      sourceActor?: string,
      sessionId?: string | null,
      includeHistorical?: boolean,
    ) => MemorySearchResult[];
    declare protected ftsCandidatesInNodes: (
      query: string,
      nodeIds: string[],
      limit: number,
    ) => string[];
    declare recordRetrievalTrace: (input: RetrievalTraceInput) => string;
    declare protected recordPerfAggregates: (timings: PerfSnapshot | undefined) => void;

    searchContext(
      query: string,
      options: SearchOptions = {},
      semantic?: { queryVector: readonly number[]; model: string },
    ): MemoryContext {
      const startedAt = nowMs();
      // Temporal intent: natural-language dates in the query ("as of Mar 10,
      // 2029") bound the candidate-generation window. This is enforced in the
      // candidate SQL — not post-query — so out-of-window memories never
      // compete for the top-k slots. Explicit time: filters parsed upstream
      // (SearchOptions.eventTimeFrom/To) take precedence.
      const temporal = extractEventWindow(query);
      if (temporal.from || temporal.to) {
        options = {
          ...options,
          eventTimeFrom: options.eventTimeFrom ?? temporal.from,
          eventTimeTo: options.eventTimeTo ?? temporal.to,
        };
      }
      const perf = options.perf === false ? null : new PerfTimer();
      const budget = activeGraphBudget(options);
      const limit = Math.max(1, Math.min(options.limit ?? 8, budget.maxEvidence, 50));
      const hardTier = Math.min(
        options.maxTier ?? budget.maxLocalTier,
        budget.maxLocalTier,
      ) as MemoryTier;
      const filterUsage: RetrievalFilterUsage = {
        dimensions: effectiveFilterDimensions(options),
        candidatesBefore: 0,
        candidatesAfter: 0,
        selectivity: 0,
      };
      const retrieveDirect = (maxTier: MemoryTier): MemorySearchResult[] => {
        const directOptions = {
          ...options,
          maxTier,
          limit: Math.min(50, Math.max(20, limit * 3)),
        };
        const retrieve = () =>
          semantic
            ? options.vectorGranularity === "union"
              ? mergeSemanticCandidates(
                  query,
                  [
                    ...this.searchHierarchyByVector(
                      query,
                      semantic.queryVector,
                      semantic.model,
                      directOptions,
                    ),
                    ...this.searchByVector(query, semantic.queryVector, semantic.model, {
                      ...directOptions,
                      retrievalMode: "qwen3",
                    }),
                  ],
                  directOptions.limit,
                )
              : options.vectorGranularity === "records"
                ? this.searchByVector(query, semantic.queryVector, semantic.model, {
                    ...directOptions,
                    retrievalMode: "qwen3",
                  })
                : this.searchHierarchyByVector(
                    query,
                    semantic.queryVector,
                    semantic.model,
                    directOptions,
                  )
            : this.search(query, directOptions, filterUsage);
        return perf ? perf.measure(SECTION.searchDirect, retrieve) : retrieve();
      };
      const directQpp = (results: readonly MemorySearchResult[]): QppTriggerDecision =>
        shouldTriggerSecondPass(
          query,
          results.map((result) => ({
            strength: hybridScore(result.lexicalScore, result.vectorScore, result.routeScore),
            reason: recallReason(result),
            memoryType: result.memory.memoryType,
            isDirect: true,
          })),
          options.qppThreshold,
        );
      const openedTiers: MemoryTier[] = [];
      let direct = retrieveDirect(options.tieredDisclosure ? 0 : hardTier);
      if (options.tieredDisclosure) {
        openedTiers.push(0);
      } else {
        for (let tier = 0; tier <= hardTier; tier += 1) openedTiers.push(tier as MemoryTier);
      }
      if (options.tieredDisclosure) {
        for (let tier = 1; tier <= hardTier && directQpp(direct).trigger; tier += 1) {
          direct = retrieveDirect(tier as MemoryTier);
          openedTiers.push(tier as MemoryTier);
        }
      }
      const graphHops = Math.min(options.graphHops ?? 1, budget.maxGraphHops);
      const discoveredRelations = perf
        ? perf.measure(SECTION.relations, () =>
            this.getRelations(
              direct.map((result) => result.node.id),
              graphHops,
            ),
          )
        : this.getRelations(
            direct.map((result) => result.node.id),
            graphHops,
          );
      const directNodeIds = new Set(direct.map((result) => result.node.id));
      const seedActivations = new Map<string, number>();
      for (const result of direct) {
        const activation = hybridScore(result.lexicalScore, result.vectorScore, result.routeScore);
        seedActivations.set(
          result.node.id,
          Math.max(seedActivations.get(result.node.id) ?? 0, activation),
        );
      }
      const discoveredRelatedNodeIds = [
        ...new Set(
          discoveredRelations.flatMap((relation) => [relation.sourceNodeId, relation.targetNodeId]),
        ),
      ].filter((id) => !directNodeIds.has(id));
      const openedMaxTier = openedTiers.at(-1) ?? 0;
      const relatedRaw = perf
        ? perf.measure(SECTION.relatedExpansion, () =>
            discoveredRelatedNodeIds.flatMap((nodeId) =>
              this.resultsForNode(
                nodeId,
                openedMaxTier,
                2,
                undefined,
                options.sourceActor,
                options.sessionId ?? null,
              ),
            ),
          )
        : discoveredRelatedNodeIds.flatMap((nodeId) =>
            this.resultsForNode(
              nodeId,
              openedMaxTier,
              2,
              undefined,
              options.sourceActor,
              options.sessionId ?? null,
            ),
          );
      const readableNodeIds = new Set([
        ...directNodeIds,
        ...relatedRaw.map((result) => result.node.id),
      ]);
      const relations = discoveredRelations.filter(
        (relation) =>
          readableNodeIds.has(relation.sourceNodeId) && readableNodeIds.has(relation.targetNodeId),
      );
      const relatedNodeIds = [...readableNodeIds].filter((id) => !directNodeIds.has(id));
      const edgeProjection = propagateEdgeActivation(seedActivations, relations, {
        maxHops: graphHops,
      });
      const related = relatedRaw.map((result) => {
        const edgeScore = edgeProjection.nodeActivations.get(result.node.id) ?? 0;
        const path = edgeProjection.paths.get(result.node.id);
        const withPath = path && path.length > 0 ? { ...result, path } : result;
        if (edgeScore <= result.routeScore) return withPath;
        return {
          ...withPath,
          routeScore: edgeScore,
          combinedScore: hybridScore(result.lexicalScore, result.vectorScore, edgeScore),
        };
      });
      const rankedMain = rankMainCandidates(query, direct, related, edgeProjection);
      const anchorMemoryIds = [
        ...new Set(direct.slice(0, limit).map((result) => result.memory.id)),
      ];
      const openAttachments =
        anchorMemoryIds.length === 0
          ? []
          : (
              this.db
                .prepare(
                  `SELECT DISTINCT m.id, m.node_id
                 FROM memory_records m, json_each(m.related_memory_ids_json) related
                 WHERE m.resolution IN ('open', 'reopened')
                   AND m.storage_state = 'indexed'
                   AND m.status IN ('active', 'disputed')
                   AND related.value IN (${anchorMemoryIds.map(() => "?").join(",")})
                   AND (? IS NULL OR m.source_actor = ?)
                   AND ((? IS NOT NULL AND (m.session_id IS NULL OR m.session_id = ?))
                     OR (? IS NULL AND m.session_id IS NULL))
                 ORDER BY m.importance DESC, m.opened_at DESC
                 LIMIT 2`,
                )
                .all(
                  ...anchorMemoryIds,
                  options.sourceActor ?? null,
                  options.sourceActor ?? null,
                  options.sessionId ?? null,
                  options.sessionId ?? null,
                  options.sessionId ?? null,
                ) as Row[]
            ).flatMap((row) =>
              this.resultsForNode(
                String(row.node_id),
                3,
                1,
                String(row.id),
                options.sourceActor,
                options.sessionId ?? null,
              ),
            );
      const attachmentIds = new Set(openAttachments.map((result) => result.memory.id));
      const mainWithoutAttachments = rankedMain.filter(
        (result) => !attachmentIds.has(result.memory.id),
      );
      // Open structures are a small, attributable side-channel: keep the main
      // ranking intact, then reserve at most two positions near the end of the
      // normal first window. They remain ordinary budgeted evidence and never
      // trigger a separate retrieval cascade.
      const attachmentOffset = Math.max(1, Math.min(6, limit - openAttachments.length));
      const rankedCandidates = [
        ...mainWithoutAttachments.slice(0, attachmentOffset),
        ...openAttachments,
        ...mainWithoutAttachments.slice(attachmentOffset),
      ];
      const rankedWarm = rankedCandidates.filter((candidate) => candidate.memory.tier === 1);
      const foldWarm =
        options.progressiveWarmDisclosure === true && rankedWarm.length >= MIN_WARM_DISCLOSURE_SIZE;
      const initiallyVisibleWarm = Math.ceil(rankedWarm.length / 2);
      const visibleWarmIds = new Set(
        rankedWarm.slice(0, initiallyVisibleWarm).map((candidate) => candidate.memory.id),
      );
      const deferredWarm = rankedWarm.slice(initiallyVisibleWarm);
      const candidates = foldWarm
        ? rankedCandidates.filter(
            (candidate) => candidate.memory.tier !== 1 || visibleWarmIds.has(candidate.memory.id),
          )
        : rankedCandidates;
      const selectWithinBudget = (
        bud: ActiveGraphBudget,
        lim: number,
        pool: readonly MemorySearchResult[] = candidates,
      ) => selectWithinActiveGraphBudget(pool, bud, lim);
      const deferredWarmSelection = foldWarm
        ? selectWithinBudget(budget, limit, deferredWarm).results
        : [];
      const directMemoryIds = new Set(direct.map((item) => item.memory.id));
      const buildSelections = (res: readonly MemorySearchResult[]): ActiveGraphSelection[] =>
        buildActiveGraphSelections(query, res, directMemoryIds, attachmentIds);
      let selection = selectWithinBudget(budget, limit);
      let activeBudget = budget;
      let selections = buildSelections(selection.results);
      let qppDecision = shouldTriggerSecondPass(
        query,
        qppCandidates(selection.results, selections),
        options.qppThreshold,
      );
      if (options.secondPass) {
        perf?.start(SECTION.secondPass);
        const maximum = expandActiveGraphBudget(budget);
        const stages = [];
        let stoppedBecause: NonNullable<QppTriggerDecision["expansion"]>["stoppedBecause"] =
          "budget_exhausted";
        // Fibonacci tiers replace the fixed first-pass limit: the loop starts at
        // the requested tier (default 1 = single evidence) and ascends 1, 2, 3,
        // 5, 8, ... until QPP says the evidence is sufficient, the caller's
        // `limit` hard cap is reached, or the expanded budget is exhausted.
        // `limit` therefore means "maximum recommended records", not "give me
        // exactly this many on the first pass".
        const fibonacciBudgets = fibonacciEvidenceBudgets(Math.min(50, maximum.maxEvidence));
        // limit was clamped to the *original* budget at entry (line ~114); the
        // hard cap must use the caller's requested limit so the walk can reach
        // the expanded budget (otherwise every expansion stops at the original
        // maxEvidence and the Fibonacci tiers never ascend).
        const requestedLimit = Math.max(1, Math.min(options.limit ?? 8, 50));
        const hardLimit = Math.max(1, Math.min(requestedLimit, maximum.maxEvidence));
        // Start the walk at the configured default (13: measured sweet spot)
        // instead of a single record. Only a real score cliff (relative
        // top1→top2 margin > STRONG_HIT_TOP_GAP) early-stops to 1-3 records —
        // top1 magnitude alone is not a reliable single-evidence signal.
        const requestedRaw = options.initialEvidenceTarget ?? DEFAULT_INITIAL_EVIDENCE_TARGET;
        const initialComponents = computeQppComponents(
          query,
          qppCandidates(selection.results, selections),
        );
        const strongHit =
          initialComponents.topGap >= (options.strongHitTopGap ?? STRONG_HIT_TOP_GAP);
        const requestedInitial = Math.max(
          1,
          Math.min(
            strongHit
              ? Math.min(options.strongHitInitialTarget ?? STRONG_HIT_INITIAL_TARGET, requestedRaw)
              : requestedRaw,
            maximum.maxEvidence,
          ),
        );
        const initialTarget =
          fibonacciBudgets.find((target) => target >= requestedInitial) ?? maximum.maxEvidence;
        for (const targetEvidence of fibonacciBudgets.filter((target) => target >= initialTarget)) {
          if (targetEvidence > hardLimit) break;
          // Relation expansion has already run at the original graph-hop budget.
          // Do not claim the extra hop from the hard envelope until graph routing
          // itself becomes progressive.
          activeBudget = {
            ...maximum,
            maxEvidence: targetEvidence,
            maxGraphHops: budget.maxGraphHops,
          };
          selection = selectWithinBudget(activeBudget, targetEvidence);
          selections = buildSelections(selection.results);
          qppDecision = shouldTriggerSecondPass(
            query,
            qppCandidates(selection.results, selections),
            options.qppThreshold,
          );
          stages.push({
            targetEvidence,
            selectedEvidence: selection.results.length,
            estimatedTokens: selection.estimatedTokens,
            qpp: qppDecision.qpp,
            trigger: qppDecision.trigger,
            reason: qppDecision.reason,
          });
          if (!qppDecision.trigger) {
            stoppedBecause = "sufficient";
            break;
          }
          if (selection.results.length >= candidates.length) {
            stoppedBecause = "candidate_pool_exhausted";
            break;
          }
        }
        qppDecision = {
          ...qppDecision,
          expansion: { strategy: "fibonacci", stages, stoppedBecause },
        };
        perf?.stop(SECTION.secondPass);
      }
      const { results, selectedNodes, estimatedTokens, exhausted } = selection;
      const projectedEdges = new Map(
        edgeProjection.edges.map((edge) => [edge.relationId, edge] as const),
      );
      const persistentEdges = perf
        ? perf.measure(SECTION.edges, () =>
            relations
              .filter(
                (relation) =>
                  selectedNodes.has(relation.sourceNodeId) &&
                  selectedNodes.has(relation.targetNodeId),
              )
              .slice(0, activeBudget.maxEdges)
              .map((relation) => ({
                id: relation.id,
                sourceNodeId: relation.sourceNodeId,
                targetNodeId: relation.targetNodeId,
                type: relation.type,
                persistence: "persistent" as const,
                stability: relation.stability,
                activation: projectedEdges.get(relation.id)?.activation ?? 0,
                activationChannel:
                  projectedEdges.get(relation.id)?.channel ?? relation.activationRule,
              })),
          )
        : relations
            .filter(
              (relation) =>
                selectedNodes.has(relation.sourceNodeId) &&
                selectedNodes.has(relation.targetNodeId),
            )
            .slice(0, activeBudget.maxEdges)
            .map((relation) => ({
              id: relation.id,
              sourceNodeId: relation.sourceNodeId,
              targetNodeId: relation.targetNodeId,
              type: relation.type,
              persistence: "persistent" as const,
              stability: relation.stability,
              activation: projectedEdges.get(relation.id)?.activation ?? 0,
              activationChannel:
                projectedEdges.get(relation.id)?.channel ?? relation.activationRule,
            }));
      const directSelectedNodeIds = [
        ...new Set(
          results
            .filter((result) => direct.some((item) => item.memory.id === result.memory.id))
            .map((result) => result.node.id),
        ),
      ];
      const temporaryEdges = queryAssociationEdges(
        directSelectedNodeIds,
        persistentEdges,
        activeBudget.maxEdges - persistentEdges.length,
      );
      const edges = [...persistentEdges, ...temporaryEdges];
      if (relations.length > persistentEdges.length || edges.length >= activeBudget.maxEdges) {
        exhausted.add("edges");
      }
      const topScores = direct.slice(0, 2).map((result) => result.combinedScore);
      const ambiguity = topScores.length < 2 ? 0 : 1 - clamp(topScores[0]! - topScores[1]!, 0, 1);
      const latencyMs = nowMs() - startedAt;
      if (latencyMs > activeBudget.maxLatencyMs) exhausted.add("latency");
      const usage: ActiveGraphBudgetUsage = {
        nodes: selectedNodes.size,
        edges: edges.length,
        evidence: results.length,
        estimatedTokens,
        graphHops,
        deepestTier: results.reduce<MemoryTier>(
          (deepest, result) => Math.max(deepest, result.memory.tier) as MemoryTier,
          0,
        ),
        tiersOpened: openedTiers.length,
        deepEvidence: results.filter((result) => result.memory.tier >= 2).length,
        latencyMs,
        exhausted: [...exhausted].sort(),
      };
      const expansions = activeGraphExpansions(directSelectedNodeIds, persistentEdges, graphHops);
      const budgetLedger = activeGraphBudgetLedger(activeBudget, usage);
      const taskId = options.taskId?.trim() || stableTaskId(query);
      // Summary-routing signal (diagnostic for IR + learnable router): which
      // nodes the coarse node-summary lexical/vector indexes matched and whether
      // they also reached the base retrieval result set (recalled). routed ∧
      // !recalled is the IR gap — the summary index saw it, base retrieval
      // missed it, and the later node-routed expansion rescued it. Computed
      // once here (before traceInput) and reused by the node-routed block
      // expansion below so the FTS route runs a single time per query.
      const nodeRouteIds: string[] = [];
      if (options.leafBlockRouting) {
        for (const hit of this.routeNodesByFts(query, 2)) {
          if (!nodeRouteIds.includes(hit.nodeId)) nodeRouteIds.push(hit.nodeId);
        }
        if (semantic) {
          for (const route of this.routeNodesByVector(semantic.queryVector, semantic.model, 2)) {
            if (!nodeRouteIds.includes(route.node.id)) nodeRouteIds.push(route.node.id);
          }
        }
      }
      const nodeRouteSignal: NodeRouteSignalItem[] = nodeRouteIds.map((nodeId) => ({
        nodeId,
        routed: true,
        recalled: results.some((result) => result.node.id === nodeId),
      }));
      const traceInput: RetrievalTraceInput = {
        sessionId: options.sessionId?.trim() || null,
        query,
        taskId,
        resultMemoryIds: results.map((result) => result.memory.id),
        resultNodeIds: results.map((result) => result.node.id),
        expandedNodeIds: relatedNodeIds,
        relationIds: persistentEdges.map((edge) => edge.id),
        ambiguity,
        fallbackUsed: direct.length === 0 || related.length > 0,
        conflictObserved:
          results.some((result) => result.memory.status === "disputed") ||
          relations.some((relation) => relation.type === "contradicts"),
        activeGraphBudget: budget,
        activeGraphUsage: usage,
        selections,
        expansions,
        budgetLedger,
        qpp: qppDecision,
        timings: perf?.snapshot(),
        filterUsage: filterUsage.dimensions.length > 0 ? filterUsage : undefined,
        nodeRouteSignal,
      };
      // A controller probe is a private planning artifact, not an interaction the
      // model could have used. Persisting it would pollute online-learning labels
      // and steadily grow the trace table with duplicate searches.
      const traceId = perf
        ? perf.measure(SECTION.trace, () =>
            options.persistTrace === false ? randomUUID() : this.recordRetrievalTrace(traceInput),
          )
        : options.persistTrace === false
          ? randomUUID()
          : this.recordRetrievalTrace(traceInput);
      // The INSERT above carried the pre-trace snapshot; patch the row with the
      // final snapshot so the persisted profile includes the trace span itself.
      perf?.setTotal(nowMs() - startedAt);
      const snapshot = perf?.snapshot();
      if (perf && options.persistTrace !== false) {
        this.db
          .prepare("UPDATE retrieval_traces SET timings_json = ? WHERE id = ?")
          .run(JSON.stringify(snapshot), traceId);
        this.recordPerfAggregates(snapshot);
      }
      const activeGraph: ActiveGraph = {
        id: traceId,
        sessionId: traceInput.sessionId ?? null,
        query,
        taskId,
        nodeIds: [...selectedNodes],
        memoryIds: results.map((result) => result.memory.id),
        edges,
        selections,
        expansions,
        budgetLedger,
        budget: activeBudget,
        usage,
        qpp: qppDecision,
        createdAt: new Date().toISOString(),
      };
      const context: MemoryContext = {
        results: results.map((result) => ({
          ...result,
          recallReason: recallReason(result),
          hitTerms: recallHitTerms(query, result),
        })),
        relations: persistentEdges.flatMap((edge) =>
          relations.filter((relation) => relation.id === edge.id),
        ),
        activeGraph,
        progressiveDisclosure: foldWarm
          ? {
              strategy: "warm_halves",
              rankedWarmCandidates: rankedWarm.length,
              initiallyVisible: initiallyVisibleWarm,
              deferredMemoryIds: deferredWarmSelection.map((candidate) => candidate.memory.id),
            }
          : undefined,
        timings: snapshot,
        filterUsage: filterUsage.dimensions.length > 0 ? filterUsage : undefined,
      };
      // Retrieval-time duplicate marking: a later result whose normalized
      // statement matches an earlier (higher-ranked) one points at the kept
      // record via duplicateOf. Callers may drop these for rendering.
      markDuplicateResults(context.results);
      // Shared character budget for the two appended (unranked) sections
      // below — chain expansion and block-member routing. This is a protocol
      // guarantee, not merely an eval setting: omitted callers receive the
      // same finite ceiling as explicit callers.
      const absoluteAppendedMaxChars = Math.max(
        0,
        Math.trunc(options.appendedMaxChars ?? DEFAULT_APPENDED_MAX_CHARS),
      );
      const primaryEvidenceChars = context.results.reduce(
        (total, result) => total + result.memory.statement.length,
        0,
      );
      const appendedMaxRatio = Math.max(
        0,
        Number.isFinite(options.appendedMaxRatio)
          ? Number(options.appendedMaxRatio)
          : DEFAULT_APPENDED_MAX_RATIO,
      );
      const relativeAppendedMaxChars = Math.trunc(
        DEFAULT_APPENDED_BASE_CHARS + primaryEvidenceChars * appendedMaxRatio,
      );
      const appendedMaxChars = Math.min(absoluteAppendedMaxChars, relativeAppendedMaxChars);
      let appendedChars = 0;
      const fitsAppendedBudget = (chars: number): boolean =>
        appendedChars + chars <= appendedMaxChars;
      const reserveAppendedBudget = (chars: number): boolean => {
        if (!fitsAppendedBudget(chars)) return false;
        appendedChars += chars;
        return true;
      };
      // Post-retrieval chain expansion: if any ranked result is a member of a
      // memory chain, append the chain's other members (in chain order) so
      // evolution/aggregation queries get the whole timeline, not just the
      // single most-similar record. Retrieval ranking is untouched — this is a
      // recall supplement on the evolution side (docs §3.1), never a re-rank.
      if (options.expandChains && context.results.length > 0) {
        const rankedMemoryIds = context.results.map((result) => result.memory.id);
        const placeholders = (count: number): string =>
          Array.from({ length: count }, () => "?").join(",");
        const directRows = this.db
          .prepare(
            `SELECT chain_id, memory_id, position FROM memory_chain_members
              WHERE memory_id IN (${placeholders(rankedMemoryIds.length)})`,
          )
          .all(...rankedMemoryIds) as Row[];
        const directChainIds = new Set(directRows.map((row) => String(row.chain_id)));
        const candidateChainIds = new Set(directChainIds);
        const chainOfExisting = new Map<string, Array<{ chainId: string; position: number }>>();
        const hitPositions = new Map<string, number[]>();
        const anchorMemoryIds = new Map<string, Set<string>>();
        for (const row of directRows) {
          const cid = String(row.chain_id);
          const memoryId = String(row.memory_id);
          const pos = Number(row.position);
          const memberships = chainOfExisting.get(memoryId) ?? [];
          memberships.push({ chainId: cid, position: pos });
          chainOfExisting.set(memoryId, memberships);
          const positions = hitPositions.get(cid) ?? [];
          positions.push(pos);
          hitPositions.set(cid, positions);
          const anchors = anchorMemoryIds.get(cid) ?? new Set<string>();
          anchors.add(memoryId);
          anchorMemoryIds.set(cid, anchors);
        }

        // A bounded recursive disclosure step over the chain-intersection graph:
        // chains sharing a memory with a direct hit chain are one-hop neighbours.
        // We intentionally never recurse from those neighbours, so C0 -> C1 is
        // possible but C0 -> C1 -> C2 is not.
        const maxChainHops = Math.max(
          0,
          Math.min(1, Math.trunc(options.chainExpansionMaxHops ?? 1)),
        );
        if (maxChainHops > 0 && directChainIds.size > 0) {
          const directIds = [...directChainIds];
          const adjacentRows = this.db
            .prepare(
              `SELECT DISTINCT adjacent.chain_id, adjacent.memory_id, adjacent.position
                 FROM memory_chain_members bridge
                 JOIN memory_chain_members adjacent ON adjacent.memory_id = bridge.memory_id
                WHERE bridge.chain_id IN (${placeholders(directIds.length)})
                  AND adjacent.chain_id != bridge.chain_id`,
            )
            .all(...directIds) as Row[];
          for (const row of adjacentRows) {
            const cid = String(row.chain_id);
            const memoryId = String(row.memory_id);
            candidateChainIds.add(cid);
            const positions = hitPositions.get(cid) ?? [];
            positions.push(Number(row.position));
            hitPositions.set(cid, positions);
            const anchors = anchorMemoryIds.get(cid) ?? new Set<string>();
            anchors.add(memoryId);
            anchorMemoryIds.set(cid, anchors);
          }
        }

        if (candidateChainIds.size > 0) {
          const candidateIds = [...candidateChainIds];
          const chainRows = this.db
            .prepare(
              `SELECT id, chain_type, topic FROM memory_chains
                WHERE id IN (${placeholders(candidateIds.length)}) AND status = 'active'`,
            )
            .all(...candidateIds) as Row[];
          const chainMeta = new Map<string, { chainType: MemoryChainType; topic: string | null }>();
          for (const row of chainRows) {
            chainMeta.set(String(row.id), {
              chainType: row.chain_type as MemoryChainType,
              topic: (row.topic as string | null) ?? null,
            });
          }
          const allMemberRows = this.db
            .prepare(
              `SELECT cm.chain_id, cm.memory_id, cm.position, m.statement, m.importance
                 FROM memory_chain_members cm
                 JOIN memory_records m ON m.id = cm.memory_id
                WHERE cm.chain_id IN (${placeholders(candidateIds.length)})
                ORDER BY cm.chain_id, cm.position`,
            )
            .all(...candidateIds) as Row[];
          const membersByChain = new Map<string, Row[]>();
          const memberIdsByChain = new Map<string, Set<string>>();
          for (const row of allMemberRows) {
            const cid = String(row.chain_id);
            const rows = membersByChain.get(cid) ?? [];
            rows.push(row);
            membersByChain.set(cid, rows);
            const ids = memberIdsByChain.get(cid) ?? new Set<string>();
            ids.add(String(row.memory_id));
            memberIdsByChain.set(cid, ids);
          }

          // Select chains with MMR: direct-hit strength and query/topic overlap
          // provide relevance; shared member IDs provide redundancy. This keeps
          // intersecting near-duplicates from consuming all disclosure slots.
          const maxChains = Math.max(
            1,
            Math.min(8, Math.trunc(options.chainExpansionMaxChains ?? 4)),
          );
          const queryTerms = queryOverlapTerms(query);
          const remaining = candidateIds.filter((id) => chainMeta.has(id));
          const selectedChainIds: string[] = [];
          const jaccard = (left: Set<string>, right: Set<string>): number => {
            let intersection = 0;
            for (const id of left) if (right.has(id)) intersection += 1;
            const union = left.size + right.size - intersection;
            return union === 0 ? 0 : intersection / union;
          };
          while (remaining.length > 0 && selectedChainIds.length < maxChains) {
            let bestIndex = 0;
            let bestScore = Number.NEGATIVE_INFINITY;
            for (let index = 0; index < remaining.length; index += 1) {
              const cid = remaining[index]!;
              const meta = chainMeta.get(cid)!;
              const relevance =
                (directChainIds.has(cid) ? 1 : 0.65) +
                0.1 * termOverlapScore(queryTerms, meta.topic ?? "");
              const redundancy = selectedChainIds.reduce(
                (highest, selected) =>
                  Math.max(
                    highest,
                    jaccard(
                      memberIdsByChain.get(cid) ?? new Set(),
                      memberIdsByChain.get(selected) ?? new Set(),
                    ),
                  ),
                0,
              );
              const score = 0.7 * relevance - 0.3 * redundancy;
              if (score > bestScore || (score === bestScore && cid < remaining[bestIndex]!)) {
                bestScore = score;
                bestIndex = index;
              }
            }
            selectedChainIds.push(remaining.splice(bestIndex, 1)[0]!);
          }
          const chainIds = new Set(selectedChainIds);
          const selectedMembershipsByMemory = new Map<
            string,
            Array<{ chainId: string; position: number }>
          >();
          for (const chainId of selectedChainIds) {
            for (const row of membersByChain.get(chainId) ?? []) {
              const memoryId = String(row.memory_id);
              const memberships = selectedMembershipsByMemory.get(memoryId) ?? [];
              memberships.push({ chainId, position: Number(row.position) });
              selectedMembershipsByMemory.set(memoryId, memberships);
            }
          }

          // Collect the DAG edges of every surfaced chain so the presentation
          // layer can render branching (`A --> B & C`) rather than a linear
          // position sequence. Adjacent in storage is not adjacency in the
          // graph — edges are the structure.
          const maxChainEdges = Math.max(
            0,
            Math.min(128, Math.trunc(options.chainExpansionMaxEdges ?? 64)),
          );
          const edgeRows =
            selectedChainIds.length === 0
              ? []
              : (this.db
                  .prepare(
                    `SELECT chain_id, source_memory_id, target_memory_id, edge_type
                     FROM memory_chain_edges
                    WHERE chain_id IN (${placeholders(selectedChainIds.length)})
                    ORDER BY chain_id, source_memory_id, target_memory_id
                    LIMIT ?`,
                  )
                  .all(...selectedChainIds, maxChainEdges) as Row[]);
          context.chainEdges = edgeRows.map((r) => ({
            chainId: String(r.chain_id),
            sourceMemoryId: String(r.source_memory_id),
            targetMemoryId: String(r.target_memory_id),
            edgeType: String(r.edge_type) as MemoryChainEdgeType,
          }));
          // Mark members already in the ranked results too, so callers can see
          // the whole chain surfaced (hit + expansion) rather than only the
          // appended part. A memory can belong to several chains — collect all
          // memberships; chainId mirrors the first for single-chain callers.
          for (const result of context.results) {
            const memberships = (chainOfExisting.get(result.memory.id) ?? []).filter((membership) =>
              chainIds.has(membership.chainId),
            );
            if (memberships && memberships.length > 0) {
              result.chainId = memberships[0].chainId;
              result.chainPosition = memberships[0].position;
              result.chainType = chainMeta.get(memberships[0].chainId)!.chainType;
              result.chainMemberships = memberships.map((ms) => ({
                chainId: ms.chainId,
                position: ms.position,
                chainType: chainMeta.get(ms.chainId)!.chainType,
                topic: chainMeta.get(ms.chainId)!.topic ?? undefined,
              }));
            }
          }
          const seen = new Set(context.results.map((result) => result.memory.id));
          const toFetch: string[] = [];
          const chainOf = new Map<string, string>();
          const chainPos = new Map<string, number>();
          // chainExpansionWindow: cap expansion to a window around the ranked
          // hit(s) — members with position in [minHit−window, maxHit+window]
          // are appended, so a long evolution chain does not blow the budget.
          // Without a window, expansion is activation-gated: a member is kept
          // when its activation reaches 0.5, where
          //   activation = 1/(1 + distance to nearest hit)      (proximity)
          //              + 1 if the member shares query terms    (relevance)
          //              + 0.5 × static importance               (prior)
          // Position proximity dominates because the chain's whole purpose is
          // rescuing evidence the query signal missed; gating on relevance
          // alone would filter out exactly those members. With the default
          // importance of 0.5 this behaves like a soft ±3 radius that query-
          // matching or high-importance members escape at any distance
          // (spreading activation, cf. HippoRAG's PPR — not a tuned window).
          const window = options.chainExpansionWindow;
          // Hard cap on appended members across all chains (activation mode
          // only; a window is already self-bounding): a recall supplement
          // should not exceed the primary evidence budget.
          const maxChainMembers = Math.max(
            0,
            Math.trunc(options.chainExpansionMaxMembers ?? context.results.length),
          );
          const chainQueryTerms = queryOverlapTerms(query);
          const activationTerms = window === undefined ? chainQueryTerms : null;
          const maxMemoryHops = Math.max(
            0,
            Math.min(8, Math.trunc(options.chainExpansionMaxMemoryHops ?? 2)),
          );
          interface ChainCandidate {
            id: string;
            chainIndex: number;
            pos: number;
            activation: number;
            dist: number;
            chars: number;
          }
          const dedupeChainCandidates = (candidates: ChainCandidate[]): ChainCandidate[] => {
            const byMemory = new Map<string, ChainCandidate>();
            for (const candidate of candidates) {
              const kept = byMemory.get(candidate.id);
              if (
                !kept ||
                candidate.activation > kept.activation ||
                (candidate.activation === kept.activation && candidate.dist < kept.dist) ||
                (candidate.activation === kept.activation &&
                  candidate.dist === kept.dist &&
                  candidate.chainIndex < kept.chainIndex)
              ) {
                byMemory.set(candidate.id, candidate);
              }
            }
            return [...byMemory.values()];
          };
          const gated: ChainCandidate[] = [];
          const windowed: ChainCandidate[] = [];
          const edgesByChain = new Map<string, Row[]>();
          for (const row of edgeRows) {
            const cid = String(row.chain_id);
            const rows = edgesByChain.get(cid) ?? [];
            rows.push(row);
            edgesByChain.set(cid, rows);
          }
          let chainIndex = 0;
          for (const chainId of chainIds) {
            const memberRows = membersByChain.get(chainId) ?? [];
            const hitPos = hitPositions.get(chainId) ?? [];
            const graphDistance = new Map<string, number>();
            if (
              chainMeta.get(chainId)?.chainType === "logical" &&
              (edgesByChain.get(chainId)?.length ?? 0) > 0
            ) {
              const adjacency = new Map<string, Set<string>>();
              for (const edge of edgesByChain.get(chainId) ?? []) {
                const source = String(edge.source_memory_id);
                const target = String(edge.target_memory_id);
                const sourceNeighbours = adjacency.get(source) ?? new Set<string>();
                sourceNeighbours.add(target);
                adjacency.set(source, sourceNeighbours);
                const targetNeighbours = adjacency.get(target) ?? new Set<string>();
                targetNeighbours.add(source);
                adjacency.set(target, targetNeighbours);
              }
              const queue = [...(anchorMemoryIds.get(chainId) ?? [])];
              for (const id of queue) graphDistance.set(id, 0);
              for (let cursor = 0; cursor < queue.length; cursor += 1) {
                const current = queue[cursor]!;
                const distance = graphDistance.get(current)!;
                if (distance >= maxMemoryHops) continue;
                for (const neighbour of adjacency.get(current) ?? []) {
                  if (graphDistance.has(neighbour)) continue;
                  graphDistance.set(neighbour, distance + 1);
                  queue.push(neighbour);
                }
              }
            }
            if (window !== undefined && hitPos.length > 0) {
              const lo = Math.min(...hitPos) - window;
              const hi = Math.max(...hitPos) + window;
              for (const row of memberRows) {
                const p = Number(row.position);
                if (p < lo || p > hi) continue;
                const memberId = String(row.memory_id);
                if (seen.has(memberId)) continue;
                const edgeDist = graphDistance.get(memberId);
                if (graphDistance.size > 0 && edgeDist === undefined) continue;
                const dist = edgeDist ?? Math.min(...hitPos.map((h) => Math.abs(p - h)));
                const activation =
                  1 / (1 + dist) +
                  (termOverlapScore(chainQueryTerms, String(row.statement)) > 0 ? 1 : 0) +
                  0.5 * (Number(row.importance) || 0);
                windowed.push({
                  id: memberId,
                  chainIndex,
                  pos: p,
                  activation,
                  dist,
                  chars: String(row.statement).length,
                });
              }
            } else if (activationTerms !== null && hitPos.length > 0) {
              for (const row of memberRows) {
                const memberId = String(row.memory_id);
                // Hits and already-surfaced members are not candidates —
                // they would only consume cap slots and be skipped at
                // emission time.
                if (seen.has(memberId)) continue;
                const p = Number(row.position);
                const edgeDist = graphDistance.get(memberId);
                if (graphDistance.size > 0 && edgeDist === undefined) continue;
                const dist = edgeDist ?? Math.min(...hitPos.map((h) => Math.abs(p - h)));
                const activation =
                  1 / (1 + dist) +
                  (termOverlapScore(activationTerms, String(row.statement)) > 0 ? 1 : 0) +
                  0.5 * (Number(row.importance) || 0);
                if (activation >= 0.5) {
                  gated.push({
                    id: memberId,
                    chainIndex,
                    pos: p,
                    activation,
                    dist,
                    chars: String(row.statement).length,
                  });
                }
              }
            } else {
              // No hit positions recorded (defensive; chainIds derive from
              // hits) — preserve the legacy whole-chain behavior.
              for (const row of memberRows) {
                const memberId = String(row.memory_id);
                if (!seen.has(memberId) && reserveAppendedBudget(String(row.statement).length)) {
                  seen.add(memberId);
                  toFetch.push(memberId);
                  chainOf.set(memberId, chainId);
                  chainPos.set(memberId, Number(row.position));
                }
              }
            }
            chainIndex += 1;
          }
          const uniqueWindowed = dedupeChainCandidates(windowed);
          const uniqueGated = dedupeChainCandidates(gated);
          if (uniqueWindowed.length > 0) {
            const admitted = new Set<string>();
            for (const candidate of [...uniqueWindowed].sort(
              (a, b) =>
                b.activation - a.activation ||
                a.dist - b.dist ||
                a.chainIndex - b.chainIndex ||
                a.pos - b.pos,
            )) {
              if (reserveAppendedBudget(candidate.chars)) admitted.add(candidate.id);
            }
            const chainList = selectedChainIds;
            for (const candidate of [...uniqueWindowed].sort(
              (a, b) => a.chainIndex - b.chainIndex || a.pos - b.pos,
            )) {
              if (!admitted.has(candidate.id) || seen.has(candidate.id)) continue;
              seen.add(candidate.id);
              toFetch.push(candidate.id);
              chainOf.set(candidate.id, chainList[candidate.chainIndex]!);
              chainPos.set(candidate.id, candidate.pos);
            }
          }
          if (activationTerms !== null && uniqueGated.length > 0) {
            // Over the cap: keep the highest-activation members (ties break
            // toward the hit, then chain order), but emit in chain order so
            // chronology survives for ordering questions.
            const survivors =
              uniqueGated.length > maxChainMembers
                ? [...uniqueGated]
                    .sort(
                      (a, b) =>
                        b.activation - a.activation ||
                        a.dist - b.dist ||
                        a.chainIndex - b.chainIndex ||
                        a.pos - b.pos,
                    )
                    .slice(0, maxChainMembers)
                : uniqueGated;
            const priorityOrder = [...survivors].sort(
              (a, b) =>
                b.activation - a.activation ||
                a.dist - b.dist ||
                a.chainIndex - b.chainIndex ||
                a.pos - b.pos,
            );
            const kept = new Set<string>();
            for (const candidate of priorityOrder) {
              if (reserveAppendedBudget(candidate.chars)) kept.add(candidate.id);
            }
            const chainList = selectedChainIds;
            for (const c of [...uniqueGated].sort(
              (a, b) => a.chainIndex - b.chainIndex || a.pos - b.pos,
            )) {
              if (!kept.has(c.id) || seen.has(c.id)) continue;
              seen.add(c.id);
              toFetch.push(c.id);
              chainOf.set(c.id, chainList[c.chainIndex]!);
              chainPos.set(c.id, c.pos);
            }
          }
          if (toFetch.length > 0) {
            const extra = this.getContext(toFetch, 0, options.sessionId);
            for (const result of extra.results) {
              const cid = chainOf.get(result.memory.id);
              const pos = chainPos.get(result.memory.id);
              const memberships = selectedMembershipsByMemory.get(result.memory.id) ?? [];
              context.results.push({
                ...result,
                chainId: cid,
                chainPosition: pos,
                chainType: cid ? chainMeta.get(cid)!.chainType : undefined,
                chainMemberships:
                  memberships.length > 0
                    ? memberships.map((membership) => ({
                        chainId: membership.chainId,
                        position: membership.position,
                        chainType: chainMeta.get(membership.chainId)!.chainType,
                        topic: chainMeta.get(membership.chainId)!.topic ?? undefined,
                      }))
                    : undefined,
              });
            }
          }
        }
      }
      // Leaf-block summary routing (opt-in): blocks whose LLM-written semantic
      // summary matches the query pull their members into the context verbatim,
      // appended after ranked results and chain expansions. The summary is an
      // index — matched against, never surfaced as a result — and the ranking
      // above is untouched (same contract as chain expansion, docs §3.1).
      if (options.leafBlockRouting) {
        const maxMembers = Math.max(1, Math.min(options.leafBlockRoutingMaxMembers ?? 12, 50));
        // Block hits come from the summary FTS index in every mode; with a
        // semantic query vector the leaf-embedding route adds blocks whose
        // summaries match semantically but share no terms with the query.
        const hitBlockIds: string[] = [];
        const pushHits = (ids: readonly string[]): void => {
          for (const id of ids) {
            if (!hitBlockIds.includes(id) && hitBlockIds.length < 3) hitBlockIds.push(id);
          }
        };
        pushHits(this.routeLeafBlocksByFts(query, 3).map((hit) => hit.blockId));
        if (semantic) {
          pushHits(
            this.routeLeafBlocksByVector(semantic.queryVector, semantic.model, [], 3).map(
              (route) => route.block.id,
            ),
          );
        }
        // Node summaries are the coarser index tier: a node hit enqueues up
        // to two of its blocks (largest first) behind the direct block hits.
        // Node-routed blocks expand even without their own leaf summary —
        // the node summary is the index that matched.
        const nodeRouted = new Set<string>();
        // nodeRouteSignal was computed earlier (before traceInput) to record
        // the routed-vs-recalled signal; reuse it so coarse summary routing
        // runs exactly once per query.
        const nodeHits = nodeRouteSignal.map((signal) => ({
          nodeId: signal.nodeId,
          score: 0,
        }));
        for (const nodeHit of nodeHits) {
          const nodeBlocks = this.db
            .prepare(
              `SELECT id FROM memory_leaf_blocks
                WHERE node_id = ? ORDER BY memory_count DESC, id ASC LIMIT 2`,
            )
            .all(nodeHit.nodeId) as Row[];
          for (const block of nodeBlocks) {
            const id = String(block.id);
            if (!hitBlockIds.includes(id)) nodeRouted.add(id);
            pushHits([id]);
          }
        }
        // Only summarized blocks expand on a direct hit — the semantic summary
        // is the index under test; structural-label blocks are not.
        const summarized = new Set(
          hitBlockIds.length === 0
            ? []
            : (
                this.db
                  .prepare(
                    `SELECT id FROM memory_leaf_blocks
                     WHERE semantic_summary IS NOT NULL
                       AND id IN (${hitBlockIds.map(() => "?").join(",")})`,
                  )
                  .all(...hitBlockIds) as Row[]
              ).map((row) => String(row.id)),
        );
        const expansions = hitBlockIds.filter((id) => summarized.has(id) || nodeRouted.has(id));
        if (expansions.length > 0) {
          const seen = new Set(context.results.map((result) => result.memory.id));
          // Noise control: within a hit block, members with query-term overlap
          // go first (score desc), ordinal order fills the per-block share;
          // the appended set is emitted in ordinal order so chronology
          // survives (event-ordering queries read order, not rank).
          const terms = queryOverlapTerms(query);
          const termScore = (statement: string): number => termOverlapScore(terms, statement);
          const perBlock = Math.max(2, Math.ceil(maxMembers / expansions.length));
          const toFetch: string[] = [];
          const blockOf = new Map<string, string>();
          for (const blockId of expansions) {
            const memberRows = this.db
              .prepare(
                `SELECT lm.memory_id, lm.ordinal, m.statement
                   FROM memory_leaf_members lm
                   JOIN memory_records m ON m.id = lm.memory_id
                  WHERE lm.block_id = ? ORDER BY lm.ordinal`,
              )
              .all(blockId) as Row[];
            const ranked = memberRows
              .map((row) => ({
                memoryId: String(row.memory_id),
                ordinal: Number(row.ordinal),
                score: termScore(String(row.statement)),
                chars: String(row.statement).length,
              }))
              .filter((member) => !seen.has(member.memoryId));
            const chosen = new Set(
              ranked
                .filter((member) => member.score > 0)
                .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
                .slice(0, perBlock)
                .map((member) => member.memoryId),
            );
            for (const member of ranked) {
              if (chosen.size >= perBlock) break;
              chosen.add(member.memoryId);
            }
            const budgeted = new Set<string>();
            for (const member of [...ranked]
              .filter((candidate) => chosen.has(candidate.memoryId))
              .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)) {
              if (reserveAppendedBudget(member.chars)) budgeted.add(member.memoryId);
            }
            for (const member of ranked) {
              if (toFetch.length >= maxMembers) break;
              if (!budgeted.has(member.memoryId)) continue;
              seen.add(member.memoryId);
              toFetch.push(member.memoryId);
              blockOf.set(member.memoryId, blockId);
            }
            if (toFetch.length >= maxMembers) break;
          }
          // Cross-block chain pull: ordering questions need the sequence that
          // continues past the hit block, but per-block expansion only surfaces
          // one block's members at a time. From each selected member, walk its
          // chains one step — explicit edge endpoints (DAG chains) and
          // position-adjacent members (member-only chains, e.g. eval chain
          // injection) — and append neighbors the per-block share cut away or
          // that live in other blocks, filling whatever budget the block
          // members left. Appended after ranking, same recall-supplement
          // contract as chain expansion (docs §3.1).
          const chainOf = new Map<
            string,
            { chainId: string; position: number; chainType: MemoryChainType }
          >();
          if (toFetch.length > 0 && toFetch.length < maxMembers) {
            const edgeQuery = this.db.prepare(
              `SELECT chain_id, source_memory_id, target_memory_id
                 FROM memory_chain_edges
                WHERE source_memory_id = ? OR target_memory_id = ?`,
            );
            const membershipQuery = this.db.prepare(
              "SELECT chain_id, position FROM memory_chain_members WHERE memory_id = ?",
            );
            const adjacentQuery = this.db.prepare(
              `SELECT memory_id, position FROM memory_chain_members
                WHERE chain_id = ? AND position IN (?, ?)`,
            );
            const positionQuery = this.db.prepare(
              `SELECT cm.position, m.statement
                 FROM memory_chain_members cm
                 JOIN memory_records m ON m.id = cm.memory_id
                WHERE cm.chain_id = ? AND cm.memory_id = ?`,
            );
            const chainTypeQuery = this.db.prepare(
              "SELECT chain_type FROM memory_chains WHERE id = ?",
            );
            const pull = (neighbor: string, chainId: string): void => {
              if (seen.has(neighbor) || toFetch.length >= maxMembers) return;
              const posRow = positionQuery.get(chainId, neighbor) as Row | undefined;
              if (!posRow || !reserveAppendedBudget(String(posRow.statement).length)) return;
              const typeRow = chainTypeQuery.get(chainId) as Row | undefined;
              seen.add(neighbor);
              toFetch.push(neighbor);
              chainOf.set(neighbor, {
                chainId,
                position: posRow ? Number(posRow.position) : 0,
                chainType: (typeRow?.chain_type as MemoryChainType) ?? "temporal",
              });
            };
            for (const memberId of [...toFetch]) {
              if (toFetch.length >= maxMembers) break;
              for (const edge of edgeQuery.all(memberId, memberId) as Row[]) {
                const neighbor =
                  String(edge.source_memory_id) === memberId
                    ? String(edge.target_memory_id)
                    : String(edge.source_memory_id);
                pull(neighbor, String(edge.chain_id));
              }
              for (const link of membershipQuery.all(memberId) as Row[]) {
                const position = Number(link.position);
                for (const adjacent of adjacentQuery.all(
                  String(link.chain_id),
                  position - 1,
                  position + 1,
                ) as Row[]) {
                  pull(String(adjacent.memory_id), String(link.chain_id));
                }
              }
            }
          }
          if (toFetch.length > 0) {
            for (const result of this.getContext(toFetch, 0, options.sessionId).results) {
              const chain = chainOf.get(result.memory.id);
              context.results.push({
                ...result,
                leafBlockId: blockOf.get(result.memory.id),
                ...(chain
                  ? {
                      chainId: chain.chainId,
                      chainPosition: chain.position,
                      chainType: chain.chainType,
                    }
                  : {}),
              });
            }
          }
        }
      }
      return context;
    }

    /**
     * Convenience wrapper for {@link searchContext} with `secondPass` enabled.
     * The progressive logic lives inside `searchContext`: start with the complete
     * Top-1 memory, then walk cumulative Fibonacci evidence tiers while QPP still
     * requests expansion. Every tier re-selects from the same over-sampled pool;
     * no ANN or lexical re-search occurs. This wrapper only provides explicit
     * opt-in.
     *
     * See docs/design/retrieval-confidence-controller.md §2 Stage 0.
     */
    searchContextWithSecondPass(
      query: string,
      options: SearchOptions = {},
      semantic?: { queryVector: readonly number[]; model: string },
    ): MemoryContext {
      return this.searchContext(
        query,
        { ...options, secondPass: options.secondPass ?? true },
        semantic,
      );
    }

    getContext(memoryIds: readonly string[], graphHops = 0, sessionId?: string): MemoryContext {
      const ids = [...new Set(memoryIds)].slice(0, 50);
      const findNode = this.db.prepare(
        "SELECT node_id FROM memory_records WHERE id = ? AND ((? IS NOT NULL AND (session_id IS NULL OR session_id = ?)) OR (? IS NULL AND session_id IS NULL))",
      );
      const results = ids.flatMap((memoryId) => {
        const sid = sessionId ?? null;
        const row = findNode.get(memoryId, sid, sid, sid) as Row | undefined;
        if (!row) return [];
        return this.resultsForNode(
          String(row.node_id),
          3,
          1,
          memoryId,
          undefined,
          sessionId ?? null,
        );
      });
      const resultIds = [...new Set(results.map((result) => result.memory.id))];
      const membershipsByMemory = new Map<
        string,
        Array<{
          chainId: string;
          position: number;
          chainType: MemoryChainType;
          topic?: string;
        }>
      >();
      const selectedChainIds = new Set<string>();
      if (resultIds.length > 0) {
        const bind = Array.from({ length: resultIds.length }, () => "?").join(",");
        const membershipRows = this.db
          .prepare(
            `SELECT cm.chain_id, cm.memory_id, cm.position, c.chain_type, c.topic
               FROM memory_chain_members cm
               JOIN memory_chains c ON c.id = cm.chain_id
              WHERE cm.memory_id IN (${bind})
                AND c.status = 'active'
              ORDER BY cm.memory_id, cm.chain_id, cm.position`,
          )
          .all(...resultIds) as Row[];
        for (const row of membershipRows) {
          const memoryId = String(row.memory_id);
          const chainId = String(row.chain_id);
          selectedChainIds.add(chainId);
          const memberships = membershipsByMemory.get(memoryId) ?? [];
          memberships.push({
            chainId,
            position: Number(row.position),
            chainType: row.chain_type as MemoryChainType,
            ...((row.topic as string | null) ? { topic: String(row.topic) } : {}),
          });
          membershipsByMemory.set(memoryId, memberships);
        }
        for (const result of results) {
          const memberships = membershipsByMemory.get(result.memory.id);
          if (!memberships || memberships.length === 0) continue;
          result.chainId = memberships[0]!.chainId;
          result.chainPosition = memberships[0]!.position;
          result.chainType = memberships[0]!.chainType;
          result.chainMemberships = memberships;
        }
      }
      const chainEdges =
        selectedChainIds.size === 0
          ? []
          : (
              this.db
                .prepare(
                  `SELECT chain_id, source_memory_id, target_memory_id, edge_type
                 FROM memory_chain_edges
                WHERE chain_id IN (${Array.from({ length: selectedChainIds.size }, () => "?").join(",")})
                  AND source_memory_id IN (${Array.from({ length: resultIds.length }, () => "?").join(",")})
                  AND target_memory_id IN (${Array.from({ length: resultIds.length }, () => "?").join(",")})
                ORDER BY rowid
                LIMIT 64`,
                )
                .all(...selectedChainIds, ...resultIds, ...resultIds) as Row[]
            ).map((row) => ({
              chainId: String(row.chain_id),
              sourceMemoryId: String(row.source_memory_id),
              targetMemoryId: String(row.target_memory_id),
              edgeType: String(row.edge_type) as MemoryChainEdgeType,
            }));
      const selectedNodeIds = [...new Set(results.map((result) => result.node.id))];
      const discoveredRelations = this.getRelations(selectedNodeIds, graphHops);
      const readableNodeIds = new Set(selectedNodeIds);
      for (const nodeId of new Set(
        discoveredRelations.flatMap((relation) => [relation.sourceNodeId, relation.targetNodeId]),
      )) {
        if (readableNodeIds.has(nodeId)) continue;
        if (this.resultsForNode(nodeId, 3, 1, undefined, undefined, sessionId ?? null).length > 0) {
          readableNodeIds.add(nodeId);
        }
      }
      return {
        results,
        ...(chainEdges.length > 0 ? { chainEdges } : {}),
        relations: discoveredRelations.filter(
          (relation) =>
            readableNodeIds.has(relation.sourceNodeId) &&
            readableNodeIds.has(relation.targetNodeId),
        ),
      };
    }

    residentKernel(limit = 4): MemoryContext {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.node_id
         FROM memory_records m
         JOIN memory_nodes n ON n.id = m.node_id
         WHERE m.memory_type = 'constraint'
           AND m.tier = 0
           AND m.storage_state = 'indexed'
           AND m.importance >= 0.8
           AND m.status = 'active'
           AND m.truth_status IN ('asserted', 'verified')
           AND m.source_actor IN ('user', 'tool', 'system')
           AND n.status = 'active'
         ORDER BY m.importance DESC, m.access_count DESC, m.created_at DESC
         LIMIT ?`,
        )
        .all(Math.max(0, Math.min(limit, 12))) as Row[];
      const byNode = new Map<string, MemorySearchResult[]>();
      const results = rows.flatMap((row) => {
        const nodeId = String(row.node_id);
        let nodeResults = byNode.get(nodeId);
        if (!nodeResults) {
          nodeResults = this.resultsForNode(nodeId, 0, 50);
          byNode.set(nodeId, nodeResults);
        }
        return nodeResults.filter((result) => result.memory.id === String(row.id));
      });
      return { results, relations: [] };
    }

    recallCues(query: string, options: SearchOptions = {}): RecallIndex {
      const cueLimit = Math.max(1, Math.min(options.limit ?? 5, 12));
      const candidates = this.search(query, {
        ...options,
        maxTier: 3,
        limit: 50,
      });
      const nodeIds = [...new Set(candidates.map((result) => result.node.id))].slice(0, cueLimit);
      const aggregate = this.db.prepare(
        `SELECT COUNT(*) AS active_count, MAX(created_at) AS newest_at,
                MAX(tier) AS deepest_tier,
                SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) AS conflicts,
                GROUP_CONCAT(DISTINCT memory_type) AS memory_types
         FROM memory_records
         WHERE node_id = ? AND status IN ('active', 'disputed')
           AND storage_state = 'indexed'`,
      );
      const cues: RecallCue[] = nodeIds.map((nodeId) => {
        const matches = candidates.filter((result) => result.node.id === nodeId);
        const best = matches[0]!;
        const row = aggregate.get(nodeId) as Row;
        const deepestTier = Number(row.deepest_tier ?? 0) as MemoryTier;
        return {
          nodeId,
          canonicalName: best.node.canonicalName,
          memoryTypes: String(row.memory_types ?? "")
            .split(",")
            .filter(Boolean) as MemoryRecord["memoryType"][],
          activeCount: Number(row.active_count ?? 0),
          newestAt: row.newest_at ? String(row.newest_at) : null,
          deepestTier,
          hasConflicts: Number(row.conflicts ?? 0) > 0,
          hasDeepMemory: deepestTier > 1,
          score: best.combinedScore,
          reason: recallReason(best),
        };
      });
      return { cues };
    }

    search(
      query: string,
      options: SearchOptions = {},
      filterUsage?: RetrievalFilterUsage,
    ): MemorySearchResult[] {
      return this.searchWithVector(
        query,
        this.embedder.embed(query),
        this.embedder.model,
        options,
        [],
        filterUsage,
      );
    }

    searchByVector(
      query: string,
      queryVector: readonly number[],
      model: string,
      options: SearchOptions = {},
      filterUsage?: RetrievalFilterUsage,
    ): MemorySearchResult[] {
      return this.searchWithVector(
        query,
        queryVector,
        model,
        {
          ...options,
          retrievalMode: options.retrievalMode ?? "qwen3",
        },
        [],
        filterUsage,
      );
    }

    searchByVectorCandidates(
      query: string,
      queryVector: readonly number[],
      model: string,
      candidateMemoryIds: string[],
      options: SearchOptions = {},
    ): MemorySearchResult[] {
      return this.searchWithVector(
        query,
        queryVector,
        model,
        {
          ...options,
          retrievalMode: options.retrievalMode ?? "qwen3",
        },
        [...new Set(candidateMemoryIds)].slice(0, 2_000),
      );
    }

    /** Lexical routing over the block semantic-summary FTS index. Only blocks
     *  carrying an LLM-written summary are indexed, so this returns [] unless
     *  a LeafSummaryProvider has run. FTS5 bm25 ranks lower-is-better; the
     *  negated score descends with relevance. */
    routeLeafBlocksByFts(query: string, limit = 3): Array<{ blockId: string; score: number }> {
      const expression = ftsExpression(query);
      if (!expression) return [];
      const rows = this.db
        .prepare(
          `SELECT block_id, bm25(memory_leaf_fts) AS rank
             FROM memory_leaf_fts
            WHERE memory_leaf_fts MATCH ?
            ORDER BY rank LIMIT ?`,
        )
        .all(expression, Math.max(1, Math.min(limit, 50))) as Row[];
      return rows.map((row) => ({ blockId: String(row.block_id), score: -Number(row.rank) }));
    }

    /** Lexical routing over the node semantic-summary FTS index (the coarser
     *  tier above leaf blocks). Only nodes carrying an LLM-written summary are
     *  indexed. FTS5 bm25 ranks lower-is-better; the negated score descends
     *  with relevance. */
    routeNodesByFts(query: string, limit = 2): Array<{ nodeId: string; score: number }> {
      const expression = ftsExpression(query);
      if (!expression) return [];
      const rows = this.db
        .prepare(
          `SELECT node_id, bm25(memory_node_fts) AS rank
             FROM memory_node_fts
            WHERE memory_node_fts MATCH ?
            ORDER BY rank LIMIT ?`,
        )
        .all(expression, Math.max(1, Math.min(limit, 10))) as Row[];
      return rows.map((row) => ({ nodeId: String(row.node_id), score: -Number(row.rank) }));
    }

    searchLeafBlocks(
      query: string,
      queryVector: readonly number[],
      model: string,
      blockIds: string[],
      options: SearchOptions = {},
      blockScores?: ReadonlyMap<string, number>,
    ): MemorySearchResult[] {
      const blocks = [...new Set(blockIds)].slice(0, 50);
      if (blocks.length === 0) return [];
      const rows = this.db
        .prepare(
          `SELECT memory_id FROM memory_leaf_members
         WHERE block_id IN (${blocks.map(() => "?").join(",")})
         ORDER BY block_id, ordinal LIMIT 2000`,
        )
        .all(...blocks) as Row[];
      const requestedLimit = Math.max(1, Math.min(options.limit ?? 8, 50));
      const results = this.searchWithVector(
        query,
        queryVector,
        model,
        {
          ...options,
          limit: blockScores ? 50 : requestedLimit,
          retrievalMode: "fts5",
        },
        rows.map((row) => String(row.memory_id)),
      );
      if (!blockScores) return results;
      const memberships = this.db
        .prepare(
          `SELECT memory_id, block_id FROM memory_leaf_members
         WHERE block_id IN (${blocks.map(() => "?").join(",")})`,
        )
        .all(...blocks) as Row[];
      const memoryScores = new Map(
        memberships.map((row) => [
          String(row.memory_id),
          blockScores.get(String(row.block_id)) ?? 0,
        ]),
      );
      for (const result of results) {
        const leafScore = memoryScores.get(result.memory.id) ?? 0;
        result.routeScore = leafScore;
        result.combinedScore = leafScore * 0.9 + result.lexicalScore * 0.1;
      }
      return results
        .sort((left, right) => right.combinedScore - left.combinedScore)
        .slice(0, requestedLimit);
    }

    searchHierarchyByVector(
      query: string,
      queryVector: readonly number[],
      model: string,
      options: SearchOptions = {},
    ): MemorySearchResult[] {
      const nodeLimit = Math.max(1, Math.min(options.nodeCandidateLimit ?? 5, 50));
      const blockLimit = Math.max(1, Math.min(options.leafCandidateLimit ?? 8, 50));
      const nodes = this.routeNodesByVector(queryVector, model, nodeLimit);
      const directLeaves = this.routeLeafBlocksByVector(queryVector, model, [], blockLimit);
      const routedLeaves = this.routeLeafBlocksByVector(
        queryVector,
        model,
        nodes.map((route) => route.node.id),
        blockLimit,
      );
      const leaves = [...directLeaves, ...routedLeaves]
        .filter(
          (route, index, all) =>
            all.findIndex((candidate) => candidate.block.id === route.block.id) === index,
        )
        .sort((left, right) => right.score - left.score)
        .slice(0, blockLimit);
      const indexed = this.searchLeafBlocks(
        query,
        queryVector,
        model,
        leaves.map((route) => route.block.id),
        options,
        new Map(leaves.map((route) => [route.block.id, route.score])),
      );
      const lexical = this.searchWithVector(query, queryVector, model, {
        ...options,
        limit: Math.min(50, Math.max(options.limit ?? 8, 20)),
        retrievalMode: "fts5",
      });
      return [...indexed, ...lexical]
        .filter(
          (result, index, all) =>
            all.findIndex((candidate) => candidate.memory.id === result.memory.id) === index,
        )
        .sort((left, right) => contextUsefulness(query, right) - contextUsefulness(query, left))
        .slice(0, Math.max(1, Math.min(options.limit ?? 8, 50)));
    }

    searchNodeFirst(
      query: string,
      queryVector: readonly number[],
      model: string,
      nodeIds: string[],
      options: SearchOptions = {},
    ): MemorySearchResult[] {
      const selected = [...new Set(nodeIds)].slice(0, 50);
      if (selected.length === 0) return [];
      const ftsIds = this.ftsCandidatesInNodes(query, selected, MAX_SEARCH_CANDIDATES);
      const candidateIds =
        ftsIds.length > 0
          ? ftsIds
          : (
              this.db
                .prepare(
                  `SELECT id FROM memory_records
           WHERE node_id IN (${selected.map(() => "?").join(",")})
             AND tier <= ? AND status IN ('active', 'disputed')
             AND storage_state = 'indexed'
           ORDER BY tier ASC, importance DESC, access_count DESC, created_at DESC
           LIMIT ?`,
                )
                .all(...selected, options.maxTier ?? 1, MAX_SEARCH_CANDIDATES) as Row[]
            ).map((row) => String(row.id));
      return this.searchWithVector(
        query,
        queryVector,
        model,
        {
          ...options,
          retrievalMode: "fts5",
        },
        candidateIds,
      );
    }

    // Moved up from NmgStoreBase: every caller lives in this cluster, and it
    // calls routeNodes (graph) — keeping it in base forced the upward
    // routeNodes stub.
    protected searchWithVector(
      query: string,
      queryVector: readonly number[],
      vectorModel: string,
      options: SearchOptions,
      forcedCandidateIds: string[] = [],
      filterUsage?: RetrievalFilterUsage,
    ): MemorySearchResult[] {
      const normalizedQuery = normalize(query);
      if (!normalizedQuery) return [];

      const maxTier = options.maxTier ?? 1;
      const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
      const nodeName = options.nodeName ? this.resolveActiveNodeName(options.nodeName) : null;
      const retrievalMode = options.retrievalMode ?? "legacy";
      const ftsIds =
        retrievalMode === "fts5" || retrievalMode === "hybrid"
          ? this.ftsCandidates(query, MAX_SEARCH_CANDIDATES)
          : [];
      if (retrievalMode === "fts5" && ftsIds.length === 0 && forcedCandidateIds.length === 0) {
        return [];
      }
      const candidateIds = forcedCandidateIds.length > 0 ? forcedCandidateIds : ftsIds;
      const candidateClause =
        forcedCandidateIds.length > 0
          ? `AND m.id IN (${forcedCandidateIds.map(() => "?").join(",")})`
          : retrievalMode === "qwen3"
            ? "AND ve.vector_json IS NOT NULL"
            : retrievalMode === "fts5"
              ? `AND m.id IN (${ftsIds.map(() => "?").join(",")})`
              : retrievalMode === "hybrid" && ftsIds.length > 0
                ? `AND (m.id IN (${ftsIds.map(() => "?").join(",")}) OR m.id IN (
           SELECT id FROM memory_records ORDER BY tier ASC, importance DESC,
             access_count DESC, created_at DESC LIMIT ${MAX_SEARCH_CANDIDATES}
         ))`
                : "";
      const candidateOrder =
        forcedCandidateIds.length === 0 && retrievalMode === "hybrid" && ftsIds.length > 0
          ? `CASE WHEN m.id IN (${ftsIds.map(() => "?").join(",")}) THEN 0 ELSE 1 END,`
          : "";
      const rowLimit =
        forcedCandidateIds.length > 0
          ? forcedCandidateIds.length
          : retrievalMode === "qwen3"
            ? 1_000_000
            : retrievalMode === "fts5"
              ? ftsIds.length
              : MAX_SEARCH_CANDIDATES + ftsIds.length;
      // Scope filtering is pushed into SQL so scoring runs only on matching
      // rows (filter-then-score, not score-then-filter). One json_extract per
      // requested scope key; keys are emitted as quoted path segments
      // ($."key" — safe for dots and other JSON-legal key characters), values
      // parameterized — no injection surface.
      const scopeEntries = Object.entries(options.scope ?? {});
      const scopeClause =
        scopeEntries.length > 0
          ? `AND ${scopeEntries
              .map(([key]) => `json_extract(m.scope_json, '$."${key.replace(/["\\]/g, "")}"') = ?`)
              .join(" AND ")}`
          : "";
      const scopeParams = scopeEntries.map(([, value]) => value);
      const rows = this.db
        .prepare(
          `SELECT
           m.id AS m_id, m.node_id AS m_node_id,
           m.evidence_id AS m_evidence_id, m.statement AS m_statement,
           m.memory_type AS m_memory_type, m.state_key AS m_state_key,
           m.event_time AS m_event_time, m.source_actor AS m_source_actor,
           m.truth_status AS m_truth_status,
           m.confidence AS m_confidence,
           m.polarity AS m_polarity,
           m.predicate_key AS m_predicate_key, m.extract_method AS m_extract_method, m.claims_json AS m_claims_json,
           m.markers_json AS m_markers_json,
           m.scope_json AS m_scope_json, m.valid_from AS m_valid_from,
           m.valid_until AS m_valid_until, m.status AS m_status,
           m.resolution AS m_resolution, m.opened_at AS m_opened_at,
           m.related_memory_ids_json AS m_related_memory_ids_json,
           m.residence AS m_residence, m.session_id AS m_session_id, m.promoted_at AS m_promoted_at,
           m.expires_at AS m_expires_at,
           m.evidence_role AS m_evidence_role,
           m.supersedes_id AS m_supersedes_id,
           m.tier AS m_tier, m.importance AS m_importance,
           m.access_count AS m_access_count,
           m.last_accessed_at AS m_last_accessed_at,
           m.write_reason AS m_write_reason,
           m.write_source AS m_write_source,
           m.created_at AS m_created_at,
           n.id AS n_id, n.canonical_name AS n_canonical_name,
           n.kind AS n_kind, n.summary AS n_summary,
           n.created_at AS n_created_at, n.updated_at AS n_updated_at,
           n.status AS n_status, n.residence AS n_residence,
           ve.vector_json AS ve_vector_json,
           ve.vector_blob AS ve_vector_blob,
           h.id AS h_id, h.session_id AS h_session_id, h.role AS h_role,
           h.content AS h_content, h.source_message_id AS h_source_message_id,
           h.source_ref AS h_source_ref,
           h.created_at AS h_created_at
         FROM memory_records m
         JOIN memory_nodes n ON n.id = m.node_id
         JOIN history_records h ON h.id = m.evidence_id
         LEFT JOIN memory_embeddings ve ON ve.memory_id = m.id AND ve.model = ?
         WHERE m.tier <= ?
           AND m.storage_state = 'indexed'
           ${candidateClause}
           AND n.status = 'active'
           AND (? IS NULL OR n.canonical_name = ?)
           AND (? IS NULL OR m.source_actor = ?)
           AND (? = 1 OR m.status IN ('active', 'disputed', 'superseded'))
           AND ((? IS NOT NULL AND (m.session_id IS NULL OR m.session_id = ?)) OR (? IS NULL AND m.session_id IS NULL))
           AND (m.expires_at IS NULL OR m.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           AND (? IS NULL OR m.event_time >= ?)
           AND (? IS NULL OR m.event_time <= ?)
           ${scopeClause}
         ORDER BY ${candidateOrder} m.tier ASC, m.importance DESC,
                  m.access_count DESC, m.created_at DESC
         LIMIT ?`,
        )
        .all(
          vectorModel,
          maxTier,
          ...candidateIds,
          nodeName,
          nodeName,
          options.sourceActor ?? null,
          options.sourceActor ?? null,
          options.includeHistorical ? 1 : 0,
          options.sessionId ?? null,
          options.sessionId ?? null,
          options.sessionId ?? null,
          ...(forcedCandidateIds.length === 0 && retrievalMode === "hybrid" ? ftsIds : []),
          options.eventTimeFrom ?? null,
          options.eventTimeFrom ?? null,
          options.eventTimeTo ?? null,
          options.eventTimeTo ?? null,
          ...scopeParams,
          rowLimit,
        ) as Row[];

      const routes =
        retrievalMode === "fts5" || retrievalMode === "hashing" || retrievalMode === "qwen3"
          ? new Map<string, number>()
          : new Map(this.routeNodes(query, 20).map((route) => [route.node.id, route.score]));
      const filtered = rows
        .map((row) => {
          const lexical = lexicalScore(normalizedQuery, row);
          const vector = cosineSimilarity(queryVector, storedVector(row, "ve_"));
          const route = routes.get(String(row.m_node_id)) ?? 0;
          const result = mapSearchResult(row, lexical);
          result.vectorScore = retrievalMode === "fts5" ? 0 : vector;
          result.routeScore = route;
          result.combinedScore =
            retrievalMode === "fts5"
              ? lexical > 0
                ? lexical
                : forcedCandidateIds.length > 0
                  ? 0.001
                  : 0
              : retrievalMode === "hashing" ||
                  (retrievalMode === "qwen3" && vectorModel.toLowerCase().includes("qwen"))
                ? vector
                : hybridScore(lexical, vector, route);
          return result;
        })
        .filter((result) => matchesScope(result.memory.scope, options.scope))
        .filter((result) => result.combinedScore > 0)
        .sort(
          (left, right) =>
            right.combinedScore - left.combinedScore ||
            left.memory.tier - right.memory.tier ||
            right.memory.importance - left.memory.importance,
        );
      // Optional recency decay (caller-chosen, default off): dampen older
      // memories by 0.5^(age_days / half_life) so stale facts stop dominating
      // current-value queries. Memories without event_time are never touched.
      const decayHalfLife = options.recencyDecayHalfLifeDays;
      // Skip decay for as-of/historical queries (eventTimeTo set): there the
      // correct value is the one current AT that date, so damping old records
      // would be wrong. Decay is only a current-value bias.
      if (decayHalfLife !== undefined && decayHalfLife > 0 && !options.eventTimeTo) {
        const nowMs = Date.now();
        for (const result of filtered) {
          const eventMs = result.memory.eventTime
            ? Date.parse(result.memory.eventTime)
            : Number.NaN;
          if (Number.isNaN(eventMs)) continue;
          const ageDays = Math.max(0, (nowMs - eventMs) / 86_400_000);
          result.combinedScore *= Math.pow(0.5, ageDays / decayHalfLife);
        }
        filtered.sort(
          (left, right) =>
            right.combinedScore - left.combinedScore ||
            left.memory.tier - right.memory.tier ||
            right.memory.importance - left.memory.importance,
        );
      }
      // Temporal as-of ranking: a historical query (event-time window) asks for
      // the value that was current AT that date. The most relevant memories are
      // the ones whose event time is closest to the window's end (the
      // "as-of" moment) — a 2029 answer for an "as of 2033" question is worse
      // than a 2033 one even when lexical overlap favors the older record.
      // Conditional boost: only applied when the query carries an event-time
      // window (never for plain current-value queries), so it cannot skew
      // ordinary retrieval.
      const asOfMs = options.eventTimeTo ? Date.parse(String(options.eventTimeTo)) : null;
      if (asOfMs !== null && !Number.isNaN(asOfMs) && filtered.length > 1) {
        for (const result of filtered) {
          const eventMs = result.memory.eventTime ? Date.parse(result.memory.eventTime) : null;
          if (eventMs === null || Number.isNaN(eventMs)) continue;
          const distDays = Math.abs(eventMs - asOfMs) / 86_400_000;
          // Linear decay over a 2-year horizon: records within ~2 years of the
          // as-of moment get up to TEMPORAL_ASOF_BOOST; older records get none.
          const boost = Math.max(0, 1 - distDays / TEMPORAL_ASOF_DECAY_DAYS) * TEMPORAL_ASOF_BOOST;
          result.combinedScore += boost;
        }
        filtered.sort(
          (left, right) =>
            right.combinedScore - left.combinedScore ||
            left.memory.tier - right.memory.tier ||
            right.memory.importance - left.memory.importance,
        );
      }
      if (filterUsage) {
        // Measure before LIMIT: after = what survived scope+score filtering, not
        // what the limit truncated to.
        filterUsage.candidatesBefore = rows.length;
        filterUsage.candidatesAfter = filtered.length;
        filterUsage.selectivity = rows.length > 0 ? 1 - filtered.length / rows.length : 0;
      }
      // Supersession successor surfacing: a stale lexical hit is an anchor for
      // the version chain, not an answer. Resolve the full reverse chain to the
      // value current now (or at eventTimeTo), then materialize that exact row
      // even when its wording did not enter the original lexical/vector pool.
      // This also deduplicates A<-B<-C chains where several stale candidates
      // resolve to C. Explicit includeHistorical bypasses this projection.
      let surfacedResults = filtered;
      if (!options.includeHistorical) {
        const byId = new Map(filtered.map((result) => [result.memory.id, result]));
        const kept = new Map<string, MemorySearchResult>();
        const keepBest = (candidate: MemorySearchResult) => {
          const current = kept.get(candidate.memory.id);
          if (!current || candidate.combinedScore > current.combinedScore) {
            kept.set(candidate.memory.id, candidate);
          }
        };
        for (const result of filtered) {
          if (result.memory.status !== "superseded") {
            keepBest(result);
            continue;
          }
          const target = this.resolveSupersessionTarget(result.memory.id, options.eventTimeTo);
          if (!target || String(target.id) === result.memory.id) {
            // An orphaned stale row is never a current answer. It remains
            // recoverable through includeHistorical; for an as-of query the
            // seed itself can still be the correct historical value.
            if (options.eventTimeTo) keepBest(result);
            continue;
          }
          const targetId = String(target.id);
          const materialized =
            byId.get(targetId) ??
            this.resultsForNode(
              String(target.node_id),
              maxTier,
              1,
              targetId,
              options.sourceActor,
              options.sessionId ?? null,
              Boolean(options.eventTimeTo),
            )[0];
          if (!materialized || !matchesScope(materialized.memory.scope, options.scope)) {
            if (options.eventTimeTo) keepBest(result);
            continue;
          }
          keepBest({
            ...materialized,
            lexicalScore: Math.max(materialized.lexicalScore, result.lexicalScore),
            vectorScore: Math.max(materialized.vectorScore, result.vectorScore),
            routeScore: Math.max(materialized.routeScore, result.routeScore),
            combinedScore: Math.max(
              materialized.combinedScore,
              result.combinedScore + SUPERSEDE_SUCCESSOR_BOOST,
            ),
          });
        }
        surfacedResults = [...kept.values()].sort(
          (left, right) =>
            right.combinedScore - left.combinedScore ||
            left.memory.tier - right.memory.tier ||
            right.memory.importance - left.memory.importance,
        );
      }
      const results = surfacedResults.slice(0, limit);
      for (const result of results) {
        result.memory.evidenceIds = this.evidenceIds(result.memory.id);
        result.evidenceRecords = this.evidenceRecords(result.memory.evidenceIds);
      }
      return results;
    }

    private resolveSupersessionTarget(memoryId: string, eventTimeTo?: string): Row | undefined {
      const lineage = `
        WITH RECURSIVE lineage(id, node_id, status, event_time, created_at, depth, path) AS (
          SELECT id, node_id, status, event_time, created_at, 0, ',' || id || ','
          FROM memory_records WHERE id = ?
          UNION ALL
          SELECT m.id, m.node_id, m.status, m.event_time, m.created_at,
                 lineage.depth + 1, lineage.path || m.id || ','
          FROM memory_records m
          JOIN lineage ON m.supersedes_id = lineage.id
          WHERE lineage.depth < 256
            AND instr(lineage.path, ',' || m.id || ',') = 0
        )`;
      if (!eventTimeTo) {
        return this.db
          .prepare(
            `${lineage}
             SELECT id, node_id, status, event_time, created_at, depth
             FROM lineage
             WHERE depth > 0 AND status = 'active'
             ORDER BY COALESCE(event_time, created_at) DESC, created_at DESC, depth DESC
             LIMIT 1`,
          )
          .get(memoryId) as Row | undefined;
      }
      return this.db
        .prepare(
          `${lineage}
           SELECT id, node_id, status, event_time, created_at, depth
           FROM lineage
           WHERE status IN ('active', 'disputed', 'superseded')
             AND (event_time IS NULL OR event_time <= ?)
           ORDER BY CASE WHEN event_time IS NULL THEN 1 ELSE 0 END,
                    event_time DESC, created_at DESC, depth DESC
           LIMIT 1`,
        )
        .get(memoryId, eventTimeTo) as Row | undefined;
    }
  };
}
