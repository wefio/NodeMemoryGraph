import { createHash } from "node:crypto";

import type {
  ActiveGraph,
  ActiveGraphBudget,
  ActiveGraphBudgetLedgerEntry,
  ActiveGraphBudgetUsage,
  ActiveGraphExpansion,
  MemorySearchResult,
  MemoryTier,
  SearchOptions,
} from "../types.ts";
import { normalize } from "./search-ranking.ts";

const DEFAULT_ACTIVE_GRAPH_BUDGET: ActiveGraphBudget = {
  maxNodes: 8,
  maxEdges: 12,
  maxEvidence: 8,
  maxTokens: 2_000,
  maxGraphHops: 1,
  maxLocalTier: 1,
  maxLatencyMs: 250,
};

export function activeGraphBudget(options: SearchOptions): ActiveGraphBudget {
  const requested = options.activeGraphBudget ?? {};
  return {
    maxNodes: Math.max(1, Math.min(requested.maxNodes ?? DEFAULT_ACTIVE_GRAPH_BUDGET.maxNodes, 50)),
    maxEdges: Math.max(
      0,
      Math.min(requested.maxEdges ?? DEFAULT_ACTIVE_GRAPH_BUDGET.maxEdges, 100),
    ),
    maxEvidence: Math.max(
      1,
      Math.min(
        requested.maxEvidence ?? options.limit ?? DEFAULT_ACTIVE_GRAPH_BUDGET.maxEvidence,
        50,
      ),
    ),
    maxTokens: Math.max(
      64,
      Math.min(requested.maxTokens ?? DEFAULT_ACTIVE_GRAPH_BUDGET.maxTokens, 100_000),
    ),
    maxGraphHops: Math.max(
      0,
      Math.min(
        requested.maxGraphHops ?? options.graphHops ?? DEFAULT_ACTIVE_GRAPH_BUDGET.maxGraphHops,
        3,
      ),
    ),
    maxLocalTier: Math.max(
      0,
      Math.min(
        requested.maxLocalTier ?? options.maxTier ?? DEFAULT_ACTIVE_GRAPH_BUDGET.maxLocalTier,
        3,
      ),
    ) as MemoryTier,
    maxLatencyMs: Math.max(
      1,
      Math.min(requested.maxLatencyMs ?? DEFAULT_ACTIVE_GRAPH_BUDGET.maxLatencyMs, 60_000),
    ),
  };
}

export function stableTaskId(query: string): string {
  return `query:${createHash("sha256").update(normalize(query)).digest("hex").slice(0, 16)}`;
}

/**
 * Hard envelope for Stage 0 progressive recall: roughly double the
 * evidence/node/token budget, capped at operator limits. Fibonacci tiers walk
 * toward this ceiling instead of exposing the whole envelope at once.
 */
export function expandActiveGraphBudget(budget: ActiveGraphBudget): ActiveGraphBudget {
  return {
    maxNodes: Math.min(budget.maxNodes * 2, 50),
    maxEdges: Math.min(budget.maxEdges * 2, 100),
    maxEvidence: Math.min(budget.maxEvidence * 2, 50),
    maxTokens: Math.min(budget.maxTokens * 2, 100_000),
    maxGraphHops: Math.min(budget.maxGraphHops + 1, 3),
    maxLocalTier: budget.maxLocalTier,
    maxLatencyMs: Math.min(budget.maxLatencyMs * 2, 60_000),
  };
}

/** Cumulative progressive-recall budgets. Top-1 is the first Fibonacci tier;
 * the duplicate second 1 is omitted because it would perform no new read. */
export function fibonacciEvidenceBudgets(maxEvidence: number): number[] {
  const limit = Math.max(1, Math.floor(maxEvidence));
  const budgets = [1];
  let previous = 1;
  let current = 2;
  while (current < limit) {
    budgets.push(current);
    [previous, current] = [current, previous + current];
  }
  if (budgets.at(-1) !== limit) budgets.push(limit);
  return budgets;
}

export function estimateResultTokens(result: MemorySearchResult): number {
  const characters =
    result.memory.statement.length +
    result.node.canonicalName.length +
    result.node.summary.length +
    result.evidence.content.length;
  return Math.max(1, Math.ceil(characters / 4));
}

export function queryAssociationEdges(
  nodeIds: string[],
  persistentEdges: ActiveGraph["edges"],
  limit: number,
): ActiveGraph["edges"] {
  if (limit <= 0) return [];
  const connected = new Set(
    persistentEdges.map((edge) => [edge.sourceNodeId, edge.targetNodeId].sort().join(":")),
  );
  const edges: ActiveGraph["edges"] = [];
  for (let left = 0; left < nodeIds.length && edges.length < limit; left += 1) {
    for (let right = left + 1; right < nodeIds.length && edges.length < limit; right += 1) {
      const pair = [nodeIds[left]!, nodeIds[right]!].sort();
      const key = pair.join(":");
      if (connected.has(key)) continue;
      edges.push({
        id: `temp:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
        sourceNodeId: pair[0]!,
        targetNodeId: pair[1]!,
        type: "query_association",
        persistence: "temporary",
        stability: 0,
      });
    }
  }
  return edges;
}

export function activeGraphExpansions(
  seedNodeIds: readonly string[],
  edges: ActiveGraph["edges"],
  maxHops: number,
): ActiveGraphExpansion[] {
  const visited = new Set(seedNodeIds);
  const traversedRelations = new Set<string>();
  let frontier = [...visited];
  const expansions: ActiveGraphExpansion[] = [];
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const edge of edges) {
      const sourceInFrontier = frontier.includes(edge.sourceNodeId);
      const targetInFrontier = frontier.includes(edge.targetNodeId);
      const target = sourceInFrontier
        ? edge.targetNodeId
        : targetInFrontier
          ? edge.sourceNodeId
          : null;
      if (!target || traversedRelations.has(edge.id)) continue;
      traversedRelations.add(edge.id);
      expansions.push({
        relationId: edge.id,
        sourceNodeId: sourceInFrontier ? edge.sourceNodeId : edge.targetNodeId,
        targetNodeId: target,
        hop,
      });
      if (!visited.has(target)) {
        visited.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  return expansions;
}

export function activeGraphBudgetLedger(
  budget: ActiveGraphBudget,
  usage: ActiveGraphBudgetUsage,
): ActiveGraphBudgetLedgerEntry[] {
  const exhausted = new Set(usage.exhausted);
  const entries: Array<Omit<ActiveGraphBudgetLedgerEntry, "exhausted">> = [
    { dimension: "nodes", limit: budget.maxNodes, used: usage.nodes },
    { dimension: "edges", limit: budget.maxEdges, used: usage.edges },
    { dimension: "evidence", limit: budget.maxEvidence, used: usage.evidence },
    { dimension: "tokens", limit: budget.maxTokens, used: usage.estimatedTokens },
    { dimension: "graphHops", limit: budget.maxGraphHops, used: usage.graphHops },
    { dimension: "localTier", limit: budget.maxLocalTier, used: usage.deepestTier },
    { dimension: "latencyMs", limit: budget.maxLatencyMs, used: usage.latencyMs },
  ];
  return entries.map((entry) => ({
    ...entry,
    exhausted:
      exhausted.has(
        entry.dimension === "latencyMs"
          ? "latency"
          : (entry.dimension as "edges" | "evidence" | "nodes" | "tokens"),
      ) || entry.used >= entry.limit,
  }));
}
