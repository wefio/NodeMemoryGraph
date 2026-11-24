import { createHash } from "node:crypto";

export const INPUT_NODE_ID = "$input";

export interface ComputeNodeSpec {
  readonly id: string;
  readonly op: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly subgraph?: ComputeGraphSpec;
  /** Mark nodes that mutate external/DB state so memo caching and downstream caching are bypassed. */
  readonly sideEffect?: boolean;
}

export interface ComputeEdgeSpec {
  readonly from: string;
  readonly to: string;
  readonly port?: string;
}

export interface ComputeGraphSpec {
  readonly id: string;
  readonly nodes: readonly ComputeNodeSpec[];
  readonly edges: readonly ComputeEdgeSpec[];
  readonly output: string;
}

export type ComputeOperator<TContext = unknown> = (
  inputs: Readonly<Record<string, unknown>>,
  context: TContext,
  params: Readonly<Record<string, unknown>>,
) => unknown;

export interface ComputeRegisterOptions {
  readonly version?: string;
  readonly sideEffect?: boolean;
}

export interface GraphDiffEntry {
  readonly nodeId: string;
  readonly status: "added" | "removed" | "modified";
}

export interface GraphExperimentOutcome<TOut> {
  readonly results: Map<string, TOut>;
  readonly cacheHits: number;
  readonly executedNodes: number;
}

function canonicalValue(value: unknown): string {
  if (typeof value === "function") return `[fn:${sha256Hex(value.toString())}]`;
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`);
    return `{${entries.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

const FROZEN_ARRAY_SIG_CACHE = new WeakMap<readonly unknown[], string>();
const FROZEN_INPUT_SIG_CACHE = new WeakMap<object, string>();

function isDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.values(value).every((item) => isDeeplyFrozen(item, seen));
}

function arraySignature(value: readonly unknown[]): string {
  if (isDeeplyFrozen(value)) {
    const cached = FROZEN_ARRAY_SIG_CACHE.get(value);
    if (cached) return cached;
    const sig = sha256Hex(`[${value.map(canonicalValue).join(",")}]`);
    FROZEN_ARRAY_SIG_CACHE.set(value, sig);
    return sig;
  }
  return sha256Hex(`[${value.map(canonicalValue).join(",")}]`);
}

function contextSignature(context: unknown): string {
  if (context !== null && typeof context === "object" && !Array.isArray(context)) {
    const entries = Object.entries(context)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) =>
        Array.isArray(item)
          ? `${JSON.stringify(key)}:${arraySignature(item)}`
          : `${JSON.stringify(key)}:${canonicalValue(item)}`,
      );
    return sha256Hex(`{${entries.join(",")}}`);
  }
  return sha256Hex(canonicalValue(context));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Registry mapping operator names to pure or side-effecting functions with versioned signatures. */
export class ComputeRegistry<TContext = unknown> {
  private readonly operators = new Map<string, ComputeOperator<TContext>>();
  private readonly signatures = new Map<string, string>();
  private readonly sideEffects = new Set<string>();
  private generation = 0;

  register(op: string, fn: ComputeOperator<TContext>, options?: ComputeRegisterOptions): this {
    if (!op.trim()) throw new Error("Operator name must be non-empty");
    this.generation += 1;
    const version = options?.version ?? "v1";
    const sideEffect = options?.sideEffect === true;
    this.operators.set(op, fn);
    if (sideEffect) this.sideEffects.add(op);
    else this.sideEffects.delete(op);
    this.signatures.set(
      op,
      sha256Hex(`${version}:${sideEffect ? "fx" : "pure"}:${this.generation}:${fn.toString()}`),
    );
    return this;
  }

  has(op: string): boolean {
    return this.operators.has(op);
  }

  isSideEffect(op: string): boolean {
    return this.sideEffects.has(op);
  }

  get(op: string): ComputeOperator<TContext> {
    const fn = this.operators.get(op);
    if (!fn) throw new Error(`Unknown compute operator: ${op}`);
    return fn;
  }

  getSignature(op: string): string {
    const sig = this.signatures.get(op);
    if (!sig) throw new Error(`Unknown compute operator: ${op}`);
    return sig;
  }
}

/** Structural prefix cache shared across multiple experiment graph runs. */
export class ComputeMemoCache {
  private readonly values = new Map<string, unknown>();
  hits = 0;
  executions = 0;

  get(key: string): { found: boolean; value: unknown } {
    if (!this.values.has(key)) return { found: false, value: undefined };
    this.hits += 1;
    return { found: true, value: this.values.get(key) };
  }

  set(key: string, value: unknown): void {
    this.executions += 1;
    this.values.set(key, value);
  }

  clear(): void {
    this.values.clear();
    this.hits = 0;
    this.executions = 0;
  }
}

interface ValidatedGraph {
  readonly nodeById: ReadonlyMap<string, ComputeNodeSpec>;
  readonly incomingByNode: ReadonlyMap<string, readonly ComputeEdgeSpec[]>;
  readonly order: readonly ComputeNodeSpec[];
  readonly waves: readonly (readonly ComputeNodeSpec[])[];
}

function indexNodes(nodes: readonly ComputeNodeSpec[]): Map<string, ComputeNodeSpec> {
  const nodeById = new Map<string, ComputeNodeSpec>();
  for (const node of nodes) {
    if (!node.id || node.id === INPUT_NODE_ID) throw new Error(`Invalid node id: ${node.id}`);
    if (nodeById.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    nodeById.set(node.id, node);
  }
  return nodeById;
}

function indexEdges(
  spec: ComputeGraphSpec,
  nodeById: ReadonlyMap<string, ComputeNodeSpec>,
): {
  incomingByNode: Map<string, ComputeEdgeSpec[]>;
  outgoingByNode: Map<string, string[]>;
  inDegree: Map<string, number>;
} {
  const incomingByNode = new Map<string, ComputeEdgeSpec[]>();
  const outgoingByNode = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const node of spec.nodes) {
    incomingByNode.set(node.id, []);
    outgoingByNode.set(node.id, []);
    inDegree.set(node.id, 0);
  }
  for (const edge of spec.edges) {
    if (edge.from !== INPUT_NODE_ID && !nodeById.has(edge.from)) {
      throw new Error(`Dangling edge source '${edge.from}' in graph '${spec.id}'`);
    }
    if (!nodeById.has(edge.to)) {
      throw new Error(`Dangling edge target '${edge.to}' in graph '${spec.id}'`);
    }
    incomingByNode.get(edge.to)!.push(edge);
    if (edge.from !== INPUT_NODE_ID) {
      outgoingByNode.get(edge.from)!.push(edge.to);
      inDegree.set(edge.to, inDegree.get(edge.to)! + 1);
    }
  }
  return { incomingByNode, outgoingByNode, inDegree };
}

function topoOrder(
  spec: ComputeGraphSpec,
  nodeById: ReadonlyMap<string, ComputeNodeSpec>,
  outgoingByNode: ReadonlyMap<string, readonly string[]>,
  inDegree: Map<string, number>,
): { order: ComputeNodeSpec[]; waves: ComputeNodeSpec[][] } {
  let frontier = spec.nodes.filter((node) => inDegree.get(node.id) === 0).map((node) => node.id);
  const order: ComputeNodeSpec[] = [];
  const waves: ComputeNodeSpec[][] = [];
  while (frontier.length > 0) {
    const wave: ComputeNodeSpec[] = [];
    const nextFrontier: string[] = [];
    for (const currentId of frontier) {
      const node = nodeById.get(currentId)!;
      order.push(node);
      wave.push(node);
      for (const nextId of outgoingByNode.get(currentId)!) {
        const nextDeg = inDegree.get(nextId)! - 1;
        inDegree.set(nextId, nextDeg);
        if (nextDeg === 0) nextFrontier.push(nextId);
      }
    }
    waves.push(wave);
    frontier = nextFrontier;
  }
  if (order.length !== spec.nodes.length) {
    throw new Error(`Compute graph '${spec.id}' contains a cycle`);
  }
  return { order, waves };
}

const VALIDATED_GRAPH_CACHE = new WeakMap<ComputeGraphSpec, ValidatedGraph>();

function validateGraph(spec: ComputeGraphSpec): ValidatedGraph {
  const cached = VALIDATED_GRAPH_CACHE.get(spec);
  if (cached) return cached;
  const nodeById = indexNodes(spec.nodes);
  if (!nodeById.has(spec.output)) {
    throw new Error(`Output node '${spec.output}' missing in graph '${spec.id}'`);
  }
  const { incomingByNode, outgoingByNode, inDegree } = indexEdges(spec, nodeById);
  const { order, waves } = topoOrder(spec, nodeById, outgoingByNode, inDegree);
  const validated = { nodeById, incomingByNode, order, waves };
  VALIDATED_GRAPH_CACHE.set(spec, validated);
  return validated;
}

function subgraphSignature<TContext>(
  spec: ComputeGraphSpec,
  registry: ComputeRegistry<TContext>,
): string {
  const nodeSigs = spec.nodes.map((child) => {
    const childOpSig = child.subgraph ? "subgraph" : registry.getSignature(child.op);
    const childSubSig = child.subgraph ? subgraphSignature(child.subgraph, registry) : "";
    return `${child.id}:${child.op}:${childOpSig}:${canonicalValue(child.params ?? {})}:${childSubSig}`;
  });
  return sha256Hex(`${spec.id}|${nodeSigs.join(";")}|${canonicalValue(spec.edges)}|${spec.output}`);
}

let executionNonce = 0;

function hasSideEffect<TContext>(
  node: ComputeNodeSpec,
  registry: ComputeRegistry<TContext>,
): boolean {
  if (node.sideEffect) return true;
  if (node.subgraph) return node.subgraph.nodes.some((child) => hasSideEffect(child, registry));
  return registry.isSideEffect(node.op);
}

function nodeSignature<TContext>(
  node: ComputeNodeSpec,
  incoming: readonly ComputeEdgeSpec[],
  signatures: ReadonlyMap<string, string>,
  registry: ComputeRegistry<TContext>,
  contextSig: string,
  uncacheable: boolean,
): string {
  if (uncacheable) {
    executionNonce += 1;
    return `uncached:${executionNonce}`;
  }
  const upstream = incoming
    .map((edge) => `${edge.port ?? "default"}=${signatures.get(edge.from) ?? ""}`)
    .sort()
    .join("&");
  const opSig = node.subgraph ? "subgraph" : registry.getSignature(node.op);
  const subSig = node.subgraph ? subgraphSignature(node.subgraph, registry) : "";
  return sha256Hex(
    `${node.op}|${opSig}|${contextSig}|${canonicalValue(node.params ?? {})}|${subSig}|${upstream}`,
  );
}

function gatherNodeInputs(
  incoming: readonly ComputeEdgeSpec[],
  outputs: ReadonlyMap<string, unknown>,
  graphInput: unknown,
): Record<string, unknown> {
  if (incoming.length === 0) return { default: graphInput };
  const inputs: Record<string, unknown> = {};
  for (const edge of incoming) {
    const key = edge.port ?? "default";
    inputs[key] = edge.from === INPUT_NODE_ID ? graphInput : outputs.get(edge.from);
  }
  return inputs;
}

function inputSignature(input: unknown): string {
  if (input !== null && typeof input === "object" && isDeeplyFrozen(input)) {
    const cached = FROZEN_INPUT_SIG_CACHE.get(input);
    if (cached) return cached;
    const sig = sha256Hex(canonicalValue(input));
    FROZEN_INPUT_SIG_CACHE.set(input, sig);
    return sig;
  }
  return sha256Hex(canonicalValue(input));
}

function prepareRunState<TIn>(
  spec: ComputeGraphSpec,
  input: TIn,
  context: unknown,
): {
  validated: ValidatedGraph;
  outputs: Map<string, unknown>;
  signatures: Map<string, string>;
  contextSig: string;
} {
  const validated = validateGraph(spec);
  const outputs = new Map<string, unknown>([[INPUT_NODE_ID, input]]);
  const signatures = new Map<string, string>([[INPUT_NODE_ID, inputSignature(input)]]);
  return { validated, outputs, signatures, contextSig: contextSignature(context) };
}

/** Wrap any ComputeGraphSpec into a single composite operator for hierarchical nesting. */
export function graphAsOperator<TContext = unknown>(
  spec: ComputeGraphSpec,
  registry: ComputeRegistry<TContext>,
  memo?: ComputeMemoCache,
): ComputeOperator<TContext> {
  return (inputs, context) => {
    const payload =
      Object.keys(inputs).length === 1 && "default" in inputs ? inputs.default : inputs;
    return executeComputeGraph(spec, registry, payload, context, memo);
  };
}

/** Execute a hierarchical ComputeGraphSpec asynchronously with wave-parallel scheduling and safe memoization. */
export async function executeComputeGraph<TIn, TOut, TContext = unknown>(
  spec: ComputeGraphSpec,
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
  memo?: ComputeMemoCache,
): Promise<TOut> {
  const { validated, outputs, signatures, contextSig } = prepareRunState(spec, input, context);
  for (const wave of validated.waves) {
    const pureNodes: ComputeNodeSpec[] = [];
    const fxNodes: ComputeNodeSpec[] = [];
    for (const node of wave) {
      if (hasSideEffect(node, registry)) fxNodes.push(node);
      else pureNodes.push(node);
    }
    await Promise.all(
      pureNodes.map(async (node) => {
        const incoming = validated.incomingByNode.get(node.id)!;
        const sig = nodeSignature(node, incoming, signatures, registry, contextSig, false);
        signatures.set(node.id, sig);
        const cached = memo?.get(sig);
        if (cached?.found) {
          outputs.set(node.id, cached.value);
          return;
        }
        const inputs = gatherNodeInputs(incoming, outputs, input);
        const payload =
          Object.keys(inputs).length === 1 && "default" in inputs ? inputs.default : inputs;
        const value = node.subgraph
          ? await executeComputeGraph(node.subgraph, registry, payload, context, memo)
          : await registry.get(node.op)(inputs, context, node.params ?? {});
        memo?.set(sig, value);
        outputs.set(node.id, value);
      }),
    );
    for (const node of fxNodes) {
      const incoming = validated.incomingByNode.get(node.id)!;
      const sig = nodeSignature(node, incoming, signatures, registry, contextSig, true);
      signatures.set(node.id, sig);
      const inputs = gatherNodeInputs(incoming, outputs, input);
      const payload =
        Object.keys(inputs).length === 1 && "default" in inputs ? inputs.default : inputs;
      const value = node.subgraph
        ? await executeComputeGraph(node.subgraph, registry, payload, context, undefined)
        : await registry.get(node.op)(inputs, context, node.params ?? {});
      outputs.set(node.id, value);
    }
  }
  return outputs.get(spec.output) as TOut;
}

/** Synchronously evaluate a ComputeGraphSpec whose operators are all synchronous. */
export function evaluateSyncComputeGraph<TIn, TOut, TContext = unknown>(
  spec: ComputeGraphSpec,
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
  memo?: ComputeMemoCache,
): TOut {
  const { validated, outputs, signatures, contextSig } = prepareRunState(spec, input, context);
  for (const node of validated.order) {
    const uncacheable = hasSideEffect(node, registry);
    const incoming = validated.incomingByNode.get(node.id)!;
    const sig = nodeSignature(node, incoming, signatures, registry, contextSig, uncacheable);
    signatures.set(node.id, sig);
    const cached = uncacheable ? undefined : memo?.get(sig);
    if (cached?.found) {
      outputs.set(node.id, cached.value);
      continue;
    }
    const inputs = gatherNodeInputs(incoming, outputs, input);
    const value = node.subgraph
      ? evaluateSyncComputeGraph(
          node.subgraph,
          registry,
          Object.keys(inputs).length === 1 && "default" in inputs ? inputs.default : inputs,
          context,
          uncacheable ? undefined : memo,
        )
      : registry.get(node.op)(inputs, context, node.params ?? {});
    if (isPromiseLike(value)) {
      throw new Error(`Sync compute graph encountered async node '${node.id}' (${node.op})`);
    }
    if (!uncacheable) memo?.set(sig, value);
    outputs.set(node.id, value);
  }
  return outputs.get(spec.output) as TOut;
}

/** Evaluate multiple candidate graph recipes on shared input with prefix memoization. */
export async function runGraphExperiments<TIn, TOut, TContext = unknown>(
  specs: readonly ComputeGraphSpec[],
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
): Promise<GraphExperimentOutcome<TOut>> {
  const memo = new ComputeMemoCache();
  const results = new Map<string, TOut>();
  for (const spec of specs) {
    if (results.has(spec.id)) throw new Error(`Duplicate experiment graph id: ${spec.id}`);
    results.set(
      spec.id,
      await executeComputeGraph<TIn, TOut, TContext>(spec, registry, input, context, memo),
    );
  }
  return { results, cacheHits: memo.hits, executedNodes: memo.executions };
}

/** Synchronously evaluate multiple candidate graph recipes on shared input with prefix memoization. */
export function runSyncGraphExperiments<TIn, TOut, TContext = unknown>(
  specs: readonly ComputeGraphSpec[],
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
  memo = new ComputeMemoCache(),
): GraphExperimentOutcome<TOut> {
  const results = new Map<string, TOut>();
  for (const spec of specs) {
    if (results.has(spec.id)) throw new Error(`Duplicate experiment graph id: ${spec.id}`);
    results.set(
      spec.id,
      evaluateSyncComputeGraph<TIn, TOut, TContext>(spec, registry, input, context, memo),
    );
  }
  return { results, cacheHits: memo.hits, executedNodes: memo.executions };
}

/** Return a copy of a graph recipe with one node's operator, params, or subgraph replaced. */
export function replaceGraphNode(
  spec: ComputeGraphSpec,
  nodeId: string,
  replacement: Omit<ComputeNodeSpec, "id">,
  nextGraphId = `${spec.id}:${nodeId}`,
): ComputeGraphSpec {
  let replaced = false;
  const nodes = spec.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    replaced = true;
    return { id: node.id, ...replacement };
  });
  if (!replaced) throw new Error(`Cannot replace missing node '${nodeId}' in graph '${spec.id}'`);
  return { ...spec, id: nextGraphId, nodes };
}

/** Compare two graph recipes node-by-node for experiment auditing. */
export function diffGraphSpecs(left: ComputeGraphSpec, right: ComputeGraphSpec): GraphDiffEntry[] {
  const leftNodes = new Map(left.nodes.map((node) => [node.id, canonicalValue(node)]));
  const rightNodes = new Map(right.nodes.map((node) => [node.id, canonicalValue(node)]));
  const ids = [...new Set([...leftNodes.keys(), ...rightNodes.keys()])].sort();
  const diffs: GraphDiffEntry[] = [];
  for (const nodeId of ids) {
    const l = leftNodes.get(nodeId);
    const r = rightNodes.get(nodeId);
    if (l === undefined) diffs.push({ nodeId, status: "added" });
    else if (r === undefined) diffs.push({ nodeId, status: "removed" });
    else if (l !== r) diffs.push({ nodeId, status: "modified" });
  }
  return diffs;
}

function dominates<TItem>(
  better: TItem,
  other: TItem,
  objectives: readonly ((item: TItem) => number)[],
): boolean {
  let strictlyBetter = false;
  for (const objective of objectives) {
    const bVal = objective(better);
    const oVal = objective(other);
    if (bVal < oVal) return false;
    if (bVal > oVal) strictlyBetter = true;
  }
  return strictlyBetter;
}

/** Extract the non-dominated Pareto frontier across multiple scalar objectives. */
export function findParetoOptimalGraphs<TItem>(
  items: readonly TItem[],
  objectives: readonly ((item: TItem) => number)[],
  predicate?: (item: TItem) => boolean,
): TItem[] {
  const eligible = predicate ? items.filter(predicate) : [...items];
  return eligible.filter(
    (candidate) =>
      !eligible.some((other) => other !== candidate && dominates(other, candidate, objectives)),
  );
}
