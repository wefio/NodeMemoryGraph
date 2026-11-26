import { canonicalizeComputeValue } from "./canonical-value.ts";
import {
  INPUT_NODE_ID,
  combineChildCapabilities,
  resolveCapabilities,
  type ComputeEdgeSpec,
  type ComputeGraphSpec,
  type ComputeNodeSpec,
  type ComputeOperatorFn,
  type ComputeOperatorLookup,
  type ComputeResourceProfile,
  type ResolvedOperatorCapabilities,
  type StructuredComputeExpr,
} from "./compute-contracts.ts";
import {
  DEFAULT_BACKEND_REGISTRY,
  compileFusedChainSyncRunner,
  compileSyncPlanKernel,
  runBackendLoweringPass,
  type CompiledSyncKernel,
  type ComputeBackendRegistry,
  type LoweredTargetKind,
  type LoweringPassResult,
} from "./compute-lowering.ts";
import { hasNamedResources } from "./resource-locks.ts";

export interface PhysicalPlanOptions {
  readonly enableDce?: boolean;
  readonly enableCse?: boolean;
  readonly enableLinearFusion?: boolean;
  readonly enableRegionLowering?: boolean;
  readonly enableSyncKernel?: boolean;
  readonly backendTarget?: "auto" | "sqlite" | "portable";
  readonly costRatioThreshold?: number;
  readonly backendRegistry?: ComputeBackendRegistry;
  readonly contractBindings?: Readonly<Record<string, string>>;
  readonly configIdentity?: string;
  readonly allowedAlgorithmicVariants?: readonly string[];
}

export interface PhysicalNodePlan {
  readonly id: string;
  readonly op: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly incoming: readonly ComputeEdgeSpec[];
  readonly capabilities: ResolvedOperatorCapabilities;
  readonly requiresResourceLock?: boolean;
  readonly kind: "operator" | "subgraph" | "inline_fn" | "lowered_expression" | "fused_chain";
  readonly inlineFn?: ComputeOperatorFn<unknown>;
  readonly expression?: StructuredComputeExpr;
  readonly subgraphPlan?: PhysicalExecutionPlan;
  readonly fusedSteps?: readonly PhysicalNodePlan[];
  readonly compiledFusedSync?: (inputs: Record<string, unknown>, context: unknown) => unknown;
  readonly loweredTarget?: LoweredTargetKind;
  readonly loweredRegionNodeIds?: readonly string[];
  readonly contract?: string;
}

export interface PhysicalWaveGroup {
  readonly parallelGroups: readonly (readonly PhysicalNodePlan[])[];
  readonly serialNodes: readonly PhysicalNodePlan[];
}

export interface PhysicalExecutionPlan {
  readonly logicalGraphId: string;
  readonly configIdentity?: string;
  readonly backendVersionSignature?: string;
  readonly outputNodeId: string;
  readonly order: readonly PhysicalNodePlan[];
  readonly waves: readonly PhysicalWaveGroup[];
  readonly edges: readonly ComputeEdgeSpec[];
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  readonly dependencies: {
    readonly counts: ReadonlyMap<string, number>;
    readonly followers: ReadonlyMap<string, readonly PhysicalNodePlan[]>;
  };
  readonly consumerCounts: ReadonlyMap<string, number>;
  readonly eliminatedNodeIds: readonly string[];
  readonly cseMergedNodeIds: ReadonlyMap<string, string>;
  readonly loweredNodes: ReadonlyMap<string, string>;
  readonly syncKernel?: CompiledSyncKernel;
  readonly hasUncacheableNode: boolean;
}

interface WorkingGraph {
  readonly nodes: ComputeNodeSpec[];
  readonly edges: ComputeEdgeSpec[];
  readonly output: string;
  readonly cseMergedNodeIds: Map<string, string>;
  readonly eliminatedNodeIds: string[];
  readonly loweredNodes: Map<string, string>;
  readonly regionTargetByExit: LoweringPassResult["regionTargetByExit"];
}

const PLAN_CACHE = new WeakMap<ComputeGraphSpec, Map<string, PhysicalExecutionPlan>>();
const REGISTRY_INSTANCE_IDS = new WeakMap<object, number>();
let nextRegistryInstanceId = 1;

function registryInstanceToken<TContext>(registry: ComputeOperatorLookup<TContext>): number {
  let id = REGISTRY_INSTANCE_IDS.get(registry);
  if (id === undefined) {
    id = nextRegistryInstanceId;
    nextRegistryInstanceId += 1;
    REGISTRY_INSTANCE_IDS.set(registry, id);
  }
  return id;
}

function indexNodes(nodes: readonly ComputeNodeSpec[]): Map<string, ComputeNodeSpec> {
  const byId = new Map<string, ComputeNodeSpec>();
  for (const node of nodes) {
    if (!node.id || node.id === INPUT_NODE_ID) throw new Error(`Invalid node id: ${node.id}`);
    if (byId.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    byId.set(node.id, node);
  }
  return byId;
}

function indexAndValidateEdges(
  specId: string,
  nodes: readonly ComputeNodeSpec[],
  edges: readonly ComputeEdgeSpec[],
  nodeById: ReadonlyMap<string, ComputeNodeSpec>,
) {
  const incoming = new Map<string, ComputeEdgeSpec[]>();
  const outgoing = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
    inDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    if (edge.from !== INPUT_NODE_ID && !nodeById.has(edge.from)) {
      throw new Error(`Dangling edge source '${edge.from}' in graph '${specId}'`);
    }
    if (!nodeById.has(edge.to)) {
      throw new Error(`Dangling edge target '${edge.to}' in graph '${specId}'`);
    }
    incoming.get(edge.to)!.push(edge);
    if (edge.from !== INPUT_NODE_ID) {
      outgoing.get(edge.from)!.push(edge.to);
      inDegree.set(edge.to, inDegree.get(edge.to)! + 1);
    }
  }
  return { incoming, outgoing, inDegree };
}

function computeTopoOrder(
  specId: string,
  nodes: readonly ComputeNodeSpec[],
  nodeById: ReadonlyMap<string, ComputeNodeSpec>,
  outgoing: ReadonlyMap<string, readonly string[]>,
  inDegree: Map<string, number>,
): { order: ComputeNodeSpec[]; waves: ComputeNodeSpec[][] } {
  let frontier = nodes.filter((node) => inDegree.get(node.id) === 0).map((node) => node.id);
  const order: ComputeNodeSpec[] = [];
  const waves: ComputeNodeSpec[][] = [];
  while (frontier.length > 0) {
    const wave: ComputeNodeSpec[] = [];
    const next: string[] = [];
    for (const currentId of frontier) {
      const node = nodeById.get(currentId)!;
      order.push(node);
      wave.push(node);
      for (const targetId of outgoing.get(currentId)!) {
        const deg = inDegree.get(targetId)! - 1;
        inDegree.set(targetId, deg);
        if (deg === 0) next.push(targetId);
      }
    }
    waves.push(wave);
    frontier = next;
  }
  if (order.length !== nodes.length) {
    throw new Error(`Compute graph '${specId}' contains a cycle`);
  }
  return { order, waves };
}

function resolveNodeOp<TContext>(
  node: ComputeNodeSpec,
  registry: ComputeOperatorLookup<TContext>,
  options: PhysicalPlanOptions,
): string {
  if (node.op && node.op !== "$contract") return node.op;
  if (!node.contract) return node.op;
  const bound = options.contractBindings?.[node.contract] ?? registry.findByContract(node.contract);
  if (!bound) throw new Error(`No operator bound for contract '${node.contract}'`);
  return bound;
}

function resolveNodeCapabilities<TContext>(
  node: ComputeNodeSpec,
  resolvedOp: string,
  registry: ComputeOperatorLookup<TContext>,
  subgraphPlan?: PhysicalExecutionPlan,
): ResolvedOperatorCapabilities {
  if (node.subgraph && subgraphPlan) {
    const childCaps = subgraphPlan.order.map((n) => n.capabilities);
    const combined = combineChildCapabilities(childCaps, node.meta?.version ?? "subgraph-v1");
    return node.sideEffect
      ? {
          ...combined,
          effect: "write",
          cacheable: false,
          parallelSafe: false,
          reorderable: false,
          eliminable: false,
        }
      : combined;
  }
  if (node.fn) {
    const base = resolveCapabilities(node.meta);
    return node.sideEffect
      ? {
          ...base,
          effect: "write",
          cacheable: false,
          parallelSafe: false,
          reorderable: false,
          eliminable: false,
        }
      : base;
  }
  const regCaps = registry.has(resolvedOp)
    ? registry.getCapabilities(resolvedOp)
    : resolveCapabilities(node.meta);
  if (!node.sideEffect && !node.meta) return regCaps;
  return resolveCapabilities({
    ...regCaps,
    ...(node.contract ? { contract: node.contract } : {}),
    ...node.meta,
    ...(node.sideEffect ? { sideEffect: true } : {}),
  });
}

function runCsePass<TContext>(
  specId: string,
  nodes: readonly ComputeNodeSpec[],
  edges: readonly ComputeEdgeSpec[],
  output: string,
  registry: ComputeOperatorLookup<TContext>,
  options: PhysicalPlanOptions,
): {
  nodes: ComputeNodeSpec[];
  edges: ComputeEdgeSpec[];
  merged: Map<string, string>;
  output: string;
} {
  if (options.enableCse === false) {
    return { nodes: [...nodes], edges: [...edges], merged: new Map(), output };
  }
  const nodeById = indexNodes(nodes);
  const { incoming, outgoing, inDegree } = indexAndValidateEdges(specId, nodes, edges, nodeById);
  const { order } = computeTopoOrder(specId, nodes, nodeById, outgoing, inDegree);
  const merged = new Map<string, string>();
  const seenExpr = new Map<string, string>();

  const rewriteSource = (src: string): string => {
    let cur = src;
    while (merged.has(cur)) cur = merged.get(cur)!;
    return cur;
  };

  for (const node of order) {
    if (node.fn || node.expression || node.subgraph) continue;
    const op = resolveNodeOp(node, registry, options);
    const caps = resolveNodeCapabilities(node, op, registry);
    if (caps.effect !== "pure") continue;
    const normEdges = incoming
      .get(node.id)!
      .map((e) => `${e.port ?? "default"}=${rewriteSource(e.from)}`)
      .sort()
      .join("&");
    const exprKey = `${op}|${caps.version}|${canonicalizeComputeValue(node.params ?? {})}|${normEdges}`;
    const existing = seenExpr.get(exprKey);
    if (existing) merged.set(node.id, existing);
    else seenExpr.set(exprKey, node.id);
  }
  if (!merged.size) return { nodes: [...nodes], edges: [...edges], merged, output };
  const keptNodes = nodes.filter((n) => !merged.has(n.id));
  const keptEdges: ComputeEdgeSpec[] = [];
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (merged.has(edge.to)) continue;
    const from = rewriteSource(edge.from);
    const k = `${from}->${edge.to}:${edge.port ?? "default"}`;
    if (edgeKeys.has(k)) continue;
    edgeKeys.add(k);
    keptEdges.push({ ...edge, from });
  }
  return { nodes: keptNodes, edges: keptEdges, merged, output: rewriteSource(output) };
}

function isNodeEliminable<TContext>(
  node: ComputeNodeSpec,
  registry: ComputeOperatorLookup<TContext>,
  options: PhysicalPlanOptions,
): boolean {
  if (node.sideEffect) return false;
  if (node.subgraph) {
    return node.subgraph.nodes.every((child) => isNodeEliminable(child, registry, options));
  }
  const op = resolveNodeOp(node, registry, options);
  return resolveNodeCapabilities(node, op, registry).eliminable;
}

function runDcePass<TContext>(
  nodes: readonly ComputeNodeSpec[],
  edges: readonly ComputeEdgeSpec[],
  output: string,
  registry: ComputeOperatorLookup<TContext>,
  options: PhysicalPlanOptions,
): { nodes: ComputeNodeSpec[]; edges: ComputeEdgeSpec[]; eliminated: string[] } {
  if (options.enableDce === false) {
    return { nodes: [...nodes], edges: [...edges], eliminated: [] };
  }
  const incomingByNode = new Map<string, ComputeEdgeSpec[]>();
  for (const node of nodes) incomingByNode.set(node.id, []);
  for (const edge of edges) incomingByNode.get(edge.to)?.push(edge);

  const live = new Set<string>([output]);
  for (const node of nodes) {
    if (!isNodeEliminable(node, registry, options)) live.add(node.id);
  }
  const queue = [...live];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const edge of incomingByNode.get(id) ?? []) {
      if (edge.from !== INPUT_NODE_ID && !live.has(edge.from)) {
        live.add(edge.from);
        queue.push(edge.from);
      }
    }
  }
  const eliminated = nodes.filter((n) => !live.has(n.id)).map((n) => n.id);
  return {
    nodes: nodes.filter((n) => live.has(n.id)),
    edges: edges.filter((e) => live.has(e.to) && (e.from === INPUT_NODE_ID || live.has(e.from))),
    eliminated,
  };
}

function allResources(p: ComputeResourceProfile): string[] {
  return [...(p.reads ?? []), ...(p.writes ?? []), ...(p.exclusive ?? [])];
}

function anyInSet(items: readonly string[] | undefined, set: ReadonlySet<string>): boolean {
  return items ? items.some((item) => set.has(item)) : false;
}

function resourcesConflict(a: ComputeResourceProfile, b: ComputeResourceProfile): boolean {
  const aEx = new Set(a.exclusive ?? []);
  const bEx = new Set(b.exclusive ?? []);
  if (anyInSet(allResources(b), aEx) || anyInSet(allResources(a), bEx)) return true;
  const aWrites = new Set(a.writes ?? []);
  const bWrites = new Set(b.writes ?? []);
  return anyInSet(b.reads, aWrites) || anyInSet(b.writes, aWrites) || anyInSet(a.reads, bWrites);
}

function partitionWave(waveNodes: readonly PhysicalNodePlan[]): PhysicalWaveGroup {
  const parallelCandidates: PhysicalNodePlan[] = [];
  const serialNodes: PhysicalNodePlan[] = [];
  for (const node of waveNodes) {
    if (canRunInParallel(node)) {
      parallelCandidates.push(node);
    } else {
      serialNodes.push(node);
    }
  }
  const parallelGroups: PhysicalNodePlan[][] = [];
  for (const candidate of parallelCandidates) {
    let placed = false;
    for (const group of parallelGroups) {
      if (
        !group.some((member) =>
          resourcesConflict(member.capabilities.resources, candidate.capabilities.resources),
        )
      ) {
        group.push(candidate);
        placed = true;
        break;
      }
    }
    if (!placed) parallelGroups.push([candidate]);
  }
  return { parallelGroups, serialNodes };
}

function canRunInParallel(node: PhysicalNodePlan): boolean {
  const { parallelSafe, effect } = node.capabilities;
  return parallelSafe && (effect === "pure" || effect === "read");
}

function buildDependencies(
  order: readonly PhysicalNodePlan[],
): PhysicalExecutionPlan["dependencies"] {
  const counts = new Map<string, number>();
  const followers = new Map<string, PhysicalNodePlan[]>();
  let lastSerial: string | undefined;
  for (const node of order) {
    const parents = new Set(node.incoming.map(({ from }) => from));
    parents.delete(INPUT_NODE_ID);
    if (!canRunInParallel(node)) {
      if (lastSerial) parents.add(lastSerial);
      lastSerial = node.id;
    }
    counts.set(node.id, parents.size);
    for (const parent of parents) {
      const list = followers.get(parent) ?? [];
      list.push(node);
      followers.set(parent, list);
    }
  }
  return { counts, followers };
}

function computeConsumerCounts(
  nodes: readonly PhysicalNodePlan[],
  edges: readonly ComputeEdgeSpec[],
  outputNodeId: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.id, 0);
  for (const edge of edges) {
    if (edge.from !== INPUT_NODE_ID && counts.has(edge.from)) {
      counts.set(edge.from, counts.get(edge.from)! + 1);
    }
  }
  counts.set(outputNodeId, (counts.get(outputNodeId) ?? 0) + 1);
  return counts;
}

function isFusableNode(node: PhysicalNodePlan): boolean {
  return (
    node.kind === "operator" &&
    node.capabilities.effect === "pure" &&
    node.capabilities.parallelSafe &&
    node.capabilities.resources.execution !== "async_io" &&
    node.capabilities.resources.execution !== "cpu" &&
    !hasNamedResources(node.capabilities.resources)
  );
}

function nextChainStep(
  cur: PhysicalNodePlan,
  outgoingTarget: ReadonlyMap<string, string>,
  byId: ReadonlyMap<string, PhysicalNodePlan>,
  consumerCounts: ReadonlyMap<string, number>,
  outputNodeId: string,
): PhysicalNodePlan | undefined {
  if (cur.id === outputNodeId || consumerCounts.get(cur.id) !== 1) return undefined;
  const nextId = outgoingTarget.get(cur.id);
  const nextNode = nextId ? byId.get(nextId) : undefined;
  if (!nextNode || !isFusableNode(nextNode) || nextNode.incoming.length !== 1) return undefined;
  const edge = nextNode.incoming[0]!;
  return edge.from === cur.id && (edge.port ?? "default") === "default" ? nextNode : undefined;
}

function buildLinearFusedOrder<TContext>(
  order: readonly PhysicalNodePlan[],
  edges: readonly ComputeEdgeSpec[],
  consumerCounts: ReadonlyMap<string, number>,
  outputNodeId: string,
  registry: ComputeOperatorLookup<TContext>,
): { order: PhysicalNodePlan[]; absorbedIds: Set<string> } {
  const byId = new Map(order.map((n) => [n.id, n]));
  const outgoingTarget = new Map<string, string>();
  for (const edge of edges) if (edge.from !== INPUT_NODE_ID) outgoingTarget.set(edge.from, edge.to);
  const absorbedIds = new Set<string>();
  const nextOrder: PhysicalNodePlan[] = [];
  for (const node of order) {
    if (absorbedIds.has(node.id)) continue;
    const firstNext = isFusableNode(node)
      ? nextChainStep(node, outgoingTarget, byId, consumerCounts, outputNodeId)
      : undefined;
    if (!firstNext) {
      nextOrder.push(node);
      continue;
    }
    const chain: PhysicalNodePlan[] = [node];
    let step: PhysicalNodePlan | undefined = firstNext;
    while (step) {
      absorbedIds.add(step.id);
      chain.push(step);
      step = nextChainStep(step, outgoingTarget, byId, consumerCounts, outputNodeId);
    }
    const last = chain[chain.length - 1]!;
    nextOrder.push({
      id: last.id,
      op: `fused:${chain.map((s) => s.op).join(">")}`,
      params: {},
      incoming: node.incoming.map((edge) => ({ ...edge, to: last.id })),
      capabilities: last.capabilities,
      kind: "fused_chain",
      fusedSteps: chain,
      compiledFusedSync: compileFusedChainSyncRunner(chain, registry),
    });
  }
  return { order: nextOrder, absorbedIds };
}

function buildPhysicalNode<TContext>(
  node: ComputeNodeSpec,
  incoming: readonly ComputeEdgeSpec[],
  registry: ComputeOperatorLookup<TContext>,
  options: PhysicalPlanOptions,
  regionInfo?: LoweringPassResult["regionTargetByExit"] extends ReadonlyMap<string, infer V>
    ? V
    : never,
): PhysicalNodePlan {
  const op = resolveNodeOp(node, registry, options);
  const subgraphPlan = node.subgraph
    ? compileComputeGraph(node.subgraph, registry, options)
    : undefined;
  const capabilities = resolveNodeCapabilities(node, op, registry, subgraphPlan);
  const params = node.params ?? {};
  const base = {
    id: node.id,
    params,
    incoming,
    capabilities,
    requiresResourceLock: hasNamedResources(capabilities.resources),
  };
  const contractProp = node.contract ? { contract: node.contract } : {};
  const expression = regionInfo?.expression ?? node.expression;
  if (regionInfo) {
    return {
      ...base,
      op,
      kind: "lowered_expression",
      ...(expression ? { expression } : {}),
      loweredTarget: regionInfo.loweredTarget,
      ...(regionInfo.regionNodeIds.length > 1
        ? { loweredRegionNodeIds: regionInfo.regionNodeIds }
        : {}),
      ...contractProp,
    };
  }
  if (subgraphPlan) {
    return {
      ...base,
      op: "subgraph",
      kind: "subgraph",
      subgraphPlan,
    };
  }
  if (node.fn) {
    return {
      ...base,
      op: node.op || `inline:${node.id}`,
      kind: "inline_fn",
      inlineFn: node.fn,
    };
  }
  return {
    ...base,
    op,
    kind: "operator",
    ...(expression ? { expression } : {}),
    ...contractProp,
  };
}

function backendVersionFor(options: PhysicalPlanOptions): string {
  return (options.backendRegistry ?? DEFAULT_BACKEND_REGISTRY).versionSignature;
}

function planCacheKey<TContext>(
  registry: ComputeOperatorLookup<TContext>,
  options: PhysicalPlanOptions,
): string {
  const backendSig = backendVersionFor(options);
  return `${registryInstanceToken(registry)}:${registry.generation}|${backendSig}|${options.configIdentity ?? ""}|${canonicalizeComputeValue(options)}`;
}

/** Transform and compile a logical ComputeGraphSpec into a cached PhysicalExecutionPlan. */
export function compileComputeGraph<TContext = unknown>(
  spec: ComputeGraphSpec,
  registry: ComputeOperatorLookup<TContext>,
  options: PhysicalPlanOptions = {},
): PhysicalExecutionPlan {
  const cacheKey = planCacheKey(registry, options);
  let byOptions = PLAN_CACHE.get(spec);
  const cached = byOptions?.get(cacheKey);
  if (cached) return cached;

  const initialById = indexNodes(spec.nodes);
  if (!initialById.has(spec.output)) {
    throw new Error(`Output node '${spec.output}' missing in graph '${spec.id}'`);
  }
  indexAndValidateEdges(spec.id, spec.nodes, spec.edges, initialById);

  const cse = runCsePass(spec.id, spec.nodes, spec.edges, spec.output, registry, options);
  const dce = runDcePass(cse.nodes, cse.edges, cse.output, registry, options);
  const preLowerById = indexNodes(dce.nodes);
  const preLowerGraph = indexAndValidateEdges(spec.id, dce.nodes, dce.edges, preLowerById);
  const lowering = runBackendLoweringPass(
    {
      specId: spec.id,
      nodes: dce.nodes,
      edges: dce.edges,
      output: cse.output,
      nodeById: preLowerById,
      incoming: preLowerGraph.incoming,
      outgoing: preLowerGraph.outgoing,
      backendTarget: options.backendTarget,
      enableRegionLowering: options.enableRegionLowering !== false,
      resolveOp: (n) => resolveNodeOp(n, registry, options),
      resolveCaps: (n, resolved) => resolveNodeCapabilities(n, resolved, registry),
    },
    {
      backendRegistry: options.backendRegistry,
      costRatioThreshold: options.costRatioThreshold,
    },
  );
  const work: WorkingGraph = {
    nodes: lowering.nodes,
    edges: lowering.edges,
    output: cse.output,
    cseMergedNodeIds: cse.merged,
    eliminatedNodeIds: dce.eliminated,
    loweredNodes: lowering.loweredNodes,
    regionTargetByExit: lowering.regionTargetByExit,
  };

  const nodeById = indexNodes(work.nodes);
  const { incoming, outgoing, inDegree } = indexAndValidateEdges(
    spec.id,
    work.nodes,
    work.edges,
    nodeById,
  );
  const { order, waves } = computeTopoOrder(spec.id, work.nodes, nodeById, outgoing, inDegree);

  const physicalById = new Map<string, PhysicalNodePlan>();
  for (const node of order) {
    const planNode = buildPhysicalNode(
      node,
      incoming.get(node.id) ?? [],
      registry,
      options,
      work.regionTargetByExit.get(node.id),
    );
    physicalById.set(node.id, planNode);
  }

  let physicalOrder = order.map((n) => physicalById.get(n.id)!);
  let consumerCounts = computeConsumerCounts(physicalOrder, work.edges, work.output);
  let physicalWaves = waves.map((w) => partitionWave(w.map((n) => physicalById.get(n.id)!)));

  let finalEdges = work.edges;
  let finalOutgoing = outgoing;
  if (options.enableLinearFusion) {
    const fused = buildLinearFusedOrder(
      physicalOrder,
      work.edges,
      consumerCounts,
      work.output,
      registry,
    );
    if (fused.absorbedIds.size > 0) {
      physicalOrder = fused.order;
      finalEdges = physicalOrder.flatMap((n) => n.incoming);
      consumerCounts = computeConsumerCounts(physicalOrder, finalEdges, work.output);
      physicalWaves = physicalOrder.map((n) => partitionWave([n]));
      finalOutgoing = indexAndValidateEdges(
        spec.id,
        physicalOrder,
        finalEdges,
        indexNodes(physicalOrder),
      ).outgoing;
    }
  }

  const basePlan = {
    logicalGraphId: spec.id,
    configIdentity: options.configIdentity,
    backendVersionSignature: backendVersionFor(options),
    outputNodeId: work.output,
    order: physicalOrder,
    waves: physicalWaves,
    edges: finalEdges,
    outgoing: finalOutgoing,
    dependencies: buildDependencies(physicalOrder),
    consumerCounts,
    eliminatedNodeIds: work.eliminatedNodeIds,
    cseMergedNodeIds: work.cseMergedNodeIds,
    loweredNodes: work.loweredNodes,
    hasUncacheableNode: physicalOrder.some(
      (n) => !n.capabilities.cacheable || n.capabilities.effect !== "pure",
    ),
  };
  const syncKernel =
    options.enableSyncKernel !== false ? compileSyncPlanKernel(basePlan, registry) : undefined;
  const plan: PhysicalExecutionPlan = {
    ...basePlan,
    ...(syncKernel ? { syncKernel } : {}),
  };

  if (!byOptions) {
    byOptions = new Map();
    PLAN_CACHE.set(spec, byOptions);
  }
  byOptions.set(cacheKey, plan);
  return plan;
}

/** Produce a compact human- and machine-readable explanation of a PhysicalExecutionPlan. */
export function explainComputePlan(plan: PhysicalExecutionPlan): {
  graphId: string;
  outputNodeId: string;
  steps: Array<{
    id: string;
    op: string;
    kind: string;
    effect: string;
    cacheable: boolean;
    parallelSafe: boolean;
    loweredTarget?: string;
    loweredRegionNodeIds?: readonly string[];
    fusedCount?: number;
  }>;
  eliminatedNodeIds: readonly string[];
  cseMergedNodeIds: Record<string, string>;
  loweredNodes: Record<string, string>;
  waveCount: number;
  syncKernelCompiled: boolean;
} {
  return {
    graphId: plan.logicalGraphId,
    outputNodeId: plan.outputNodeId,
    steps: plan.order.map((node) => ({
      id: node.id,
      op: node.op,
      kind: node.kind,
      effect: node.capabilities.effect,
      cacheable: node.capabilities.cacheable,
      parallelSafe: node.capabilities.parallelSafe,
      ...(node.loweredTarget ? { loweredTarget: node.loweredTarget } : {}),
      ...(node.loweredRegionNodeIds ? { loweredRegionNodeIds: node.loweredRegionNodeIds } : {}),
      ...(node.fusedSteps ? { fusedCount: node.fusedSteps.length } : {}),
    })),
    eliminatedNodeIds: plan.eliminatedNodeIds,
    cseMergedNodeIds: Object.fromEntries(plan.cseMergedNodeIds),
    loweredNodes: Object.fromEntries(plan.loweredNodes),
    waveCount: plan.waves.length,
    syncKernelCompiled: Boolean(plan.syncKernel),
  };
}
