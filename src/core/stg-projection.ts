import { join } from "node:path";
import type { MemoryContext, RememberInput } from "./types.ts";
import { serializeScope } from "./scope.ts";

/**
 * STG v2 shared-store path: one file per project (docs/stg-shared-store-v2).
 * Session isolation moved from physical files to memory_records.session_id row
 * filtering; the sessionId parameter is retained for signature compatibility
 * but no longer participates in the path.
 */
export function stgStorePath(projectDir: string, _sessionId = "default"): string {
  return join(projectDir, ".nmg", "stg.sqlite");
}

export function stgConsolidationInput(result: MemoryContext["results"][number]): RememberInput {
  const { memory, node, evidence } = result;
  assertConsolidatable(memory);
  return {
    statement: memory.statement,
    nodeName: node.canonicalName,
    nodeSummary: node.summary,
    nodeKind: node.kind,
    memoryType: memory.memoryType,
    stateKey: memory.stateKey ?? undefined,
    eventTime: memory.eventTime ?? undefined,
    sourceActor: memory.sourceActor,
    truthStatus: memory.truthStatus,
    confidence: memory.confidence ?? undefined,
    polarity: memory.polarity ?? undefined,
    predicateKey: memory.predicateKey ?? undefined,
    extractMethod: memory.extractMethod ?? undefined,
    claims: memory.claims ?? undefined,
    markers: [
      ...memory.markers,
      {
        kind: "consolidated_from_stg",
        attributes: { sourceMemoryId: memory.id },
      },
    ],
    evidence: evidence.content,
    sourceRef: evidence?.sourceRef ?? undefined,
    tier: memory.tier,
    importance: memory.importance,
    scope: memory.scope,
    validFrom: memory.validFrom ?? undefined,
    validUntil: memory.validUntil ?? undefined,
    evidenceRole: memory.evidenceRole,
    residence: "ltg",
    writeReason: "stg_outcome_consolidation",
    writeSource: "automatic",
  };
}

function assertConsolidatable(memory: MemoryContext["results"][number]["memory"]): void {
  if (memory.residence !== "stg") throw new Error(`memory ${memory.id} is not resident in STG`);
  if (memory.markers.some((marker) => marker.kind === "cached_from_ltg")) {
    throw new Error(`memory ${memory.id} is a cached_from_ltg copy and cannot be consolidated`);
  }
}

/** Merge a project STG result with authoritative LTG results. */
export function mergeStgLtgContexts(local: MemoryContext, shared: MemoryContext): MemoryContext {
  // Merge: dedupe by cached sourceMemoryId; keep LTG rows (authoritative).
  const seenLtg = new Set(shared.results.map((result) => result.memory.id));
  const dedupedLocal = local.results.filter(
    (result) =>
      !result.memory.markers.some(
        (marker) =>
          marker.kind === "cached_from_ltg" &&
          seenLtg.has(String(marker.attributes?.sourceMemoryId ?? "")),
      ),
  );
  const results = reconcileStateVersions([...dedupedLocal, ...shared.results]);
  const activeGraph = mergeActiveGraphs(local.activeGraph, shared.activeGraph, results);
  const visibleMemoryIds = new Set(results.map((result) => result.memory.id));
  const chainEdges = [
    ...new Map(
      [...(local.chainEdges ?? []), ...(shared.chainEdges ?? [])]
        .filter(
          (edge) =>
            visibleMemoryIds.has(edge.sourceMemoryId) && visibleMemoryIds.has(edge.targetMemoryId),
        )
        .map((edge) => [
          `${edge.chainId}\0${edge.sourceMemoryId}\0${edge.targetMemoryId}\0${edge.edgeType}`,
          edge,
        ]),
    ).values(),
  ];
  return {
    results,
    ...(chainEdges.length > 0 ? { chainEdges } : {}),
    relations: [
      ...new Map(
        [...(local.relations ?? []), ...shared.relations].map((relation) => [
          relation.id,
          relation,
        ]),
      ).values(),
    ],
    activeGraph,
    retrieval: shared.retrieval,
    timings: shared.timings,
    filterUsage: shared.filterUsage,
  };
}

/**
 * STG and LTG are separate physical stores, so a new session-local state cannot
 * update the status column of an older consolidated LTG row transactionally.
 * Their runtime projection still must expose one current value per canonical
 * state key and scope. Time decides; LTG wins an exact tie because it is the
 * authoritative store. Historical filters have already been applied to each
 * input context before this reconciliation.
 */
function reconcileStateVersions(results: MemoryContext["results"]): MemoryContext["results"] {
  const winnerByState = new Map<string, MemoryContext["results"][number]>();
  for (const result of results) {
    if (result.memory.memoryType !== "state" || !result.memory.stateKey) continue;
    const key = `${result.memory.stateKey}\0${serializeScope(result.memory.scope)}`;
    const current = winnerByState.get(key);
    if (!current || compareStateRecency(result, current) > 0) winnerByState.set(key, result);
  }
  if (winnerByState.size === 0) return results;
  const winners = new Set([...winnerByState.values()].map((result) => result.memory.id));
  return results.filter(
    (result) =>
      result.memory.memoryType !== "state" ||
      !result.memory.stateKey ||
      winners.has(result.memory.id),
  );
}

function compareStateRecency(
  left: MemoryContext["results"][number],
  right: MemoryContext["results"][number],
): number {
  const timestamp = (result: MemoryContext["results"][number]) =>
    Date.parse(result.memory.validFrom ?? result.memory.eventTime ?? result.memory.createdAt);
  const timeDifference = timestamp(left) - timestamp(right);
  if (timeDifference !== 0) return timeDifference;
  return Number(left.memory.residence === "ltg") - Number(right.memory.residence === "ltg");
}

function mergeActiveGraphs(
  local: MemoryContext["activeGraph"],
  shared: MemoryContext["activeGraph"],
  results: MemoryContext["results"],
): MemoryContext["activeGraph"] {
  if (!local) return shared;
  if (!shared) return local;

  const memoryIds = results.map((result) => result.memory.id);
  const memorySet = new Set(memoryIds);
  const selections = [...local.selections, ...shared.selections]
    .filter((selection) => memorySet.has(selection.memoryId))
    .filter(
      (selection, index, all) =>
        all.findIndex((candidate) => candidate.memoryId === selection.memoryId) === index,
    )
    .sort((left, right) => memoryIds.indexOf(left.memoryId) - memoryIds.indexOf(right.memoryId))
    .map((selection, rank) => ({ ...selection, rank: rank + 1 }));
  const edges = [
    ...new Map([...local.edges, ...shared.edges].map((edge) => [edge.id, edge])).values(),
  ];
  const expansions = [
    ...new Map(
      [...local.expansions, ...shared.expansions].map((expansion) => [
        `${expansion.relationId}:${expansion.sourceNodeId}:${expansion.targetNodeId}:${expansion.hop}`,
        expansion,
      ]),
    ).values(),
  ];
  const nodeIds = [...new Set(selections.map((selection) => selection.nodeId))];
  const exhausted = [...new Set([...local.usage.exhausted, ...shared.usage.exhausted])];
  const budgetLedger = [
    ...new Map(
      [...local.budgetLedger, ...shared.budgetLedger].map((entry) => [entry.dimension, entry]),
    ).keys(),
  ].map((dimension) => {
    const entries = [...local.budgetLedger, ...shared.budgetLedger].filter(
      (entry) => entry.dimension === dimension,
    );
    const takeMaximum = dimension === "graphHops" || dimension === "localTier";
    return {
      dimension,
      limit: takeMaximum
        ? Math.max(...entries.map((entry) => entry.limit))
        : entries.reduce((sum, entry) => sum + entry.limit, 0),
      used: takeMaximum
        ? Math.max(...entries.map((entry) => entry.used))
        : entries.reduce((sum, entry) => sum + entry.used, 0),
      exhausted: entries.some((entry) => entry.exhausted),
    };
  });

  return {
    ...shared,
    nodeIds,
    memoryIds,
    edges,
    selections,
    expansions,
    budgetLedger,
    budget: {
      maxNodes: local.budget.maxNodes + shared.budget.maxNodes,
      maxEdges: local.budget.maxEdges + shared.budget.maxEdges,
      maxEvidence: local.budget.maxEvidence + shared.budget.maxEvidence,
      maxTokens: local.budget.maxTokens + shared.budget.maxTokens,
      maxGraphHops: Math.max(local.budget.maxGraphHops, shared.budget.maxGraphHops),
      maxLocalTier: Math.max(local.budget.maxLocalTier, shared.budget.maxLocalTier) as
        0 | 1 | 2 | 3,
      maxTierBudget: local.budget.maxTierBudget + shared.budget.maxTierBudget,
      maxLatencyMs: local.budget.maxLatencyMs + shared.budget.maxLatencyMs,
    },
    usage: {
      nodes: nodeIds.length,
      edges: edges.length,
      evidence: memoryIds.length,
      estimatedTokens: local.usage.estimatedTokens + shared.usage.estimatedTokens,
      graphHops: Math.max(local.usage.graphHops, shared.usage.graphHops),
      deepestTier: Math.max(local.usage.deepestTier, shared.usage.deepestTier) as 0 | 1 | 2 | 3,
      tiersOpened: local.usage.tiersOpened + shared.usage.tiersOpened,
      deepEvidence: local.usage.deepEvidence + shared.usage.deepEvidence,
      latencyMs: local.usage.latencyMs + shared.usage.latencyMs,
      exhausted,
    },
  };
}
