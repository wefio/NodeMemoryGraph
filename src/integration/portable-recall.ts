import { randomUUID } from "node:crypto";
import {
  activeGraphBudget,
  activeGraphBudgetLedger,
  activeGraphExpansions,
  estimateResultTokens,
  selectWithinActiveGraphBudget,
  stableTaskId,
} from "../core/store/active-graph.ts";
import type { ActiveGraph, MemoryContext, MemoryTier } from "../core/types.ts";
import type { NmgSearchParams } from "../cli/protocol.ts";
import { shouldTriggerSecondPass } from "../core/qpp.ts";
import type { MemorySearchResult } from "../core/types.ts";

/** Apply the session graph budget to already-authorized engine results. */
export function portableRecallGraph(
  context: MemoryContext,
  input: NmgSearchParams,
  elapsedMs: number,
): MemoryContext & { activeGraph: ActiveGraph } {
  const budget = activeGraphBudget({ ...input, maxTier: input.maxTier ?? 3 });
  const limit = Math.min(input.limit ?? budget.maxEvidence, budget.maxEvidence);
  const { candidates, openedTiers, qpp } = openRecallTiers(
    context.results,
    input,
    budget.maxLocalTier,
  );
  const { results, selectedNodes, estimatedTokens, exhausted } = selectWithinActiveGraphBudget(
    candidates,
    budget,
    limit,
  );
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
    results,
    relations,
    tesserae: context.tesserae?.filter((item) => item.memoryId && visible.has(item.memoryId)),
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
  return { candidates, openedTiers: tier + 1, qpp };
}

function recallQuality(query: string, candidates: MemorySearchResult[]) {
  return shouldTriggerSecondPass(
    query,
    candidates.map((item) => ({
      strength: item.combinedScore,
      reason: item.recallReason ?? "lexical_match",
      memoryType: item.memory.memoryType,
      isDirect: !item.path?.length,
    })),
  );
}
