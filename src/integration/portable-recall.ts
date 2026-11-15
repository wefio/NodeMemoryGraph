import { randomUUID } from "node:crypto";
import {
  activeGraphBudget,
  activeGraphBudgetLedger,
  activeGraphExpansions,
  estimateResultTokens,
  expandActiveGraphBudget,
  fibonacciEvidenceBudgets,
  selectWithinActiveGraphBudget,
  stableTaskId,
} from "../core/store/active-graph.ts";
import type {
  ActiveGraph,
  ActiveGraphBudget,
  MemoryContext,
  MemoryTier,
  QppTriggerDecision,
} from "../core/types.ts";
import type { NmgSearchParams } from "../cli/protocol.ts";
import {
  computeQppComponents,
  DEFAULT_INITIAL_EVIDENCE_TARGET,
  shouldTriggerSecondPass,
  STRONG_HIT_INITIAL_TARGET,
  STRONG_HIT_TOP_GAP,
} from "../core/qpp.ts";
import { MIN_WARM_DISCLOSURE_SIZE } from "../core/store/graph-policy.ts";
import { hybridScore } from "../core/store/search-ranking.ts";
import type { MemorySearchResult } from "../core/types.ts";

/** Apply the session graph budget to already-authorized engine results. */
export function portableRecallGraph(
  context: MemoryContext,
  input: NmgSearchParams,
  elapsedMs: number,
): MemoryContext & { activeGraph: ActiveGraph } {
  const originalBudget = activeGraphBudget({ ...input, maxTier: input.maxTier ?? 3 });
  const limit = Math.min(input.limit ?? originalBudget.maxEvidence, originalBudget.maxEvidence);
  const { candidates, openedTiers } = openRecallTiers(
    context.results,
    input,
    originalBudget.maxLocalTier,
  );
  const disclosed = foldWarmEvidence(candidates, input, originalBudget, limit);
  const { selection, budget, qpp } = selectRecallEvidence(
    disclosed.candidates,
    input,
    originalBudget,
    limit,
  );
  const { results, selectedNodes, estimatedTokens, exhausted } = selection;
  const relations = (context.relations ?? [])
    .filter((edge) => selectedNodes.has(edge.sourceNodeId) && selectedNodes.has(edge.targetNodeId))
    .slice(0, budget.maxEdges);
  const edges = relations.map((edge) => ({
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    type: edge.type,
    stability: edge.stability,
    persistence: "persistent" as const,
  }));
  const direct = results.filter((item) => !item.path?.length);
  const expansions = activeGraphExpansions(
    direct.map((item) => item.node.id),
    edges,
    budget.maxGraphHops,
  );
  if (elapsedMs > budget.maxLatencyMs) exhausted.add("latency");
  const usage = {
    nodes: selectedNodes.size,
    edges: edges.length,
    evidence: results.length,
    estimatedTokens,
    graphHops: Math.max(0, ...expansions.map(({ hop }) => hop)),
    deepestTier: Math.max(0, ...results.map((item) => item.memory.tier)) as MemoryTier,
    tiersOpened: openedTiers,
    deepEvidence: results.filter((item) => item.memory.tier >= 2).length,
    latencyMs: elapsedMs,
    exhausted: [...exhausted],
  };
  const memoryIds = results.map((item) => item.memory.id);
  const visible = new Set(memoryIds);
  return {
    ...context,
    progressiveDisclosure: disclosed.progressiveDisclosure,
    results,
    relations,
    chainEdges: context.chainEdges?.filter(
      (edge) => visible.has(edge.sourceMemoryId) && visible.has(edge.targetMemoryId),
    ),
    tesserae: context.tesserae?.filter(
      (item) => item.score !== undefined || (item.memoryId && visible.has(item.memoryId)),
    ),
    activeGraph: {
      id: randomUUID(),
      sessionId: input.sessionId ?? null,
      query: input.query,
      taskId: stableTaskId(input.query),
      createdAt: new Date().toISOString(),
      nodeIds: [...selectedNodes],
      memoryIds,
      edges,
      expansions,
      budget,
      usage,
      budgetLedger: activeGraphBudgetLedger(budget, usage),
      qpp,
      selections: results.map((item, index) => ({
        memoryId: item.memory.id,
        nodeId: item.node.id,
        source: item.path?.length ? "graph_expansion" : "direct",
        reason: item.recallReason ?? "lexical_match",
        tier: item.memory.tier,
        rank: index + 1,
        estimatedTokens: estimateResultTokens(item),
        scores: {
          lexical: item.lexicalScore,
          vector: item.vectorScore,
          route: item.routeScore,
          combined: item.combinedScore,
          usefulness: item.combinedScore,
        },
      })),
    },
  };
}

function openRecallTiers(
  results: MemorySearchResult[],
  input: NmgSearchParams,
  maxTier: MemoryTier,
) {
  const candidatesUpTo = (tier: number) => results.filter((item) => item.memory.tier <= tier);
  let tier = input.tieredDisclosure ? 0 : maxTier;
  let candidates = candidatesUpTo(tier);
  let qpp = recallQuality(input.query, candidates);
  while (tier < maxTier && qpp.trigger) {
    candidates = candidatesUpTo(++tier);
    qpp = recallQuality(input.query, candidates);
  }
  return { candidates, openedTiers: tier + 1 };
}

function recallQuality(query: string, candidates: MemorySearchResult[]) {
  return shouldTriggerSecondPass(query, qualityCandidates(candidates));
}

function qualityCandidates(candidates: readonly MemorySearchResult[]) {
  return candidates.map((item) => ({
    strength: hybridScore(item.lexicalScore, item.vectorScore, item.routeScore),
    reason: item.recallReason ?? "lexical_match",
    memoryType: item.memory.memoryType,
    isDirect: !item.path?.length,
  }));
}

function foldWarmEvidence(
  candidates: MemorySearchResult[],
  input: NmgSearchParams,
  budget: ActiveGraphBudget,
  limit: number,
) {
  const warm = candidates.filter((item) => item.memory.tier === 1);
  if (!input.progressiveWarmDisclosure || warm.length < MIN_WARM_DISCLOSURE_SIZE)
    return { candidates, progressiveDisclosure: undefined };
  const initiallyVisible = Math.ceil(warm.length / 2);
  const deferred = warm.slice(initiallyVisible);
  const deferredIds = new Set(deferred.map((item) => item.memory.id));
  const selection = selectWithinActiveGraphBudget(deferred, budget, limit);
  return {
    candidates: candidates.filter((item) => !deferredIds.has(item.memory.id)),
    progressiveDisclosure: {
      strategy: "warm_halves" as const,
      rankedWarmCandidates: warm.length,
      initiallyVisible,
      deferredMemoryIds: selection.results.map((item) => item.memory.id),
    },
  };
}

function selectRecallEvidence(
  candidates: MemorySearchResult[],
  input: NmgSearchParams,
  originalBudget: ActiveGraphBudget,
  limit: number,
) {
  let budget = originalBudget;
  let selection = selectWithinActiveGraphBudget(candidates, budget, limit);
  let qpp = recallQuality(input.query, selection.results);
  if (!input.secondPass) return { selection, budget, qpp };
  const maximum = expandActiveGraphBudget(originalBudget);
  const hardLimit = Math.min(input.limit ?? 8, maximum.maxEvidence);
  const initial = initialEvidenceTarget(input, selection.results);
  const targets = fibonacciEvidenceBudgets(Math.min(50, maximum.maxEvidence));
  const stages: NonNullable<QppTriggerDecision["expansion"]>["stages"] = [];
  let stoppedBecause: NonNullable<QppTriggerDecision["expansion"]>["stoppedBecause"] =
    "budget_exhausted";
  for (const target of targets.filter(
    (value) => value >= Math.min(initial, maximum.maxEvidence) && value <= hardLimit,
  )) {
    budget = { ...maximum, maxEvidence: target, maxGraphHops: originalBudget.maxGraphHops };
    selection = selectWithinActiveGraphBudget(candidates, budget, target);
    qpp = recallQuality(input.query, selection.results);
    stages.push({
      targetEvidence: target,
      selectedEvidence: selection.results.length,
      estimatedTokens: selection.estimatedTokens,
      qpp: qpp.qpp,
      trigger: qpp.trigger,
      reason: qpp.reason,
    });
    if (!qpp.trigger || selection.results.length >= candidates.length) {
      stoppedBecause = qpp.trigger ? "candidate_pool_exhausted" : "sufficient";
      break;
    }
  }
  return {
    selection,
    budget,
    qpp: { ...qpp, expansion: { strategy: "fibonacci" as const, stages, stoppedBecause } },
  };
}

function initialEvidenceTarget(input: NmgSearchParams, results: MemorySearchResult[]): number {
  const requested = input.initialEvidenceTarget ?? DEFAULT_INITIAL_EVIDENCE_TARGET;
  const { topGap } = computeQppComponents(input.query, qualityCandidates(results));
  return topGap >= (input.strongHitTopGap ?? STRONG_HIT_TOP_GAP)
    ? Math.min(requested, input.strongHitInitialTarget ?? STRONG_HIT_INITIAL_TARGET)
    : requested;
}
