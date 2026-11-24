export const COMPUTE_CACHE_TOKEN = Symbol.for("nmg.compute.cacheToken");
export const COMPUTE_STATE_STAMP = Symbol.for("nmg.compute.stateStamp");
export const SUBGRAPH_OPERATOR_META = Symbol.for("nmg.compute.subgraphMeta");

export interface ComputeStateStamp {
  readonly namespace?: string;
  readonly revision?: number | string;
  readonly snapshotId?: string | number;
  readonly modelVersion?: string;
  readonly envVersion?: string;
  readonly extra?: Readonly<Record<string, string | number | boolean | null>>;
}

export type ComputeEffectKind = "pure" | "read" | "nondeterministic" | "write" | "opaque";

export type ComputeExternalDep =
  "storage_snapshot" | "vector_index" | "clock" | "model" | "external_service";

export interface ComputeResourceProfile {
  readonly execution?: "sync" | "async_io" | "cpu";
  readonly backend?: "js" | "sqlite" | "external";
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly exclusive?: readonly string[];
}

export interface ComputeCostHint {
  readonly baseMs?: number;
  readonly perItemUs?: number;
}

export interface ComputeLoweringDescriptor {
  readonly target: "sqlite" | "js" | "numeric" | "external";
  readonly exprKind?: string;
}

export interface ComputeRegisterOptions {
  readonly version?: string;
  /** Legacy write marker alias: `true` implies `effect: "write"`. */
  readonly sideEffect?: boolean;
  readonly effect?: ComputeEffectKind;
  readonly contract?: string | readonly string[];
  readonly applicability?: string;
  readonly ports?: {
    readonly inputs?: readonly string[];
    readonly output?: string;
  };
  readonly deterministic?: boolean;
  readonly cacheable?: boolean;
  readonly immutableOutput?: boolean;
  readonly parallelSafe?: boolean;
  readonly reorderable?: boolean;
  readonly eliminable?: boolean;
  readonly batchable?: boolean;
  readonly idempotentWrite?: boolean;
  readonly transactional?: boolean;
  readonly externalDeps?: readonly ComputeExternalDep[];
  readonly resources?: ComputeResourceProfile;
  readonly costHint?: ComputeCostHint;
  readonly lowering?: ComputeLoweringDescriptor;
}

export interface ResolvedOperatorCapabilities {
  readonly version: string;
  readonly effect: ComputeEffectKind;
  readonly contracts: readonly string[];
  readonly applicability?: string;
  readonly ports?: {
    readonly inputs?: readonly string[];
    readonly output?: string;
  };
  readonly deterministic: boolean;
  readonly cacheable: boolean;
  readonly immutableOutput: boolean;
  readonly parallelSafe: boolean;
  readonly reorderable: boolean;
  readonly eliminable: boolean;
  readonly batchable: boolean;
  readonly idempotentWrite: boolean;
  readonly transactional: boolean;
  readonly externalDeps: readonly ComputeExternalDep[];
  readonly resources: ComputeResourceProfile;
  readonly costHint?: ComputeCostHint;
  readonly lowering?: ComputeLoweringDescriptor;
}

export const INPUT_NODE_ID = "$input";

export interface ComputeNodeSpec {
  readonly id: string;
  readonly op: string;
  /** Optional logical contract identifier resolved by the planner when `op` is `"$contract"` or empty. */
  readonly contract?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Node realization form 3: nested subgraph. */
  readonly subgraph?: ComputeGraphSpec;
  /** Node realization form 4: inline function / third-party closure override. */
  readonly fn?: ComputeOperatorFn<unknown>;
  /** Node realization form 5: structured expression eligible for backend compilation/lowering. */
  readonly expression?: StructuredComputeExpr;
  /** Mark nodes that mutate external/DB state so memo caching and downstream caching are bypassed. */
  readonly sideEffect?: boolean;
  /** Optional per-node capability override. */
  readonly meta?: ComputeRegisterOptions;
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

export interface ComputeOperatorLookup<TContext = unknown> {
  readonly generation: number;
  has(op: string): boolean;
  get(op: string): ComputeOperatorFn<TContext>;
  getCapabilities(op: string): ResolvedOperatorCapabilities;
  findByContract(contractId: string): string | undefined;
}

export interface SubgraphOperatorMeta<TContext = unknown> {
  readonly spec: ComputeGraphSpec;
  readonly registry: ComputeOperatorLookup<TContext>;
}

export interface ComputeContractSpec {
  readonly id: string;
  readonly summary: string;
  readonly inputPorts: readonly string[];
  readonly outputType: string;
  readonly invariants?: readonly string[];
}

export interface RelationalQueryExpr {
  readonly kind: "relational_query";
  readonly operation: "project_memories";
  readonly pushdownPreferred?: boolean;
}

export type StructuredComputeExpr = RelationalQueryExpr;

export type ComputeOperatorFn<TContext = unknown> = (
  inputs: Readonly<Record<string, unknown>>,
  context: TContext,
  params: Readonly<Record<string, unknown>>,
) => unknown;

export interface ComputeOperatorModule<TContext = unknown> {
  readonly op: string;
  readonly meta: ComputeRegisterOptions;
  readonly execute: ComputeOperatorFn<TContext>;
}

/** Attach an explicit external state stamp onto a read/execution context. */
export function attachStateStamp<T extends object>(target: T, stamp: ComputeStateStamp): T {
  Object.defineProperty(target, COMPUTE_STATE_STAMP, {
    value: stamp,
    enumerable: false,
    configurable: true,
  });
  return target;
}

/** Extract ComputeStateStamp from either Symbol metadata or `$stamp` property. */
export function readStateStamp(context: unknown): ComputeStateStamp | undefined {
  if (context === null || typeof context !== "object") return undefined;
  const record = context as {
    [COMPUTE_STATE_STAMP]?: ComputeStateStamp;
    $stamp?: ComputeStateStamp;
  };
  return record[COMPUTE_STATE_STAMP] ?? record.$stamp;
}

/** Bind an explicit cache-identity token to a dynamic or closure-backed function. */
export function withCacheToken<TFn extends (...args: never[]) => unknown>(
  fn: TFn,
  token: string,
): TFn {
  Object.defineProperty(fn, COMPUTE_CACHE_TOKEN, {
    value: token,
    enumerable: false,
    configurable: true,
  });
  return fn;
}

function normalizeContracts(contract?: string | readonly string[]): readonly string[] {
  if (!contract) return [];
  return typeof contract === "string" ? [contract] : [...contract];
}

function inferEffect(options?: ComputeRegisterOptions): ComputeEffectKind {
  if (options?.sideEffect === true) return "write";
  return options?.effect ?? "opaque";
}

function defaultFlagsForEffect(effect: ComputeEffectKind) {
  switch (effect) {
    case "pure":
      return {
        deterministic: true,
        cacheable: true,
        parallelSafe: true,
        reorderable: true,
        eliminable: true,
      };
    case "read":
      return {
        deterministic: true,
        cacheable: false,
        parallelSafe: false,
        reorderable: false,
        eliminable: true,
      };
    case "nondeterministic":
      return {
        deterministic: false,
        cacheable: false,
        parallelSafe: false,
        reorderable: false,
        eliminable: false,
      };
    case "write":
    case "opaque":
      return {
        deterministic: false,
        cacheable: false,
        parallelSafe: false,
        reorderable: false,
        eliminable: false,
      };
  }
}

function pickFlag(locked: boolean, override: boolean | undefined, fallback: boolean): boolean {
  if (locked) return false;
  return override ?? fallback;
}

function resolveSafetyFlags(effect: ComputeEffectKind, options?: ComputeRegisterOptions) {
  const defaults = defaultFlagsForEffect(effect);
  const locked = effect === "write" || effect === "opaque";
  const isRead = effect === "read";
  const opts = options ?? {};
  return {
    deterministic: effect === "pure" || (isRead && opts.deterministic !== false),
    cacheable: pickFlag(
      locked || effect === "nondeterministic",
      opts.cacheable,
      defaults.cacheable,
    ),
    immutableOutput: Boolean(opts.immutableOutput),
    parallelSafe: pickFlag(locked, opts.parallelSafe, defaults.parallelSafe),
    reorderable: pickFlag(
      locked || effect === "nondeterministic",
      opts.reorderable,
      defaults.reorderable,
    ),
    eliminable: pickFlag(locked, opts.eliminable, defaults.eliminable),
  };
}

function optionalCapabilityMeta(options?: ComputeRegisterOptions) {
  return {
    ...(options?.applicability ? { applicability: options.applicability } : {}),
    ...(options?.ports ? { ports: options.ports } : {}),
    ...(options?.costHint ? { costHint: options.costHint } : {}),
    ...(options?.lowering ? { lowering: options.lowering } : {}),
  };
}

/** Resolve progressive operator metadata into conservative execution & optimizer capabilities. */
export function resolveCapabilities(
  options?: ComputeRegisterOptions,
): ResolvedOperatorCapabilities {
  const effect = inferEffect(options);
  return {
    version: options?.version ?? "v1",
    effect,
    contracts: normalizeContracts(options?.contract),
    ...resolveSafetyFlags(effect, options),
    ...optionalCapabilityMeta(options),
    batchable: Boolean(options?.batchable),
    idempotentWrite: Boolean(options?.idempotentWrite),
    transactional: Boolean(options?.transactional),
    externalDeps: options?.externalDeps ? [...options.externalDeps] : [],
    resources: options?.resources ?? {},
  };
}

/** Combine capabilities across child operators in a composite subgraph. */
export function combineChildCapabilities(
  children: readonly ResolvedOperatorCapabilities[],
  version = "subgraph-v1",
): ResolvedOperatorCapabilities {
  if (!children.length) {
    return resolveCapabilities({ version, effect: "pure" });
  }
  const effects = new Set(children.map((c) => c.effect));
  const effect: ComputeEffectKind = effects.has("write")
    ? "write"
    : effects.has("opaque")
      ? "opaque"
      : effects.has("nondeterministic")
        ? "nondeterministic"
        : effects.has("read")
          ? "read"
          : "pure";
  const deps = new Set<ComputeExternalDep>();
  for (const child of children) {
    for (const dep of child.externalDeps) deps.add(dep);
  }
  return {
    version,
    effect,
    contracts: [],
    deterministic: children.every((c) => c.deterministic),
    cacheable: (effect === "pure" || effect === "read") && children.every((c) => c.cacheable),
    immutableOutput: children.every((c) => c.immutableOutput),
    parallelSafe: children.every((c) => c.parallelSafe),
    reorderable: children.every((c) => c.reorderable),
    eliminable: children.every((c) => c.eliminable),
    batchable: false,
    idempotentWrite: false,
    transactional: false,
    externalDeps: [...deps],
    resources: {},
  };
}

/** Verify whether context supplies all required state stamps for an effect="read" operator. */
export function hasRequiredStateStamp(
  capabilities: ResolvedOperatorCapabilities,
  context: unknown,
): boolean {
  if (capabilities.effect === "pure") return true;
  if (capabilities.effect !== "read" || !capabilities.cacheable) return false;
  if (!capabilities.externalDeps.length) return true;
  const stamp = readStateStamp(context);
  if (!stamp) return false;
  for (const dep of capabilities.externalDeps) {
    if (!hasDependencyStamp(dep, stamp)) return false;
  }
  return true;
}

function hasDependencyStamp(dep: ComputeExternalDep, stamp: ComputeStateStamp): boolean {
  switch (dep) {
    case "storage_snapshot":
      return (
        stamp.namespace !== undefined &&
        (stamp.revision !== undefined || stamp.snapshotId !== undefined)
      );
    case "vector_index":
    case "model":
      return stamp.modelVersion !== undefined;
    case "clock":
      return stamp.extra?.now !== undefined;
    case "external_service":
      return stamp.envVersion !== undefined;
  }
}

export const MEMORY_COMPUTE_CONTRACTS: readonly ComputeContractSpec[] = [
  {
    id: "memory.query_analysis",
    summary: "Validate query parameters and derive normalized time windows.",
    inputPorts: ["default"],
    outputType: "AnalyzedSearchQuery",
  },
  {
    id: "memory.candidate_recall",
    summary: "Retrieve candidate memory entities from lexical, vector, or hybrid indexes.",
    inputPorts: ["default", "analysis"],
    outputType: "MemorySearchCandidateBatch",
  },
  {
    id: "memory.rank_fusion",
    summary: "Merge multi-channel candidates into calibrated combined scores.",
    inputPorts: ["default", "lexical", "vector"],
    outputType: "ScoredMemoryCandidate[]",
  },
  {
    id: "memory.candidate_rerank",
    summary: "Reorder candidates via composable scoring signals without altering visibility.",
    inputPorts: ["default", "candidates", "request"],
    outputType: "ScoredCandidate[]",
  },
  {
    id: "memory.neighborhood_expand",
    summary: "Expand context with adjacent source turns, due reminders, leaf peers, or graph hops.",
    inputPorts: ["default", "candidates", "analysis"],
    outputType: "ExpandedMemoryCandidates",
  },
  {
    id: "memory.context_assemble",
    summary:
      "Attach derived tesserae, chain projections, and retrieval metadata into MemoryContext.",
    inputPorts: ["default", "candidates", "relations", "analysis"],
    outputType: "MemoryContext",
  },
  {
    id: "memory.graph_projection",
    summary: "Project relational memories into a typed on-demand multi-dimensional graph.",
    inputPorts: ["default", "memories", "nodes", "edges"],
    outputType: "MemoryGraphProjection",
  },
  {
    id: "memory.profile_projection",
    summary: "Resolve ordered user profile head directives and rank context lines.",
    inputPorts: ["default"],
    outputType: "string | MemoryContext",
  },
  {
    id: "memory.write_preprocess",
    summary:
      "Deterministically extract markers, directives, and recall triggers before persistence.",
    inputPorts: ["default"],
    outputType: "PreprocessedHttpMessage",
  },
  {
    id: "memory.write_plan",
    summary: "Compute an uncommitted change plan over a pinned read snapshot for backend commit.",
    inputPorts: ["default"],
    outputType: "PlannedCommitPayload",
  },
  {
    id: "memory.lifecycle_plan",
    summary:
      "Validate transitions and compute lifecycle mutation entities without committing directly.",
    inputPorts: ["default"],
    outputType: "PlannedCommitPayload",
  },
];

/** Registry tracking logical memory contracts for discovery and structural validation. */
export class ComputeContractRegistry {
  private readonly contracts = new Map<string, ComputeContractSpec>();

  constructor(initial: readonly ComputeContractSpec[] = MEMORY_COMPUTE_CONTRACTS) {
    for (const spec of initial) this.contracts.set(spec.id, spec);
  }

  register(spec: ComputeContractSpec): this {
    if (!spec.id.trim()) throw new Error("Contract id must be non-empty");
    this.contracts.set(spec.id, spec);
    return this;
  }

  has(id: string): boolean {
    return this.contracts.has(id);
  }

  get(id: string): ComputeContractSpec | undefined {
    return this.contracts.get(id);
  }

  list(): ComputeContractSpec[] {
    return [...this.contracts.values()];
  }
}

export const DEFAULT_COMPUTE_CONTRACTS = new ComputeContractRegistry();

/** Adapt an external or third-party black-box algorithm into an NMG ComputeOperatorModule. */
export function adaptExternalAlgorithm<TInput, TResult, TContext = unknown>(config: {
  readonly op: string;
  readonly invoke: (
    input: TInput,
    context: TContext,
    params: Readonly<Record<string, unknown>>,
  ) => TResult;
  readonly mapInput?: (inputs: Readonly<Record<string, unknown>>, context: TContext) => TInput;
  readonly mapOutput?: (
    result: TResult,
    inputs: Readonly<Record<string, unknown>>,
    context: TContext,
  ) => unknown;
  readonly meta?: ComputeRegisterOptions;
}): ComputeOperatorModule<TContext> {
  return {
    op: config.op,
    meta: config.meta ?? { version: "external-v1", effect: "opaque" },
    execute: (inputs, context, params) => {
      const mappedIn = config.mapInput
        ? config.mapInput(inputs, context)
        : (inputs.default as TInput);
      const result = config.invoke(mappedIn, context, params);
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
        return Promise.resolve(result).then((resolved) =>
          config.mapOutput ? config.mapOutput(resolved, inputs, context) : resolved,
        );
      }
      return config.mapOutput ? config.mapOutput(result, inputs, context) : result;
    },
  };
}
