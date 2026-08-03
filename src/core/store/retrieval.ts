/**
 * retrieval cluster of NmgStore methods — official TypeScript mixin pattern
 * (docs/store-cluster-split.md, cluster-dag.test.ts).
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
  stableTaskId,
} from "./active-graph.ts";
import { computeQppComponents, qppCandidates, shouldTriggerSecondPass } from "../qpp.ts";
import {
  DEFAULT_INITIAL_EVIDENCE_TARGET,
  STRONG_HIT_INITIAL_TARGET,
  STRONG_HIT_TOP_GAP,
} from "../qpp.ts";
import { propagateEdgeActivation } from "../edge-activation.ts";
import {
  contextUsefulness,
  hybridScore,
  mergeSemanticCandidates,
  recallReason,
  type StoreRow as Row,
} from "./search-ranking.ts";
import { clamp, effectiveFilterDimensions } from "./rows.ts";
import type {
  ActiveGraph,
  ActiveGraphBudget,
  ActiveGraphBudgetUsage,
  ActiveGraphSelection,
  LeafBlock,
  MemoryContext,
  MemoryRecord,
  MemorySearchResult,
  MemoryTier,
  NodeRelation,
  NodeRoute,
  QppTriggerDecision,
  RecallCue,
  RecallIndex,
  RetrievalFilterUsage,
  RetrievalTraceInput,
  SearchOptions,
  VectorEmbedder,
} from "../types.ts";
import type { DatabaseSync } from "node:sqlite";

const MAX_SEARCH_CANDIDATES = 500;
const MIN_WARM_DISCLOSURE_SIZE = 5;

export function withRetrieval<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    // Base-class and cross-cluster members (resolved at assembly time)
    declare protected db: DatabaseSync;
    declare protected embedder: VectorEmbedder;

    // graph cluster
    declare getRelations: (nodeIds: string[], maxHops?: number) => NodeRelation[];
    declare routeNodesByVector: (
      queryVector: readonly number[],
      model: string,
      limit?: number,
    ) => NodeRoute[];
    declare routeLeafBlocksByVector: (
      queryVector: readonly number[],
      model: string,
      nodeIds?: string[],
      limit?: number,
      candidateBlockIds?: string[],
    ) => Array<{ block: LeafBlock; score: number }>;

    // cross-cluster (maintenance / base)
    declare protected searchWithVector: (
      query: string,
      queryVector: readonly number[],
      model: string,
      options: SearchOptions,
      forcedCandidateIds?: string[],
      filterUsage?: RetrievalFilterUsage,
    ) => MemorySearchResult[];
    declare protected resultsForNode: (
      nodeId: string,
      maxTier: MemoryTier,
      limit: number,
      memoryId?: string,
      sourceActor?: string,
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
      const relations = perf
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
      const edgeProjection = propagateEdgeActivation(seedActivations, relations, {
        maxHops: graphHops,
      });
      const relatedNodeIds = [
        ...new Set(relations.flatMap((relation) => [relation.sourceNodeId, relation.targetNodeId])),
      ].filter((id) => !directNodeIds.has(id));
      const openedMaxTier = openedTiers.at(-1) ?? 0;
      const relatedRaw = perf
        ? perf.measure(SECTION.relatedExpansion, () =>
            relatedNodeIds.flatMap((nodeId) =>
              this.resultsForNode(nodeId, openedMaxTier, 2, undefined, options.sourceActor),
            ),
          )
        : relatedNodeIds.flatMap((nodeId) =>
            this.resultsForNode(nodeId, openedMaxTier, 2, undefined, options.sourceActor),
          );
      const related = relatedRaw.map((result) => {
        const edgeScore = edgeProjection.nodeActivations.get(result.node.id) ?? 0;
        if (edgeScore <= result.routeScore) return result;
        return {
          ...result,
          routeScore: edgeScore,
          combinedScore: hybridScore(result.lexicalScore, result.vectorScore, edgeScore),
        };
      });
      const rankedCandidates = [...direct, ...related]
        .filter(
          (result, index, all) =>
            all.findIndex((candidate) => candidate.memory.id === result.memory.id) === index,
        )
        .sort((left, right) => contextUsefulness(query, right) - contextUsefulness(query, left));
      const rankedWarm = rankedCandidates.filter((candidate) => candidate.memory.tier === 1);
      const foldWarm =
        options.progressiveWarmDisclosure === true &&
        rankedWarm.length >= MIN_WARM_DISCLOSURE_SIZE;
      const initiallyVisibleWarm = Math.ceil(rankedWarm.length / 2);
      const visibleWarmIds = new Set(
        rankedWarm.slice(0, initiallyVisibleWarm).map((candidate) => candidate.memory.id),
      );
      const deferredWarm = rankedWarm.slice(initiallyVisibleWarm);
      const candidates =
        foldWarm
          ? rankedCandidates.filter(
              (candidate) => candidate.memory.tier !== 1 || visibleWarmIds.has(candidate.memory.id),
            )
          : rankedCandidates;
      const selectWithinBudget = (
        bud: ActiveGraphBudget,
        lim: number,
        pool: readonly MemorySearchResult[] = candidates,
      ): {
        results: MemorySearchResult[];
        selectedNodes: Set<string>;
        estimatedTokens: number;
        exhausted: Set<ActiveGraphBudgetUsage["exhausted"][number]>;
      } => {
        const nodes = new Set<string>();
        const res: MemorySearchResult[] = [];
        let tokens = 0;
        let deepEvidence = 0;
        const ex = new Set<ActiveGraphBudgetUsage["exhausted"][number]>();
        for (const candidate of pool) {
          if (res.length >= lim) {
            ex.add("evidence");
            break;
          }
          if (!nodes.has(candidate.node.id) && nodes.size >= bud.maxNodes) {
            ex.add("nodes");
            continue;
          }
          if (candidate.memory.tier >= 2 && deepEvidence >= bud.maxTierBudget) {
            ex.add("deepEvidence");
            continue;
          }
          const candidateTokens = estimateResultTokens(candidate);
          if (res.length > 0 && tokens + candidateTokens > bud.maxTokens) {
            ex.add("tokens");
            continue;
          }
          res.push(candidate);
          nodes.add(candidate.node.id);
          tokens += candidateTokens;
          if (candidate.memory.tier >= 2) deepEvidence += 1;
        }
        return { results: res, selectedNodes: nodes, estimatedTokens: tokens, exhausted: ex };
      };
      const deferredWarmSelection =
        foldWarm
          ? selectWithinBudget(budget, limit, deferredWarm).results
          : [];
      const buildSelections = (res: readonly MemorySearchResult[]): ActiveGraphSelection[] =>
        res.map((result, index) => ({
          memoryId: result.memory.id,
          nodeId: result.node.id,
          source: direct.some((item) => item.memory.id === result.memory.id)
            ? "direct"
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
        const strongHit = initialComponents.topGap >= STRONG_HIT_TOP_GAP;
        const requestedInitial = Math.max(
          1,
          Math.min(
            strongHit ? Math.min(STRONG_HIT_INITIAL_TARGET, requestedRaw) : requestedRaw,
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
        results,
        relations: persistentEdges.flatMap((edge) =>
          relations.filter((relation) => relation.id === edge.id),
        ),
        activeGraph,
        progressiveDisclosure:
          foldWarm
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
     * See docs/retrieval-confidence-controller.md §2 Stage 0.
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

    getContext(memoryIds: readonly string[], graphHops = 0): MemoryContext {
      const ids = [...new Set(memoryIds)].slice(0, 50);
      const findNode = this.db.prepare("SELECT node_id FROM memory_records WHERE id = ?");
      const results = ids.flatMap((memoryId) => {
        const row = findNode.get(memoryId) as Row | undefined;
        if (!row) return [];
        return this.resultsForNode(String(row.node_id), 3, 1, memoryId);
      });
      return {
        results,
        relations: this.getRelations(
          [...new Set(results.map((result) => result.node.id))],
          graphHops,
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
  };
}
