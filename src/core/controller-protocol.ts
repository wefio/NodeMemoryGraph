import {
  CONTROLLER_BUDGET_DIMENSIONS,
  type ControllerTrainingExample,
} from "./differentiable-controller.ts";
import type {
  ActiveGraphEdge,
  MemoryContext,
  MemorySearchResult,
  RetrievalTrace,
} from "./types.ts";

/**
 * Versioned, bounded feature contract shared by STG, LTG and the runtime Active Graph.
 * Every value is finite and normally in [0, 1], so a saved controller is meaningful only
 * together with this exact protocol version.
 */
export const CONTROLLER_FEATURE_PROTOCOL_VERSION = 1 as const;

export const CONTROLLER_FEATURE_NAMES = [
  "query_characters",
  "query_tokens",
  "stg_result_share",
  "stg_node_share",
  "stg_average_importance",
  "stg_average_tier",
  "ltg_result_share",
  "ltg_node_share",
  "ltg_average_importance",
  "ltg_average_tier",
  "disputed_share",
  "ag_nodes_used",
  "ag_edges_used",
  "ag_evidence_used",
  "ag_tokens_used",
  "ag_graph_hops_used",
  "ag_local_tier_used",
  "ag_latency_used",
  "ag_ambiguity",
  "ag_fallback",
  "ag_conflict",
  "candidate_present",
  "candidate_is_edge",
  "candidate_lexical",
  "candidate_vector",
  "candidate_route",
  "candidate_combined",
  "candidate_usefulness",
  "candidate_tier",
  "candidate_importance",
  "candidate_access_count",
  "candidate_stability",
] as const;

export const CONTROLLER_FEATURE_COUNT = CONTROLLER_FEATURE_NAMES.length;

export interface ControllerProtocolSample {
  version: typeof CONTROLLER_FEATURE_PROTOCOL_VERSION;
  traceId: string;
  globalFeatures: number[];
  nodeFeatures: Record<string, number[]>;
  edgeFeatures: Record<string, number[]>;
  training: ControllerTrainingExample | null;
  supervision: {
    usefulMemoryIds: string[];
    usefulNodeIds: string[];
    hasOutcomeFeedback: boolean;
  };
}

/** Convert one completed retrieval into controller inputs and, when feedback exists, labels. */
export function controllerSampleFromTrace(
  context: MemoryContext,
  trace: RetrievalTrace,
): ControllerProtocolSample {
  const resultsByNode = groupByNode(context.results);
  const globalFeatures = featureVector(context, trace);
  const nodeFeatures = Object.fromEntries(
    trace.resultNodeIds.map((nodeId) => [
      nodeId,
      featureVector(context, trace, nodeCandidate(resultsByNode.get(nodeId) ?? [])),
    ]),
  );
  const edgeFeatures = Object.fromEntries(
    (context.activeGraph?.edges ?? []).map((edge) => [
      edge.id,
      featureVector(context, trace, edgeCandidate(edge, resultsByNode)),
    ]),
  );
  const usefulMemoryIds = trace.usefulMemoryIds.filter((id) => trace.resultMemoryIds.includes(id));
  const usefulNodeIds = [
    ...new Set(
      context.results
        .filter((result) => usefulMemoryIds.includes(result.memory.id))
        .map((result) => result.node.id),
    ),
  ];
  const hasOutcomeFeedback =
    trace.usefulMemoryIds.length > 0 ||
    trace.rejectedMemoryIds.length > 0 ||
    trace.contradictedMemoryIds.length > 0;

  return {
    version: CONTROLLER_FEATURE_PROTOCOL_VERSION,
    traceId: trace.id,
    globalFeatures,
    nodeFeatures,
    edgeFeatures,
    training: hasOutcomeFeedback
      ? trainingExample(context, trace, globalFeatures, nodeFeatures, edgeFeatures, usefulMemoryIds)
      : null,
    supervision: { usefulMemoryIds, usefulNodeIds, hasOutcomeFeedback },
  };
}

interface CandidateFeatures {
  isEdge: boolean;
  lexical: number;
  vector: number;
  route: number;
  combined: number;
  usefulness: number;
  tier: number;
  importance: number;
  accessCount: number;
  stability: number;
}

function featureVector(
  context: MemoryContext,
  trace: RetrievalTrace,
  candidate?: CandidateFeatures,
): number[] {
  const results = context.results;
  const stg = results.filter((result) => result.memory.residence === "stg");
  const ltg = results.filter((result) => result.memory.residence === "ltg");
  const resultCount = Math.max(1, results.length);
  const nodeCount = Math.max(1, new Set(results.map((result) => result.node.id)).size);
  const usage = trace.activeGraphUsage;
  const budget = trace.activeGraphBudget;
  const values = [
    bounded(trace.query.length / 512),
    bounded(tokenCount(trace.query) / 64),
    stg.length / resultCount,
    uniqueNodes(stg) / nodeCount,
    average(stg.map((result) => result.memory.importance)),
    average(stg.map((result) => result.memory.tier / 3)),
    ltg.length / resultCount,
    uniqueNodes(ltg) / nodeCount,
    average(ltg.map((result) => result.memory.importance)),
    average(ltg.map((result) => result.memory.tier / 3)),
    results.filter((result) => result.memory.status === "disputed").length / resultCount,
    ratio(usage.nodes, budget.maxNodes),
    ratio(usage.edges, budget.maxEdges),
    ratio(usage.evidence, budget.maxEvidence),
    ratio(usage.estimatedTokens, budget.maxTokens),
    ratio(usage.graphHops, budget.maxGraphHops),
    ratio(usage.deepestTier, budget.maxLocalTier),
    ratio(usage.latencyMs, budget.maxLatencyMs),
    bounded(trace.ambiguity),
    Number(trace.fallbackUsed),
    Number(trace.conflictObserved),
    Number(Boolean(candidate)),
    Number(candidate?.isEdge ?? false),
    bounded(candidate?.lexical ?? 0),
    bounded(candidate?.vector ?? 0),
    bounded(candidate?.route ?? 0),
    bounded(candidate?.combined ?? 0),
    bounded(candidate?.usefulness ?? 0),
    bounded((candidate?.tier ?? 0) / 3),
    bounded(candidate?.importance ?? 0),
    bounded(Math.log1p(candidate?.accessCount ?? 0) / Math.log(1024)),
    bounded(candidate?.stability ?? 0),
  ];
  if (
    values.length !== CONTROLLER_FEATURE_COUNT ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("controller feature protocol produced an invalid vector");
  }
  return values;
}

function trainingExample(
  context: MemoryContext,
  trace: RetrievalTrace,
  globalFeatures: number[],
  nodeFeatures: Record<string, number[]>,
  edgeFeatures: Record<string, number[]>,
  usefulMemoryIds: string[],
): ControllerTrainingExample {
  const usefulSelections = trace.selections.filter((selection) =>
    usefulMemoryIds.includes(selection.memoryId),
  );
  const usefulNodeIds = new Set(usefulSelections.map((selection) => selection.nodeId));
  const usefulExpansionNodeIds = new Set(
    usefulSelections
      .filter((selection) => selection.source === "graph_expansion")
      .map((selection) => selection.nodeId),
  );
  const edges = context.activeGraph?.edges ?? [];
  const usefulEdges = new Set(
    edges
      .filter(
        (edge) => usefulNodeIds.has(edge.sourceNodeId) && usefulNodeIds.has(edge.targetNodeId),
      )
      .map((edge) => edge.id),
  );
  const budget = trace.activeGraphBudget;
  const usefulTokens = usefulSelections.reduce(
    (sum, selection) => sum + selection.estimatedTokens,
    0,
  );
  const usefulHops = trace.expansions
    .filter((expansion) => usefulExpansionNodeIds.has(expansion.targetNodeId))
    .reduce((maximum, expansion) => Math.max(maximum, expansion.hop), 0);
  const usefulTier = usefulSelections.reduce(
    (maximum, selection) => Math.max(maximum, selection.tier),
    0,
  );
  const budgetTargets = [
    ratio(usefulNodeIds.size, budget.maxNodes),
    ratio(usefulEdges.size, budget.maxEdges),
    ratio(usefulSelections.length, budget.maxEvidence),
    ratio(usefulTokens, budget.maxTokens),
    ratio(usefulHops, budget.maxGraphHops),
    ratio(usefulTier, budget.maxLocalTier),
    ratio(trace.activeGraphUsage.latencyMs, budget.maxLatencyMs),
  ];
  if (budgetTargets.length !== CONTROLLER_BUDGET_DIMENSIONS.length) {
    throw new Error("controller budget label shape does not match the controller");
  }
  return {
    nodes: balancedBinaryExamples(
      Object.entries(nodeFeatures).map(([nodeId, features]) => ({
        features,
        target: usefulNodeIds.has(nodeId),
      })),
    ),
    edges: balancedBinaryExamples(
      Object.entries(edgeFeatures).map(([edgeId, features]) => ({
        features,
        target: usefulEdges.has(edgeId),
      })),
    ),
    control: {
      features: globalFeatures,
      target: usefulExpansionNodeIds.size > 0 ? "expand" : "stop",
    },
    budget: { features: globalFeatures, targets: budgetTargets },
  };
}

/** Keep all positives and only the highest-ranked hard negatives to avoid trace-size imbalance. */
function balancedBinaryExamples(
  values: Array<{ features: number[]; target: boolean }>,
): Array<{ features: number[]; target: boolean }> {
  const positives = values.filter((value) => value.target);
  const negatives = values.filter((value) => !value.target);
  if (positives.length === 0) return negatives.slice(0, 3);
  return [...positives, ...negatives.slice(0, Math.max(3, positives.length * 3))];
}

function nodeCandidate(results: MemorySearchResult[]): CandidateFeatures {
  return {
    isEdge: false,
    lexical: maximum(results.map((result) => result.lexicalScore)),
    vector: maximum(results.map((result) => result.vectorScore)),
    route: maximum(results.map((result) => result.routeScore)),
    combined: maximum(results.map((result) => result.combinedScore)),
    usefulness: maximum(results.map((result) => result.combinedScore)),
    tier: minimum(results.map((result) => result.memory.tier)),
    importance: maximum(results.map((result) => result.memory.importance)),
    accessCount: maximum(results.map((result) => result.memory.accessCount)),
    stability: 0,
  };
}

function edgeCandidate(
  edge: ActiveGraphEdge,
  resultsByNode: Map<string, MemorySearchResult[]>,
): CandidateFeatures {
  const endpointResults = [
    ...(resultsByNode.get(edge.sourceNodeId) ?? []),
    ...(resultsByNode.get(edge.targetNodeId) ?? []),
  ];
  const base = nodeCandidate(endpointResults);
  return { ...base, isEdge: true, stability: edge.stability };
}

function groupByNode(results: MemorySearchResult[]): Map<string, MemorySearchResult[]> {
  const grouped = new Map<string, MemorySearchResult[]>();
  for (const result of results) {
    const values = grouped.get(result.node.id) ?? [];
    values.push(result);
    grouped.set(result.node.id, values);
  }
  return grouped;
}

function uniqueNodes(results: MemorySearchResult[]): number {
  return new Set(results.map((result) => result.node.id)).size;
}

function tokenCount(value: string): number {
  return value.match(/[\p{L}\p{N}_+.#-]+/gu)?.length ?? 0;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maximum(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function minimum(values: number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
}

function ratio(value: number, limit: number): number {
  return limit <= 0 ? 0 : bounded(value / limit);
}

function bounded(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
