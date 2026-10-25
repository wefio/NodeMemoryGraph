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
import { SOURCE_EXCERPT_CHARS } from "../../integration/agent-surface.ts";

export const DEFAULT_ACTIVE_GRAPH_BUDGET: ActiveGraphBudget = {
  maxNodes: 8,
  maxEdges: 12,
  maxEvidence: 8,
  maxTokens: 2_000,
  maxGraphHops: 1,
  maxLocalTier: 1,
  maxTierBudget: 3,
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
    maxTierBudget: Math.max(
      0,
      Math.min(requested.maxTierBudget ?? DEFAULT_ACTIVE_GRAPH_BUDGET.maxTierBudget, 50),
    ),
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
    maxTierBudget: Math.min(budget.maxTierBudget * 2, 50),
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

/** Approximate cost of one result *as the evidence surface renders it*.
 *
 * The budget exists to bound what the reader receives, so it must charge the
 * rendered text and nothing else. Two charged items previously had no rendered
 * counterpart at all:
 *
 * - `node.summary` (~1.5k characters on LongMemEval) is node-level metadata the
 *   evidence surface never prints, and it is *shared* by every record of that
 *   node (~10 records per node on LongMemEval), so charging it per record
 *   multiplied it by the node's record count.
 * - `evidence.content` was charged in full while the surface prints at most
 *   `SOURCE_EXCERPT_CHARS` of it.
 *
 * Measured on LongMemEval user _17 that estimator charged 898 tokens/record
 * against 377 rendered, i.e. 2.38x, and the 6,000-token budget returned 6.7
 * records where the rendered cost allows 15.9 — the observed page averaged
 * 6.89 records and never reached the requested 20.
 *
 * The statement is charged in full because it is rendered in full; the details
 * line is approximated from the fields it prints. */
export function estimateResultTokens(result: MemorySearchResult): number {
  const memory = result.memory;
  const details =
    memory.id.length +
    result.node.canonicalName.length +
    memory.memoryType.length +
    memory.truthStatus.length +
    JSON.stringify(memory.scope).length +
    (memory.eventTime?.length ?? 0) +
    DETAILS_OVERHEAD_CHARS;
  const source =
    result.evidence.content.trim() === memory.statement.trim()
      ? 0
      : Math.min(result.evidence.content.length, SOURCE_EXCERPT_CHARS);
  const characters = memory.statement.length + details + source;
  return Math.max(1, Math.ceil(characters / 4));
}

/** Separators and labels the details line adds around its field values
 *  (`- `, `\n  `, `memory=`, `node=`, `type=`, `truth=`, `scope=`, `time=`, `; `). */
const DETAILS_OVERHEAD_CHARS = 64;

export interface ActiveGraphBudgetSelection {
  results: MemorySearchResult[];
  selectedNodes: Set<string>;
  estimatedTokens: number;
  exhausted: Set<ActiveGraphBudgetUsage["exhausted"][number]>;
}

/** Apply the hard AG envelope to an already ranked candidate list. */
export function selectWithinActiveGraphBudget(
  candidates: readonly MemorySearchResult[],
  budget: ActiveGraphBudget,
  limit: number,
): ActiveGraphBudgetSelection {
  const selectedNodes = new Set<string>();
  const results: MemorySearchResult[] = [];
  const exhausted = new Set<ActiveGraphBudgetUsage["exhausted"][number]>();
  let estimatedTokens = 0;
  let deepEvidence = 0;
  for (const candidate of candidates) {
    if (results.length >= limit) {
      exhausted.add("evidence");
      break;
    }
    if (!selectedNodes.has(candidate.node.id) && selectedNodes.size >= budget.maxNodes) {
      exhausted.add("nodes");
      continue;
    }
    if (candidate.memory.tier >= 2 && deepEvidence >= budget.maxTierBudget) {
      exhausted.add("deepEvidence");
      continue;
    }
    const candidateTokens = estimateResultTokens(candidate);
    if (results.length > 0 && estimatedTokens + candidateTokens > budget.maxTokens) {
      exhausted.add("tokens");
      continue;
    }
    results.push(candidate);
    selectedNodes.add(candidate.node.id);
    estimatedTokens += candidateTokens;
    if (candidate.memory.tier >= 2) deepEvidence += 1;
  }
  return { results, selectedNodes, estimatedTokens, exhausted };
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
    { dimension: "tiersOpened", limit: budget.maxLocalTier + 1, used: usage.tiersOpened },
    { dimension: "deepEvidence", limit: budget.maxTierBudget, used: usage.deepEvidence },
    { dimension: "latencyMs", limit: budget.maxLatencyMs, used: usage.latencyMs },
  ];
  return entries.map((entry) => ({
    ...entry,
    exhausted:
      exhausted.has(
        entry.dimension === "latencyMs"
          ? "latency"
          : entry.dimension === "deepEvidence"
            ? "deepEvidence"
            : (entry.dimension as "edges" | "evidence" | "nodes" | "tokens"),
      ) || entry.used >= entry.limit,
  }));
}
