import { createHash } from "node:crypto";
import {
  COMPUTE_CACHE_TOKEN,
  COMPUTE_STATE_STAMP,
  INPUT_NODE_ID,
  SUBGRAPH_OPERATOR_META,
  combineChildCapabilities,
  hasRequiredStateStamp,
  resolveCapabilities,
  type ComputeEdgeSpec,
  type ComputeGraphSpec,
  type ComputeNodeSpec,
  type ComputeOperatorFn,
  type ComputeOperatorLookup,
  type ComputeOperatorModule,
  type ComputeRegisterOptions,
  type ResolvedOperatorCapabilities,
  type SubgraphOperatorMeta,
} from "./compute-contracts.ts";
import {
  compileComputeGraph,
  type PhysicalExecutionPlan,
  type PhysicalNodePlan,
  type PhysicalPlanOptions,
} from "./compute-planner.ts";

export {
  COMPUTE_CACHE_TOKEN,
  COMPUTE_STATE_STAMP,
  INPUT_NODE_ID,
  SUBGRAPH_OPERATOR_META,
  adaptExternalAlgorithm,
  attachStateStamp,
  readStateStamp,
  resolveCapabilities,
  withCacheToken,
  type ComputeContractSpec,
  type ComputeCostHint,
  type ComputeEdgeSpec,
  type ComputeEffectKind,
  type ComputeExternalDep,
  type ComputeGraphSpec,
  type ComputeLoweringDescriptor,
  type ComputeNodeSpec,
  type ComputeOperatorModule,
  type ComputeRegisterOptions,
  type ComputeResourceProfile,
  type ComputeStateStamp,
  type ResolvedOperatorCapabilities,
  type StructuredComputeExpr,
} from "./compute-contracts.ts";

export {
  compileComputeGraph,
  explainComputePlan,
  type PhysicalExecutionPlan,
  type PhysicalNodePlan,
  type PhysicalPlanOptions,
  type PhysicalWaveGroup,
} from "./compute-planner.ts";

export type ComputeOperator<TContext = unknown> = ComputeOperatorFn<TContext>;

export interface GraphDiffEntry {
  readonly nodeId: string;
  readonly status: "added" | "removed" | "modified";
}

export interface GraphExperimentOutcome<TOut> {
  readonly results: Map<string, TOut>;
  readonly cacheHits: number;
  readonly executedNodes: number;
}

export interface ComputeExecutionDiagnostics {
  peakLiveOutputs: number;
  cacheHits: number;
  executedNodes: number;
  cacheSkips: number;
  plan?: PhysicalExecutionPlan;
}

const FUNCTION_INSTANCE_IDS = new WeakMap<object, number>();
let nextFunctionId = 1;
const FROZEN_ARRAY_SIG_CACHE = new WeakMap<readonly unknown[], string>();
const FROZEN_INPUT_SIG_CACHE = new WeakMap<object, string>();
let executionNonce = 0;

function functionIdentityToken(fn: object): string {
  const explicit = (fn as { [COMPUTE_CACHE_TOKEN]?: unknown })[COMPUTE_CACHE_TOKEN];
  if (typeof explicit === "string" && explicit.length > 0) return `[fn_tok:${explicit}]`;
  let id = FUNCTION_INSTANCE_IDS.get(fn);
  if (id === undefined) {
    id = nextFunctionId;
    nextFunctionId += 1;
    FUNCTION_INSTANCE_IDS.set(fn, id);
  }
  return `[fn_id:${id}]`;
}

function canonicalValue(value: unknown): string {
  if (typeof value === "function") return functionIdentityToken(value);
  if (typeof value === "bigint") return `[bigint:${value.toString()}]`;
  if (typeof value === "symbol") return `[sym:${String(value.description ?? "")}]`;
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
    const stamp = (context as { [COMPUTE_STATE_STAMP]?: unknown })[COMPUTE_STATE_STAMP];
    const entries = Object.entries(context)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) =>
        Array.isArray(item)
          ? `${JSON.stringify(key)}:${arraySignature(item)}`
          : `${JSON.stringify(key)}:${canonicalValue(item)}`,
      );
    const stampPart = stamp === undefined ? "" : `|$stamp:${canonicalValue(stamp)}`;
    return sha256Hex(`{${entries.join(",")}}${stampPart}`);
  }
  return sha256Hex(canonicalValue(context));
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

function safeCloneForCache(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === null || typeof value !== "object") return { ok: true, value };
  if (isDeeplyFrozen(value)) return { ok: true, value };
  try {
    return { ok: true, value: structuredClone(value) };
  } catch {
    return { ok: false };
  }
}

/** Registry mapping operator names to typed, versioned, capability-declared functions. */
export class ComputeRegistry<TContext = unknown> implements ComputeOperatorLookup<TContext> {
  private readonly operators = new Map<string, ComputeOperatorFn<TContext>>();
  private readonly signatures = new Map<string, string>();
  private readonly capabilityMap = new Map<string, ResolvedOperatorCapabilities>();
  private readonly contractDefaults = new Map<string, string>();
  private opGeneration = 0;

  get generation(): number {
    return this.opGeneration;
  }

  register(op: string, fn: ComputeOperatorFn<TContext>, options?: ComputeRegisterOptions): this {
    if (!op.trim()) throw new Error("Operator name must be non-empty");
    this.opGeneration += 1;
    const caps = resolveCapabilities(options);
    this.operators.set(op, fn);
    this.capabilityMap.set(op, caps);
    for (const contractId of caps.contracts) {
      this.contractDefaults.set(contractId, op);
    }
    this.signatures.set(
      op,
      sha256Hex(`${caps.version}:${caps.effect}:${this.opGeneration}:${functionIdentityToken(fn)}`),
    );
    return this;
  }

  registerModule(mod: ComputeOperatorModule<TContext>): this {
    return this.register(mod.op, mod.execute, mod.meta);
  }

  has(op: string): boolean {
    return this.operators.has(op);
  }

  isSideEffect(op: string): boolean {
    const caps = this.getCapabilities(op);
    return (
      caps.effect === "write" || caps.effect === "opaque" || caps.effect === "nondeterministic"
    );
  }

  get(op: string): ComputeOperatorFn<TContext> {
    const fn = this.operators.get(op);
    if (!fn) throw new Error(`Unknown compute operator: ${op}`);
    return fn;
  }

  findByContract(contractId: string): string | undefined {
    return this.contractDefaults.get(contractId);
  }

  getCapabilities(op: string): ResolvedOperatorCapabilities {
    const fn = this.operators.get(op);
    const meta = (fn as unknown as { [SUBGRAPH_OPERATOR_META]?: SubgraphOperatorMeta<TContext> })?.[
      SUBGRAPH_OPERATOR_META
    ];
    if (meta) {
      const childCaps = meta.spec.nodes.map((child) =>
        child.subgraph
          ? combineChildCapabilities(
              child.subgraph.nodes.map((g) => meta.registry.getCapabilities(g.op)),
            )
          : child.fn
            ? resolveCapabilities(child.meta)
            : meta.registry.getCapabilities(child.op),
      );
      return combineChildCapabilities(childCaps, `subgraph@${meta.registry.generation}`);
    }
    const caps = this.capabilityMap.get(op);
    if (!caps) throw new Error(`Unknown compute operator: ${op}`);
    return caps;
  }

  getSignature(op: string): string {
    const fn = this.operators.get(op);
    if (!fn) throw new Error(`Unknown compute operator: ${op}`);
    const meta = (fn as unknown as { [SUBGRAPH_OPERATOR_META]?: SubgraphOperatorMeta<TContext> })?.[
      SUBGRAPH_OPERATOR_META
    ];
    if (meta) {
      return `subgraph:${subgraphSignature(meta.spec, meta.registry)}`;
    }
    return this.signatures.get(op)!;
  }
}

interface CacheEntry {
  readonly value: unknown;
  readonly deeplyFrozen: boolean;
}

/** Bounded LRU structural prefix cache with clone isolation for mutable values. */
export class ComputeMemoCache {
  private readonly values = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  hits = 0;
  executions = 0;
  evictions = 0;
  skippedUncacheable = 0;

  constructor(options?: { readonly maxEntries?: number }) {
    this.maxEntries = Math.max(1, Math.floor(options?.maxEntries ?? 512));
  }

  get size(): number {
    return this.values.size;
  }

  get(key: string): { found: boolean; value: unknown } {
    const entry = this.values.get(key);
    if (!entry) return { found: false, value: undefined };
    // Refresh LRU position.
    this.values.delete(key);
    this.values.set(key, entry);
    this.hits += 1;
    if (entry.deeplyFrozen || entry.value === null || typeof entry.value !== "object") {
      return { found: true, value: entry.value };
    }
    const cloned = safeCloneForCache(entry.value);
    if (!cloned.ok) return { found: false, value: undefined };
    return { found: true, value: cloned.value };
  }

  set(key: string, value: unknown): boolean {
    this.executions += 1;
    const deeplyFrozen = isDeeplyFrozen(value);
    let storedValue = value;
    if (!deeplyFrozen && value !== null && typeof value === "object") {
      const cloned = safeCloneForCache(value);
      if (!cloned.ok) {
        this.skippedUncacheable += 1;
        return false;
      }
      storedValue = cloned.value;
    }
    if (this.values.has(key)) {
      this.values.delete(key);
    } else if (this.values.size >= this.maxEntries) {
      const oldestKey = this.values.keys().next().value;
      if (oldestKey !== undefined) {
        this.values.delete(oldestKey);
        this.evictions += 1;
      }
    }
    this.values.set(key, { value: storedValue, deeplyFrozen });
    return true;
  }

  clear(): void {
    this.values.clear();
    this.hits = 0;
    this.executions = 0;
    this.evictions = 0;
    this.skippedUncacheable = 0;
  }
}

function subgraphSignature<TContext>(
  spec: ComputeGraphSpec,
  registry: ComputeOperatorLookup<TContext> & { getSignature?(op: string): string },
): string {
  const getSig = (op: string) =>
    typeof registry.getSignature === "function" ? registry.getSignature(op) : op;
  const nodeSigs = spec.nodes.map((child) => {
    const resolvedOp =
      (!child.op || child.op === "$contract") && child.contract
        ? (registry.findByContract(child.contract) ?? child.op)
        : child.op;
    const childOpSig = child.subgraph
      ? "subgraph"
      : child.fn
        ? functionIdentityToken(child.fn)
        : getSig(resolvedOp);
    const childSubSig = child.subgraph ? subgraphSignature(child.subgraph, registry) : "";
    return `${child.id}:${resolvedOp}:${childOpSig}:${canonicalValue(child.params ?? {})}:${childSubSig}`;
  });
  return sha256Hex(`${spec.id}|${nodeSigs.join(";")}|${canonicalValue(spec.edges)}|${spec.output}`);
}

function isCacheableNode(
  node: PhysicalNodePlan,
  incoming: readonly ComputeEdgeSpec[],
  signatures: ReadonlyMap<string, string>,
  context: unknown,
): boolean {
  if (!node.capabilities.cacheable) return false;
  if (!hasRequiredStateStamp(node.capabilities, context)) return false;
  for (const edge of incoming) {
    const srcSig = signatures.get(edge.from) ?? "";
    if (srcSig.startsWith("tainted:")) return false;
  }
  return true;
}

function physicalPlanSignature<TContext>(
  plan: PhysicalExecutionPlan,
  registry: ComputeRegistry<TContext>,
): string {
  const parts = plan.order.map((child) => {
    const childOpSig =
      child.kind === "subgraph" && child.subgraphPlan
        ? physicalPlanSignature(child.subgraphPlan, registry)
        : child.kind === "inline_fn" && child.inlineFn
          ? functionIdentityToken(child.inlineFn)
          : child.kind === "fused_chain" && child.fusedSteps
            ? child.fusedSteps
                .map((s) => `${s.id}:${s.op}:${registry.getSignature(s.op)}`)
                .join("+")
            : registry.getSignature(child.op);
    return `${child.id}:${child.op}:${childOpSig}:${canonicalValue(child.params)}:${canonicalValue(child.incoming)}`;
  });
  return sha256Hex(`${plan.logicalGraphId}|${parts.join(";")}|${plan.outputNodeId}`);
}

function computeNodeSignature<TContext>(
  node: PhysicalNodePlan,
  incoming: readonly ComputeEdgeSpec[],
  signatures: ReadonlyMap<string, string>,
  registry: ComputeRegistry<TContext>,
  contextSig: string,
  cacheable: boolean,
): string {
  if (!cacheable) {
    executionNonce += 1;
    return `tainted:${executionNonce}`;
  }
  const upstream = incoming
    .map((edge) => `${edge.port ?? "default"}=${signatures.get(edge.from) ?? ""}`)
    .sort()
    .join("&");
  const opSig =
    node.kind === "subgraph" && node.subgraphPlan
      ? `subgraph:${physicalPlanSignature(node.subgraphPlan, registry)}`
      : node.kind === "inline_fn" && node.inlineFn
        ? functionIdentityToken(node.inlineFn)
        : node.kind === "fused_chain" && node.fusedSteps
          ? node.fusedSteps.map((s) => `${s.op}:${registry.getSignature(s.op)}`).join("+")
          : registry.getSignature(node.op);
  return sha256Hex(`${node.op}|${opSig}|${contextSig}|${canonicalValue(node.params)}|${upstream}`);
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

function releaseConsumedInputs(
  incoming: readonly ComputeEdgeSpec[],
  remaining: Map<string, number>,
  outputs: Map<string, unknown>,
  outputNodeId: string,
): void {
  for (const edge of incoming) {
    if (edge.from === INPUT_NODE_ID || edge.from === outputNodeId) continue;
    const count = remaining.get(edge.from);
    if (count === undefined) continue;
    const next = count - 1;
    remaining.set(edge.from, next);
    if (next <= 0) outputs.delete(edge.from);
  }
}

function unwrapDefaultPayload(inputs: Readonly<Record<string, unknown>>): unknown {
  return Object.keys(inputs).length === 1 && "default" in inputs ? inputs.default : inputs;
}

function resolvedNodeParams(node: PhysicalNodePlan): Readonly<Record<string, unknown>> {
  return node.expression
    ? { ...node.params, $loweredTarget: node.loweredTarget, $expression: node.expression }
    : node.params;
}

function invokeFusedChainSync<TContext>(
  steps: readonly PhysicalNodePlan[],
  registry: ComputeRegistry<TContext>,
  inputs: Record<string, unknown>,
  context: TContext,
): unknown {
  let val = unwrapDefaultPayload(inputs);
  for (const step of steps) {
    const stepInputs = step === steps[0] ? inputs : { default: val };
    val = registry.get(step.op)(stepInputs, context, step.params);
    if (isPromiseLike(val)) {
      throw new Error(`Sync compute graph encountered async node '${step.id}' (${step.op})`);
    }
  }
  return val;
}

async function invokeFusedChainAsync<TContext>(
  steps: readonly PhysicalNodePlan[],
  registry: ComputeRegistry<TContext>,
  inputs: Record<string, unknown>,
  context: TContext,
): Promise<unknown> {
  let val = unwrapDefaultPayload(inputs);
  for (const step of steps) {
    const stepInputs = step === steps[0] ? inputs : { default: val };
    val = await registry.get(step.op)(stepInputs, context, step.params);
  }
  return val;
}

function invokeNodeSync<TContext>(
  node: PhysicalNodePlan,
  registry: ComputeRegistry<TContext>,
  inputs: Record<string, unknown>,
  context: TContext,
  memo: ComputeMemoCache | undefined,
  cacheable: boolean,
): unknown {
  if (node.subgraphPlan) {
    return runSyncPlan(
      node.subgraphPlan,
      registry,
      unwrapDefaultPayload(inputs),
      context,
      cacheable ? memo : undefined,
    );
  }
  if (node.fusedSteps) return invokeFusedChainSync(node.fusedSteps, registry, inputs, context);
  const fn = node.inlineFn ?? registry.get(node.op);
  return fn(inputs, context, resolvedNodeParams(node));
}

function invokeNodeAsync<TContext>(
  node: PhysicalNodePlan,
  registry: ComputeRegistry<TContext>,
  inputs: Record<string, unknown>,
  context: TContext,
  memo: ComputeMemoCache | undefined,
  cacheable: boolean,
): Promise<unknown> {
  if (node.subgraphPlan) {
    return runAsyncPlan(
      node.subgraphPlan,
      registry,
      unwrapDefaultPayload(inputs),
      context,
      cacheable ? memo : undefined,
    );
  }
  if (node.fusedSteps) return invokeFusedChainAsync(node.fusedSteps, registry, inputs, context);
  const fn = node.inlineFn ?? registry.get(node.op);
  return Promise.resolve(fn(inputs, context, resolvedNodeParams(node)));
}

function recordDiag(
  diag: ComputeExecutionDiagnostics | undefined,
  liveSize: number,
  executedDelta: number,
  hitDelta: number,
  skipDelta: number,
): void {
  if (!diag) return;
  if (liveSize > diag.peakLiveOutputs) diag.peakLiveOutputs = liveSize;
  diag.executedNodes += executedDelta;
  diag.cacheHits += hitDelta;
  diag.cacheSkips += skipDelta;
}

function runSyncNodeWithMemo<TContext>(
  node: PhysicalNodePlan,
  registry: ComputeRegistry<TContext>,
  outputs: Map<string, unknown>,
  graphInput: unknown,
  context: TContext,
  memo: ComputeMemoCache,
  signatures: Map<string, string>,
  contextSig: string,
  diagnostics?: ComputeExecutionDiagnostics,
): unknown {
  const cacheable = isCacheableNode(node, node.incoming, signatures, context);
  const sig = computeNodeSignature(
    node,
    node.incoming,
    signatures,
    registry,
    contextSig,
    cacheable,
  );
  signatures.set(node.id, sig);
  const cached = cacheable ? memo.get(sig) : undefined;
  if (cached?.found) {
    recordDiag(diagnostics, outputs.size, 0, 1, 0);
    return cached.value;
  }
  const inputs = gatherNodeInputs(node.incoming, outputs, graphInput);
  const value = invokeNodeSync(node, registry, inputs, context, memo, cacheable);
  if (isPromiseLike(value)) {
    throw new Error(`Sync compute graph encountered async node '${node.id}' (${node.op})`);
  }
  const stored = cacheable ? memo.set(sig, value) : false;
  if (cacheable && !stored) signatures.set(node.id, `tainted:${++executionNonce}`);
  recordDiag(diagnostics, outputs.size, 1, 0, cacheable ? 0 : 1);
  return value;
}

function runSyncPlan<TIn, TOut, TContext>(
  plan: PhysicalExecutionPlan,
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
  memo?: ComputeMemoCache,
  diagnostics?: ComputeExecutionDiagnostics,
): TOut {
  if (diagnostics) diagnostics.plan = plan;
  const outputs = new Map<string, unknown>([[INPUT_NODE_ID, input]]);
  const remaining = new Map<string, number>(plan.consumerCounts);
  const signatures = memo ? new Map([[INPUT_NODE_ID, inputSignature(input)]]) : undefined;
  const contextSig = memo ? contextSignature(context) : "";

  for (const node of plan.order) {
    let value: unknown;
    if (memo && signatures) {
      value = runSyncNodeWithMemo(
        node,
        registry,
        outputs,
        input,
        context,
        memo,
        signatures,
        contextSig,
        diagnostics,
      );
    } else {
      const inputs = gatherNodeInputs(node.incoming, outputs, input);
      value = invokeNodeSync(node, registry, inputs, context, undefined, false);
      if (isPromiseLike(value)) {
        throw new Error(`Sync compute graph encountered async node '${node.id}' (${node.op})`);
      }
      recordDiag(diagnostics, outputs.size, 1, 0, 0);
    }
    outputs.set(node.id, value);
    recordDiag(diagnostics, outputs.size, 0, 0, 0);
    releaseConsumedInputs(node.incoming, remaining, outputs, plan.outputNodeId);
  }
  return outputs.get(plan.outputNodeId) as TOut;
}

async function runAsyncNodeWithMemo<TContext>(
  node: PhysicalNodePlan,
  registry: ComputeRegistry<TContext>,
  outputs: Map<string, unknown>,
  graphInput: unknown,
  context: TContext,
  memo: ComputeMemoCache | undefined,
  signatures: Map<string, string> | undefined,
  contextSig: string,
  diagnostics?: ComputeExecutionDiagnostics,
): Promise<unknown> {
  if (memo && signatures) {
    const cacheable = isCacheableNode(node, node.incoming, signatures, context);
    const sig = computeNodeSignature(
      node,
      node.incoming,
      signatures,
      registry,
      contextSig,
      cacheable,
    );
    signatures.set(node.id, sig);
    const cached = cacheable ? memo.get(sig) : undefined;
    if (cached?.found) {
      recordDiag(diagnostics, outputs.size, 0, 1, 0);
      return cached.value;
    }
    const inputs = gatherNodeInputs(node.incoming, outputs, graphInput);
    const value = await invokeNodeAsync(node, registry, inputs, context, memo, cacheable);
    const stored = cacheable ? memo.set(sig, value) : false;
    if (cacheable && !stored) signatures.set(node.id, `tainted:${++executionNonce}`);
    recordDiag(diagnostics, outputs.size, 1, 0, cacheable ? 0 : 1);
    return value;
  }
  const inputs = gatherNodeInputs(node.incoming, outputs, graphInput);
  const value = await invokeNodeAsync(node, registry, inputs, context, undefined, false);
  recordDiag(diagnostics, outputs.size, 1, 0, 0);
  return value;
}

async function runAsyncPlan<TIn, TOut, TContext>(
  plan: PhysicalExecutionPlan,
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
  memo?: ComputeMemoCache,
  diagnostics?: ComputeExecutionDiagnostics,
): Promise<TOut> {
  if (diagnostics) diagnostics.plan = plan;
  const outputs = new Map<string, unknown>([[INPUT_NODE_ID, input]]);
  const remaining = new Map<string, number>(plan.consumerCounts);
  const useMemo = memo !== undefined;
  const signatures = useMemo ? new Map([[INPUT_NODE_ID, inputSignature(input)]]) : undefined;
  const contextSig = useMemo ? contextSignature(context) : "";

  for (const wave of plan.waves) {
    for (const group of wave.parallelGroups) {
      const results = await Promise.all(
        group.map((node) =>
          runAsyncNodeWithMemo(
            node,
            registry,
            outputs,
            input,
            context,
            memo,
            signatures,
            contextSig,
            diagnostics,
          ),
        ),
      );
      group.forEach((node, index) => {
        outputs.set(node.id, results[index]);
        recordDiag(diagnostics, outputs.size, 0, 0, 0);
        releaseConsumedInputs(node.incoming, remaining, outputs, plan.outputNodeId);
      });
    }
    for (const node of wave.serialNodes) {
      const value = await runAsyncNodeWithMemo(
        node,
        registry,
        outputs,
        input,
        context,
        memo,
        signatures,
        contextSig,
        diagnostics,
      );
      outputs.set(node.id, value);
      recordDiag(diagnostics, outputs.size, 0, 0, 0);
      releaseConsumedInputs(node.incoming, remaining, outputs, plan.outputNodeId);
    }
  }
  return outputs.get(plan.outputNodeId) as TOut;
}

/** Wrap any ComputeGraphSpec into a single composite operator for hierarchical nesting. */
export function graphAsOperator<TContext = unknown>(
  spec: ComputeGraphSpec,
  registry: ComputeRegistry<TContext>,
  memo?: ComputeMemoCache,
): ComputeOperatorFn<TContext> {
  const fn: ComputeOperatorFn<TContext> = (inputs, context) => {
    const payload =
      Object.keys(inputs).length === 1 && "default" in inputs ? inputs.default : inputs;
    return executeComputeGraph(spec, registry, payload, context, memo);
  };
  Object.defineProperty(fn, SUBGRAPH_OPERATOR_META, {
    value: { spec, registry } satisfies SubgraphOperatorMeta<TContext>,
    enumerable: false,
    configurable: true,
  });
  return fn;
}

/** Execute a hierarchical ComputeGraphSpec asynchronously via its compiled PhysicalExecutionPlan. */
export async function executeComputeGraph<TIn, TOut, TContext = unknown>(
  spec: ComputeGraphSpec,
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
  memo?: ComputeMemoCache,
  planOptions?: PhysicalPlanOptions,
  diagnostics?: ComputeExecutionDiagnostics,
): Promise<TOut> {
  const plan = compileComputeGraph(spec, registry, planOptions);
  return runAsyncPlan<TIn, TOut, TContext>(plan, registry, input, context, memo, diagnostics);
}

/** Synchronously evaluate a ComputeGraphSpec via its compiled PhysicalExecutionPlan. */
export function evaluateSyncComputeGraph<TIn, TOut, TContext = unknown>(
  spec: ComputeGraphSpec,
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
  memo?: ComputeMemoCache,
  planOptions?: PhysicalPlanOptions,
  diagnostics?: ComputeExecutionDiagnostics,
): TOut {
  const plan = compileComputeGraph(spec, registry, planOptions);
  return runSyncPlan<TIn, TOut, TContext>(plan, registry, input, context, memo, diagnostics);
}

/** Evaluate multiple candidate graph recipes on shared input with prefix memoization. */
export async function runGraphExperiments<TIn, TOut, TContext = unknown>(
  specs: readonly ComputeGraphSpec[],
  registry: ComputeRegistry<TContext>,
  input: TIn,
  context: TContext,
  planOptions?: PhysicalPlanOptions,
): Promise<GraphExperimentOutcome<TOut>> {
  const memo = new ComputeMemoCache();
  const results = new Map<string, TOut>();
  for (const spec of specs) {
    if (results.has(spec.id)) throw new Error(`Duplicate experiment graph id: ${spec.id}`);
    results.set(
      spec.id,
      await executeComputeGraph<TIn, TOut, TContext>(
        spec,
        registry,
        input,
        context,
        memo,
        planOptions,
      ),
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
  planOptions?: PhysicalPlanOptions,
): GraphExperimentOutcome<TOut> {
  const results = new Map<string, TOut>();
  for (const spec of specs) {
    if (results.has(spec.id)) throw new Error(`Duplicate experiment graph id: ${spec.id}`);
    results.set(
      spec.id,
      evaluateSyncComputeGraph<TIn, TOut, TContext>(
        spec,
        registry,
        input,
        context,
        memo,
        planOptions,
      ),
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
