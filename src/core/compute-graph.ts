import { createHash } from "node:crypto";

export const INPUT_NODE_ID = "$input";

export interface ComputeNodeSpec {
  readonly id: string;
  readonly op: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly subgraph?: ComputeGraphSpec;
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

/** Registry mapping operator names to pure or contextual functions. */
export class ComputeRegistry<TContext = unknown> {
  private readonly operators = new Map<string, ComputeOperator<TContext>>();

  register(op: string, fn: ComputeOperator<TContext>): this {
    if (!op.trim()) throw new Error("Operator name must be non-empty");
    this.operators.set(op, fn);
    return this;
  }

  has(op: string): boolean {
    return this.operators.has(op);
  }

  get(op: string): ComputeOperator<TContext> {
    const fn = this.operators.get(op);
    if (!fn) throw new Error(`Unknown compute operator: ${op}`);
    return fn;
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
): ComputeNodeSpec[] {
  const queue = spec.nodes.filter((node) => inDegree.get(node.id) === 0).map((node) => node.id);
  const order: ComputeNodeSpec[] = [];
  for (let head = 0; head < queue.length; head += 1) {
    const currentId = queue[head]!;
    order.push(nodeById.get(currentId)!);
    for (const nextId of outgoingByNode.get(currentId)!) {
      const nextDeg = inDegree.get(nextId)! - 1;
      inDegree.set(nextId, nextDeg);
      if (nextDeg === 0) queue.push(nextId);
    }
  }
  if (order.length !== spec.nodes.length) {
    throw new Error(`Compute graph '${spec.id}' contains a cycle`);
  }
  return order;
}

const VALIDATED_GRAPH_CACHE = new WeakMap<ComputeGraphSpec, ValidatedGraph>();
const INPUT_SIG_CACHE = new WeakMap<object, string>();

function validateGraph(spec: ComputeGraphSpec): ValidatedGraph {
  const cached = VALIDATED_GRAPH_CACHE.get(spec);
  if (cached) return cached;
  const nodeById = indexNodes(spec.nodes);
  if (!nodeById.has(spec.output)) {
    throw new Error(`Output node '${spec.output}' missing in graph '${spec.id}'`);
  }
  const { incomingByNode, outgoingByNode, inDegree } = indexEdges(spec, nodeById);
  const order = topoOrder(spec, nodeById, outgoingByNode, inDegree);
  const validated = { nodeById, incomingByNode, order };
  VALIDATED_GRAPH_CACHE.set(spec, validated);
  return validated;
}

function nodeSignature(
  node: ComputeNodeSpec,
  incoming: readonly ComputeEdgeSpec[],
  signatures: ReadonlyMap<string, string>,
): string {
  const upstream = incoming
    .map((edge) => `${edge.port ?? "default"}=${signatures.get(edge.from) ?? ""}`)
    .sort()
    .join("&");
  const subSig = node.subgraph ? sha256Hex(canonicalValue(node.subgraph)) : "";
  return sha256Hex(`${node.op}|${canonicalValue(node.params ?? {})}|${subSig}|${upstream}`);
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
  if (input !== null && typeof input === "object") {
    const cached = INPUT_SIG_CACHE.get(input);
    if (cached) return cached;
    const sig = sha256Hex(canonicalValue(input));
    INPUT_SIG_CACHE.set(input, sig);
    return sig;
  }
  return sha256Hex(canonicalValue(input));
}

function prepareRunState<TIn>(
  spec: ComputeGraphSpec,
  input: TIn,
): {
  validated: ValidatedGraph;
  outputs: Map<string, unknown>;
  signatures: Map<string, string>;
} {
  const validated = validateGraph(spec);
  const outputs = new Map<string, unknown>([[INPUT_NODE_ID, input]]);
  const signatures = new Map<string, string>([[INPUT_NODE_ID, inputSignature(input)]]);
  return { validated, outputs, signatures };
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

/** Execute a hierarchical ComputeGraphSpec asynchronously with optional shared prefix caching. */
export async function executeComputeGraph<TIn, TOut, TContext = unknown>(
  spec: ComputeGraphSpec,
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
  memo?: ComputeMemoCache,
): Promise<TOut> {
  const { validated, outputs, signatures } = prepareRunState(spec, input);
  for (const node of validated.order) {
    const incoming = validated.incomingByNode.get(node.id)!;
    const sig = nodeSignature(node, incoming, signatures);
    signatures.set(node.id, sig);
    const cached = memo?.get(sig);
    if (cached?.found) {
      outputs.set(node.id, cached.value);
      continue;
    }
    const inputs = gatherNodeInputs(incoming, outputs, input);
    const value = node.subgraph
      ? await executeComputeGraph(
          node.subgraph,
          registry,
          Object.keys(inputs).length === 1 && "default" in inputs ? inputs.default : inputs,
          context,
          memo,
        )
      : await registry.get(node.op)(inputs, context, node.params ?? {});
    memo?.set(sig, value);
    outputs.set(node.id, value);
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
  const { validated, outputs, signatures } = prepareRunState(spec, input);
  for (const node of validated.order) {
    const incoming = validated.incomingByNode.get(node.id)!;
    const sig = nodeSignature(node, incoming, signatures);
    signatures.set(node.id, sig);
    const cached = memo?.get(sig);
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
          memo,
        )
      : registry.get(node.op)(inputs, context, node.params ?? {});
    if (isPromiseLike(value)) {
      throw new Error(`Sync compute graph encountered async node '${node.id}' (${node.op})`);
    }
    memo?.set(sig, value);
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
