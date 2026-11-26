import { createHash } from "node:crypto";
import { canonicalizeComputeValue } from "./canonical-value.ts";
import {
  INPUT_NODE_ID,
  type ComputeCostHint,
  type ComputeEdgeSpec,
  type ComputeLoweringDescriptor,
  type ComputeNodeSpec,
  type ComputeOperatorFn,
  type ComputeOperatorLookup,
  type RelationalQueryExpr,
  type ResolvedOperatorCapabilities,
  type StructuredComputeExpr,
} from "./compute-contracts.ts";
import { hasNamedResources } from "./resource-locks.ts";

export type LoweredTargetKind = "sqlite_pushdown" | "portable_scan" | "js_v8_fused";

export interface ComputeBackendCapabilities {
  readonly backendKind: "sqlite" | "js" | "portable" | "numeric" | "external";
  readonly supportedExprKinds: readonly string[];
  readonly supportedOperations: readonly string[];
  readonly supportsRegionFusion: boolean;
  readonly boundaryConversionCostMs: number;
}

export interface LoweringMatchContext {
  readonly specId: string;
  readonly nodes: readonly ComputeNodeSpec[];
  readonly edges: readonly ComputeEdgeSpec[];
  readonly output: string;
  readonly nodeById: ReadonlyMap<string, ComputeNodeSpec>;
  readonly incoming: ReadonlyMap<string, readonly ComputeEdgeSpec[]>;
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  readonly backendTarget?: "auto" | "sqlite" | "portable";
  readonly enableRegionLowering: boolean;
  readonly resolveOp: (node: ComputeNodeSpec) => string;
  readonly resolveCaps: (node: ComputeNodeSpec, op: string) => ResolvedOperatorCapabilities;
}

export interface LoweredRegionCandidate {
  readonly adapterId: string;
  readonly ruleId: string;
  readonly regionNodeIds: readonly string[];
  readonly exitNodeId: string;
  readonly replacementOp?: string;
  readonly loweredTarget: LoweredTargetKind;
  readonly expression?: StructuredComputeExpr;
  readonly estimatedLoweredMs: number;
  readonly estimatedBaselineMs: number;
}

export interface ComputeLoweringRule {
  readonly id: string;
  readonly description: string;
  readonly match: (context: LoweringMatchContext) => readonly LoweredRegionCandidate[];
}

export interface ComputeBackendAdapter {
  readonly id: string;
  readonly version: string;
  readonly priority: number;
  readonly capabilities: ComputeBackendCapabilities;
  readonly rules: readonly ComputeLoweringRule[];
}

export interface LoweringPassResult {
  readonly nodes: ComputeNodeSpec[];
  readonly edges: ComputeEdgeSpec[];
  readonly absorbedNodeIds: readonly string[];
  readonly regionTargetByExit: ReadonlyMap<
    string,
    {
      readonly loweredTarget: LoweredTargetKind;
      readonly expression?: StructuredComputeExpr;
      readonly regionNodeIds: readonly string[];
      readonly ruleId: string;
    }
  >;
  readonly loweredNodes: Map<string, LoweredTargetKind>;
}

const DEFAULT_COST_HINT_BASE_MS = 0.25;
const DEFAULT_JS_BOUNDARY_MS = 0.22;

function sha256Short(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function estimateNodeCostMs(
  hint: ComputeCostHint | undefined,
  items = 64,
  fallbackMs = DEFAULT_COST_HINT_BASE_MS,
): number {
  if (!hint) return fallbackMs;
  return (hint.baseMs ?? DEFAULT_COST_HINT_BASE_MS) + ((hint.perItemUs ?? 2) * items) / 1000;
}

function hasUnsafeLoweringEffect(
  node: ComputeNodeSpec,
  caps: ResolvedOperatorCapabilities,
): boolean {
  if (node.sideEffect || node.subgraph) return true;
  if (node.fn && !node.meta?.lowering && !node.expression) return true;
  return caps.effect === "write" || caps.effect === "opaque" || caps.effect === "nondeterministic";
}

function externalSuccessors(
  regionSet: ReadonlySet<string>,
  exitNodeId: string,
  outgoing: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  for (const target of outgoing.get(exitNodeId) ?? []) {
    if (!regionSet.has(target)) out.push(target);
  }
  return out;
}

function hasExternalReentryCycle(
  regionSet: ReadonlySet<string>,
  starts: readonly string[],
  outgoing: ReadonlyMap<string, readonly string[]>,
): boolean {
  const visited = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of outgoing.get(current) ?? []) {
      if (regionSet.has(next)) return true;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Verify single-exit dominance, DAG convexity, and effect/lock safety before collapsing a region. */
export function isLegalConvexRegion(
  regionNodeIds: readonly string[],
  exitNodeId: string,
  context: LoweringMatchContext,
): boolean {
  if (!regionNodeIds.length) return false;
  const regionSet = new Set(regionNodeIds);
  if (!regionSet.has(exitNodeId)) return false;

  for (const nodeId of regionSet) {
    const node = context.nodeById.get(nodeId);
    if (!node) return false;
    const op = context.resolveOp(node);
    const caps = context.resolveCaps(node, op);
    if (hasUnsafeLoweringEffect(node, caps)) return false;
    if (regionSet.size > 1 && hasNamedResources(caps.resources)) return false;
    if (nodeId !== exitNodeId) {
      if (nodeId === context.output) return false;
      const targets = context.outgoing.get(nodeId) ?? [];
      if (targets.some((t) => !regionSet.has(t))) return false;
    }
  }

  const starts = externalSuccessors(regionSet, exitNodeId, context.outgoing);
  return !hasExternalReentryCycle(regionSet, starts, context.outgoing);
}

/** Decide whether delegating a candidate region to its backend clears cost & conversion thresholds. */
export function shouldApplyLowering(
  candidate: LoweredRegionCandidate,
  adapter: ComputeBackendAdapter,
  costRatioThreshold = 1.0,
): boolean {
  if (!Number.isFinite(candidate.estimatedBaselineMs) || candidate.estimatedBaselineMs <= 0) {
    return candidate.loweredTarget !== "sqlite_pushdown";
  }
  const totalLowered = candidate.estimatedLoweredMs + adapter.capabilities.boundaryConversionCostMs;
  return totalLowered <= candidate.estimatedBaselineMs * costRatioThreshold;
}

function singleDefaultUpstreamNode(
  nodeId: string,
  context: LoweringMatchContext,
): ComputeNodeSpec | undefined {
  const edges = context.incoming.get(nodeId) ?? [];
  if (edges.length !== 1) return undefined;
  const edge = edges[0]!;
  if (edge.from === INPUT_NODE_ID || (edge.port ?? "default") !== "default") return undefined;
  return context.nodeById.get(edge.from);
}

function isPushdownDisabled(expr: StructuredComputeExpr | undefined): boolean {
  return expr?.kind === "relational_query" && expr.pushdownPreferred === false;
}

function matchesExitLowering(
  caps: ResolvedOperatorCapabilities,
  target: string,
  operation: string,
): boolean {
  return caps.lowering?.target === target && caps.lowering.operation === operation;
}

function matchesUpstreamFusion(
  lowering: ComputeLoweringDescriptor | undefined,
  upstream: ComputeNodeSpec,
  upOp: string,
  allowRelationalExpr: boolean,
): boolean {
  if (isPushdownDisabled(upstream.expression)) return false;
  if (lowering?.fusableWithUpstream?.includes(upstream.id)) return true;
  if (lowering?.fusableWithUpstream?.includes(upOp)) return true;
  return allowRelationalExpr && upstream.expression?.kind === "relational_query";
}

function matchSqliteProjectionTopology(context: LoweringMatchContext): LoweredRegionCandidate[] {
  if (context.backendTarget !== "sqlite" || !context.enableRegionLowering) return [];
  const matches: LoweredRegionCandidate[] = [];
  for (const exitNode of context.nodes) {
    const caps = context.resolveCaps(exitNode, context.resolveOp(exitNode));
    if (!matchesExitLowering(caps, "sqlite", "project_memories_with_topology")) continue;
    const upstream = singleDefaultUpstreamNode(exitNode.id, context);
    if (!upstream) continue;
    const upOp = context.resolveOp(upstream);
    if (!matchesUpstreamFusion(caps.lowering, upstream, upOp, true)) continue;
    const upCaps = context.resolveCaps(upstream, upOp);
    const baseMs =
      estimateNodeCostMs(upCaps.costHint, 128, 0.55) +
      estimateNodeCostMs(caps.costHint, 64, 0.45) +
      DEFAULT_JS_BOUNDARY_MS;
    matches.push({
      adapterId: "sqlite",
      ruleId: "sqlite.fuse_projection_topology",
      regionNodeIds: [upstream.id, exitNode.id],
      exitNodeId: exitNode.id,
      loweredTarget: "sqlite_pushdown",
      expression: {
        kind: "relational_query",
        operation: "project_memories_with_topology",
        pushdownPreferred: true,
        joins: ["nodes", "edges", "markers", "relations"],
      },
      estimatedLoweredMs: 0.35,
      estimatedBaselineMs: baseMs,
    });
  }
  return matches;
}

function matchSqliteUserProfileRegion(context: LoweringMatchContext): LoweredRegionCandidate[] {
  if (context.backendTarget !== "sqlite" || !context.enableRegionLowering) return [];
  const matches: LoweredRegionCandidate[] = [];
  for (const exitNode of context.nodes) {
    const caps = context.resolveCaps(exitNode, context.resolveOp(exitNode));
    if (!matchesExitLowering(caps, "sqlite", "user_profile_query")) continue;
    const upstream = singleDefaultUpstreamNode(exitNode.id, context);
    if (!upstream) continue;
    const upOp = context.resolveOp(upstream);
    if (!matchesUpstreamFusion(caps.lowering, upstream, upOp, false)) continue;
    const upCaps = context.resolveCaps(upstream, upOp);
    const baseMs =
      estimateNodeCostMs(upCaps.costHint, 128, 0.5) +
      estimateNodeCostMs(caps.costHint, 32, 0.35) +
      DEFAULT_JS_BOUNDARY_MS;
    matches.push({
      adapterId: "sqlite",
      ruleId: "sqlite.fuse_user_profile_region",
      regionNodeIds: [upstream.id, exitNode.id],
      exitNodeId: exitNode.id,
      loweredTarget: "sqlite_pushdown",
      expression: {
        kind: "relational_query",
        operation: "user_profile_query",
        pushdownPreferred: true,
        joins: ["nodes", "sources", "markers", "relations"],
      },
      estimatedLoweredMs: 0.25,
      estimatedBaselineMs: baseMs,
    });
  }
  return matches;
}

function sqliteCandidateOperation(
  node: ComputeNodeSpec,
  caps: ResolvedOperatorCapabilities,
): RelationalQueryExpr | undefined {
  if (node.expression?.kind === "relational_query") return node.expression;
  const lowering = caps.lowering;
  if (
    lowering?.target === "sqlite" &&
    lowering.exprKind === "relational_query" &&
    lowering.operation
  ) {
    return {
      kind: "relational_query",
      operation: lowering.operation as RelationalQueryExpr["operation"],
      pushdownPreferred: true,
    };
  }
  return undefined;
}

function allowsSqliteNodeLowering(
  backendTarget: LoweringMatchContext["backendTarget"],
  node: ComputeNodeSpec,
  caps: ResolvedOperatorCapabilities,
  expr: RelationalQueryExpr,
): boolean {
  if (backendTarget === "portable") return false;
  if (backendTarget !== "sqlite" && expr.pushdownPreferred === false) return false;
  if (backendTarget === "sqlite") return true;
  return caps.lowering?.target === "sqlite" || node.expression?.kind === "relational_query";
}

function matchSqliteRelationalNodes(context: LoweringMatchContext): LoweredRegionCandidate[] {
  const out: LoweredRegionCandidate[] = [];
  for (const node of context.nodes) {
    const caps = context.resolveCaps(node, context.resolveOp(node));
    if (caps.lowering?.fusableWithUpstream?.length) continue;
    const expr = sqliteCandidateOperation(node, caps);
    if (!expr || !allowsSqliteNodeLowering(context.backendTarget, node, caps, expr)) continue;
    const baseMs = estimateNodeCostMs(caps.costHint, 128, 0.6);
    out.push({
      adapterId: "sqlite",
      ruleId: "sqlite.lower_relational_node",
      regionNodeIds: [node.id],
      exitNodeId: node.id,
      loweredTarget: "sqlite_pushdown",
      expression: expr,
      estimatedLoweredMs: 0.2,
      estimatedBaselineMs: baseMs,
    });
  }
  return out;
}

function matchPortableRelationalNodes(context: LoweringMatchContext): LoweredRegionCandidate[] {
  const out: LoweredRegionCandidate[] = [];
  for (const node of context.nodes) {
    const caps = context.resolveCaps(node, context.resolveOp(node));
    if (caps.lowering?.fusableWithUpstream?.length) continue;
    const expr = sqliteCandidateOperation(node, caps);
    if (!expr) continue;
    out.push({
      adapterId: "portable",
      ruleId: "portable.fallback_relational_scan",
      regionNodeIds: [node.id],
      exitNodeId: node.id,
      loweredTarget: "portable_scan",
      expression: expr,
      estimatedLoweredMs: 0.4,
      estimatedBaselineMs: 0.45,
    });
  }
  return out;
}

export const SQLITE_BACKEND_ADAPTER: ComputeBackendAdapter = {
  id: "sqlite",
  version: "relational-v2",
  priority: 100,
  capabilities: {
    backendKind: "sqlite",
    supportedExprKinds: ["relational_query"],
    supportedOperations: [
      "project_memories",
      "project_memories_with_topology",
      "user_profile_query",
      "lexical_search_page",
      "ordered_get_page",
    ],
    supportsRegionFusion: true,
    boundaryConversionCostMs: 0.05,
  },
  rules: [
    {
      id: "sqlite.fuse_projection_topology",
      description: "Collapse memory projection + topology loading into one SQLite snapshot pass.",
      match: matchSqliteProjectionTopology,
    },
    {
      id: "sqlite.fuse_user_profile_region",
      description: "Collapse user profile scan + assembly into one filtered SQLite query.",
      match: matchSqliteUserProfileRegion,
    },
    {
      id: "sqlite.lower_relational_node",
      description: "Delegate single relational_query node execution to SQLite pushdown.",
      match: matchSqliteRelationalNodes,
    },
  ],
};

export const PORTABLE_BACKEND_ADAPTER: ComputeBackendAdapter = {
  id: "portable",
  version: "portable-v1",
  priority: 50,
  capabilities: {
    backendKind: "portable",
    supportedExprKinds: ["relational_query"],
    supportedOperations: [
      "project_memories",
      "project_memories_with_topology",
      "user_profile_query",
      "lexical_search_page",
      "ordered_get_page",
    ],
    supportsRegionFusion: false,
    boundaryConversionCostMs: 0.02,
  },
  rules: [
    {
      id: "portable.fallback_relational_scan",
      description: "Fallback relational_query execution onto snapshot port scan.",
      match: matchPortableRelationalNodes,
    },
  ],
};

export const JS_V8_BACKEND_ADAPTER: ComputeBackendAdapter = {
  id: "js_v8",
  version: "v8-slot-v1",
  priority: 40,
  capabilities: {
    backendKind: "js",
    supportedExprKinds: ["pure_pipeline"],
    supportedOperations: ["sync_slot_kernel", "fused_linear_chain"],
    supportsRegionFusion: true,
    boundaryConversionCostMs: 0.01,
  },
  rules: [],
};

/** Registry of pluggable execution backend adapters declaring capabilities and lowering rules. */
export class ComputeBackendRegistry {
  private readonly adapters = new Map<string, ComputeBackendAdapter>();

  constructor(initial: readonly ComputeBackendAdapter[] = []) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: ComputeBackendAdapter): this {
    if (!adapter.id.trim()) throw new Error("Backend adapter id must be non-empty");
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): ComputeBackendAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ComputeBackendAdapter[] {
    return [...this.adapters.values()].sort(
      (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
    );
  }

  supports(adapterId: string, exprKind: string, operation?: string): boolean {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return false;
    if (!adapter.capabilities.supportedExprKinds.includes(exprKind)) return false;
    if (!operation) return true;
    return adapter.capabilities.supportedOperations.includes(operation);
  }

  get versionSignature(): string {
    const parts = [...this.adapters.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => `${a.id}@${a.version}:${canonicalizeComputeValue(a.capabilities)}`);
    return sha256Short(parts.join("|"));
  }
}

export const DEFAULT_BACKEND_REGISTRY = new ComputeBackendRegistry([
  SQLITE_BACKEND_ADAPTER,
  PORTABLE_BACKEND_ADAPTER,
  JS_V8_BACKEND_ADAPTER,
]);

function orderedAdaptersForTarget(
  backendRegistry: ComputeBackendRegistry,
  backendTarget: "auto" | "sqlite" | "portable" | undefined,
): ComputeBackendAdapter[] {
  const all = backendRegistry.list();
  if (backendTarget === "portable") {
    return all.filter((a) => a.id !== "sqlite");
  }
  return all;
}

function canAcceptCandidate(
  candidate: LoweredRegionCandidate,
  consumedNodes: ReadonlySet<string>,
  exitTargetSet: ReadonlySet<string>,
): boolean {
  if (exitTargetSet.has(candidate.exitNodeId)) return false;
  return candidate.regionNodeIds.every((id) => !consumedNodes.has(id));
}

function collapseAcceptedRegions(
  nodes: readonly ComputeNodeSpec[],
  edges: readonly ComputeEdgeSpec[],
  accepted: readonly LoweredRegionCandidate[],
): {
  nodes: ComputeNodeSpec[];
  edges: ComputeEdgeSpec[];
  absorbedNodeIds: string[];
  regionTargetByExit: Map<
    string,
    {
      readonly loweredTarget: LoweredTargetKind;
      readonly expression?: StructuredComputeExpr;
      readonly regionNodeIds: readonly string[];
      readonly ruleId: string;
    }
  >;
  loweredNodes: Map<string, LoweredTargetKind>;
} {
  const absorbedSet = new Set<string>();
  const ownerExitByMember = new Map<string, string>();
  const regionTargetByExit = new Map<
    string,
    {
      readonly loweredTarget: LoweredTargetKind;
      readonly expression?: StructuredComputeExpr;
      readonly regionNodeIds: readonly string[];
      readonly ruleId: string;
    }
  >();
  const loweredNodes = new Map<string, LoweredTargetKind>();

  for (const item of accepted) {
    regionTargetByExit.set(item.exitNodeId, {
      loweredTarget: item.loweredTarget,
      expression: item.expression,
      regionNodeIds: item.regionNodeIds,
      ruleId: item.ruleId,
    });
    for (const memberId of item.regionNodeIds) {
      loweredNodes.set(memberId, item.loweredTarget);
      if (memberId !== item.exitNodeId) {
        absorbedSet.add(memberId);
        ownerExitByMember.set(memberId, item.exitNodeId);
      }
    }
  }

  const nextNodes = nodes
    .filter((node) => !absorbedSet.has(node.id))
    .map((node) => {
      const region = regionTargetByExit.get(node.id);
      if (!region) return node;
      return {
        ...node,
        ...(region.expression ? { expression: region.expression } : {}),
      };
    });

  const nextEdges: ComputeEdgeSpec[] = [];
  const seenEdge = new Set<string>();
  for (const edge of edges) {
    const mappedTo = ownerExitByMember.get(edge.to) ?? edge.to;
    const mappedFrom = ownerExitByMember.get(edge.from) ?? edge.from;
    if (mappedFrom === mappedTo) continue;
    const key = `${mappedFrom}->${mappedTo}:${edge.port ?? "default"}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    nextEdges.push({ ...edge, from: mappedFrom, to: mappedTo });
  }

  return {
    nodes: nextNodes,
    edges: nextEdges,
    absorbedNodeIds: [...absorbedSet],
    regionTargetByExit,
    loweredNodes,
  };
}

function adapterSupportsCandidate(
  adapter: ComputeBackendAdapter,
  candidate: LoweredRegionCandidate,
): boolean {
  const { expression } = candidate;
  if (!expression) return true;
  if (!adapter.capabilities.supportedExprKinds.includes(expression.kind)) return false;
  if (expression.kind !== "relational_query") return true;
  return adapter.capabilities.supportedOperations.includes(expression.operation);
}

function isCandidateEligible(
  candidate: LoweredRegionCandidate,
  adapter: ComputeBackendAdapter,
  context: LoweringMatchContext,
  consumedNodes: ReadonlySet<string>,
  exitSet: ReadonlySet<string>,
  threshold: number,
): boolean {
  return (
    canAcceptCandidate(candidate, consumedNodes, exitSet) &&
    adapterSupportsCandidate(adapter, candidate) &&
    isLegalConvexRegion(candidate.regionNodeIds, candidate.exitNodeId, context) &&
    shouldApplyLowering(candidate, adapter, threshold)
  );
}

/** Run declarative backend capability matching, convexity validation, and cost-aware lowering. */
export function runBackendLoweringPass(
  context: LoweringMatchContext,
  options: {
    readonly backendRegistry?: ComputeBackendRegistry;
    readonly costRatioThreshold?: number;
  },
): LoweringPassResult {
  const registry = options.backendRegistry ?? DEFAULT_BACKEND_REGISTRY;
  const threshold = options.costRatioThreshold ?? 1.0;
  const adapters = orderedAdaptersForTarget(registry, context.backendTarget);

  const accepted: LoweredRegionCandidate[] = [];
  const consumedNodes = new Set<string>();
  const exitSet = new Set<string>();

  for (const adapter of adapters) {
    for (const rule of adapter.rules) {
      for (const candidate of rule.match(context)) {
        if (!isCandidateEligible(candidate, adapter, context, consumedNodes, exitSet, threshold)) {
          continue;
        }
        accepted.push(candidate);
        exitSet.add(candidate.exitNodeId);
        for (const id of candidate.regionNodeIds) consumedNodes.add(id);
      }
    }
  }

  if (!accepted.length) {
    return {
      nodes: [...context.nodes],
      edges: [...context.edges],
      absorbedNodeIds: [],
      regionTargetByExit: new Map(),
      loweredNodes: new Map(),
    };
  }
  return collapseAcceptedRegions(context.nodes, context.edges, accepted);
}

// --- JS/V8 Backend Lowering: Monomorphic Slot-Indexed Sync DAG & Fused Chain Compilation ---

export interface LowerablePhysicalNode {
  readonly id: string;
  readonly op: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly incoming: readonly ComputeEdgeSpec[];
  readonly kind: "operator" | "subgraph" | "inline_fn" | "lowered_expression" | "fused_chain";
  readonly inlineFn?: ComputeOperatorFn<unknown>;
  readonly expression?: StructuredComputeExpr;
  readonly loweredTarget?: LoweredTargetKind;
  readonly requiresResourceLock?: boolean;
  readonly subgraphPlan?: LowerablePhysicalPlan;
  readonly fusedSteps?: readonly LowerablePhysicalNode[];
}

export interface LowerablePhysicalPlan {
  readonly outputNodeId: string;
  readonly order: readonly LowerablePhysicalNode[];
}

export type CompiledSyncKernel = (input: unknown, context: unknown) => unknown;

function isPromiseLikeValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function resolveStaticNodeParams(node: LowerablePhysicalNode): Readonly<Record<string, unknown>> {
  return node.expression
    ? { ...node.params, $loweredTarget: node.loweredTarget, $expression: node.expression }
    : node.params;
}

/** Pre-bind operator functions and parameter objects for a fused_chain without runtime Map lookups. */
export function compileFusedChainSyncRunner<TContext>(
  steps: readonly LowerablePhysicalNode[],
  registry: Pick<ComputeOperatorLookup<TContext>, "get">,
): (inputs: Record<string, unknown>, context: unknown) => unknown {
  const bound = steps.map((step) => ({
    id: step.id,
    op: step.op,
    fn: registry.get(step.op) as ComputeOperatorFn<unknown>,
    params: step.params,
  }));
  return (inputs, context) => {
    const first = bound[0]!;
    let val = first.fn(inputs, context, first.params);
    if (isPromiseLikeValue(val)) {
      throw new Error(`Sync compute graph encountered async node '${first.id}' (${first.op})`);
    }
    for (let i = 1; i < bound.length; i += 1) {
      const step = bound[i]!;
      val = step.fn({ default: val }, context, step.params);
      if (isPromiseLikeValue(val)) {
        throw new Error(`Sync compute graph encountered async node '${step.id}' (${step.op})`);
      }
    }
    return val;
  };
}

function planHasResourceLocks(plan: LowerablePhysicalPlan): boolean {
  for (const node of plan.order) {
    if (node.requiresResourceLock) return true;
    if (node.subgraphPlan && planHasResourceLocks(node.subgraphPlan)) return true;
  }
  return false;
}

type SlotInputBuilder = (slots: unknown[]) => Record<string, unknown>;

interface CompiledStep {
  readonly id: string;
  readonly op: string;
  readonly fn: ComputeOperatorFn<unknown>;
  readonly params: Readonly<Record<string, unknown>>;
  readonly readSlots: readonly number[];
  readonly buildInputs: SlotInputBuilder;
  readonly dstSlot: number;
  clearSlots: number[];
}

function resolveIncomingSlot(
  from: string,
  localSlots: ReadonlyMap<string, number>,
  inputSlot: number,
): number {
  return from === INPUT_NODE_ID ? inputSlot : localSlots.get(from)!;
}

function buildSlotInputGatherer(
  incoming: readonly ComputeEdgeSpec[],
  localSlots: ReadonlyMap<string, number>,
  inputSlot: number,
): { readSlots: number[]; buildInputs: SlotInputBuilder } {
  if (!incoming.length) {
    return { readSlots: [inputSlot], buildInputs: (slots) => ({ default: slots[inputSlot] }) };
  }
  if (incoming.length === 1) {
    const edge = incoming[0]!;
    const port = edge.port ?? "default";
    const src = resolveIncomingSlot(edge.from, localSlots, inputSlot);
    return { readSlots: [src], buildInputs: (slots) => ({ [port]: slots[src] }) };
  }
  if (incoming.length === 2) {
    const [e0, e1] = incoming;
    const p0 = e0!.port ?? "default";
    const p1 = e1!.port ?? "default";
    const s0 = resolveIncomingSlot(e0!.from, localSlots, inputSlot);
    const s1 = resolveIncomingSlot(e1!.from, localSlots, inputSlot);
    return {
      readSlots: [s0, s1],
      buildInputs: (slots) => ({ [p0]: slots[s0], [p1]: slots[s1] }),
    };
  }
  if (incoming.length === 3) {
    const [e0, e1, e2] = incoming;
    const p0 = e0!.port ?? "default";
    const p1 = e1!.port ?? "default";
    const p2 = e2!.port ?? "default";
    const s0 = resolveIncomingSlot(e0!.from, localSlots, inputSlot);
    const s1 = resolveIncomingSlot(e1!.from, localSlots, inputSlot);
    const s2 = resolveIncomingSlot(e2!.from, localSlots, inputSlot);
    return {
      readSlots: [s0, s1, s2],
      buildInputs: (slots) => ({ [p0]: slots[s0], [p1]: slots[s1], [p2]: slots[s2] }),
    };
  }
  const specs = incoming.map((edge) => ({
    port: edge.port ?? "default",
    slot: resolveIncomingSlot(edge.from, localSlots, inputSlot),
  }));
  return {
    readSlots: specs.map((s) => s.slot),
    buildInputs: (slots) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < specs.length; i += 1) {
        const sp = specs[i]!;
        obj[sp.port] = slots[sp.slot];
      }
      return obj;
    },
  };
}

interface FlattenCursor {
  nextSlot: number;
  readonly steps: CompiledStep[];
}

function appendFusedSteps<TContext>(
  node: LowerablePhysicalNode,
  localSlots: Map<string, number>,
  inputSlot: number,
  registry: Pick<ComputeOperatorLookup<TContext>, "get">,
  cursor: FlattenCursor,
): number {
  const fused = node.fusedSteps!;
  let prevSlot = -1;
  for (let i = 0; i < fused.length; i += 1) {
    const step = fused[i]!;
    const gather =
      i === 0
        ? buildSlotInputGatherer(node.incoming, localSlots, inputSlot)
        : {
            readSlots: [prevSlot],
            buildInputs: ((s: number) => (slots: unknown[]) => ({ default: slots[s] }))(prevSlot),
          };
    const dstSlot = cursor.nextSlot;
    cursor.nextSlot += 1;
    cursor.steps.push({
      id: step.id,
      op: step.op,
      fn: registry.get(step.op) as ComputeOperatorFn<unknown>,
      params: step.params,
      readSlots: gather.readSlots,
      buildInputs: gather.buildInputs,
      dstSlot,
      clearSlots: [],
    });
    prevSlot = dstSlot;
  }
  return prevSlot;
}

function appendSubgraphInputSlot(
  incoming: readonly ComputeEdgeSpec[],
  localSlots: ReadonlyMap<string, number>,
  inputSlot: number,
  cursor: FlattenCursor,
): number {
  if (!incoming.length) return inputSlot;
  if (incoming.length === 1 && (incoming[0]!.port ?? "default") === "default") {
    return resolveIncomingSlot(incoming[0]!.from, localSlots, inputSlot);
  }
  const gather = buildSlotInputGatherer(incoming, localSlots, inputSlot);
  const dstSlot = cursor.nextSlot;
  cursor.nextSlot += 1;
  cursor.steps.push({
    id: "$subgraph_in",
    op: "$gather",
    fn: (inputs) => inputs,
    params: {},
    readSlots: gather.readSlots,
    buildInputs: gather.buildInputs,
    dstSlot,
    clearSlots: [],
  });
  return dstSlot;
}

function flattenPlanIntoSteps<TContext>(
  plan: LowerablePhysicalPlan,
  registry: Pick<ComputeOperatorLookup<TContext>, "get">,
  inputSlot: number,
  cursor: FlattenCursor,
): number {
  const localSlots = new Map<string, number>();
  for (const node of plan.order) {
    if (node.kind === "subgraph" && node.subgraphPlan) {
      const subInputSlot = appendSubgraphInputSlot(node.incoming, localSlots, inputSlot, cursor);
      const subOutSlot = flattenPlanIntoSteps(node.subgraphPlan, registry, subInputSlot, cursor);
      localSlots.set(node.id, subOutSlot);
      continue;
    }
    if (node.fusedSteps) {
      const outSlot = appendFusedSteps(node, localSlots, inputSlot, registry, cursor);
      localSlots.set(node.id, outSlot);
      continue;
    }
    const gather = buildSlotInputGatherer(node.incoming, localSlots, inputSlot);
    const dstSlot = cursor.nextSlot;
    cursor.nextSlot += 1;
    cursor.steps.push({
      id: node.id,
      op: node.op,
      fn: node.inlineFn ?? (registry.get(node.op) as ComputeOperatorFn<unknown>),
      params: resolveStaticNodeParams(node),
      readSlots: gather.readSlots,
      buildInputs: gather.buildInputs,
      dstSlot,
      clearSlots: [],
    });
    localSlots.set(node.id, dstSlot);
  }
  return localSlots.get(plan.outputNodeId) ?? inputSlot;
}

function assignSlotLiveness(steps: CompiledStep[], outputSlot: number): void {
  const lastUse = new Map<number, number>();
  for (let i = 0; i < steps.length; i += 1) {
    for (const slot of steps[i]!.readSlots) lastUse.set(slot, i);
  }
  for (const [slot, stepIdx] of lastUse) {
    if (slot === 0 || slot === outputSlot) continue;
    steps[stepIdx]!.clearSlots.push(slot);
  }
}

/**
 * Compile a lock-free synchronous PhysicalExecutionPlan (including nested subgraphs and fused chains)
 * into a flat monomorphic slot-indexed JS/V8 kernel with zero Map allocations or registry lookups.
 */
export function compileSyncPlanKernel<TContext>(
  plan: LowerablePhysicalPlan,
  registry: Pick<ComputeOperatorLookup<TContext>, "get">,
): CompiledSyncKernel | undefined {
  if (planHasResourceLocks(plan)) return undefined;
  const cursor: FlattenCursor = { nextSlot: 1, steps: [] };
  const outputSlot = flattenPlanIntoSteps(plan, registry, 0, cursor);
  assignSlotLiveness(cursor.steps, outputSlot);
  const steps = cursor.steps;
  const slotCount = cursor.nextSlot;

  return (input, context) => {
    const slots = new Array<unknown>(slotCount);
    slots[0] = input;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]!;
      const value = step.fn(step.buildInputs(slots), context, step.params);
      if (isPromiseLikeValue(value)) {
        throw new Error(`Sync compute graph encountered async node '${step.id}' (${step.op})`);
      }
      slots[step.dstSlot] = value;
      for (let j = 0; j < step.clearSlots.length; j += 1) {
        slots[step.clearSlots[j]!] = undefined;
      }
    }
    return slots[outputSlot];
  };
}
