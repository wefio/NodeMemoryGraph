import { createHash } from "node:crypto";
import { canonicalizeComputeValue } from "./canonical-value.ts";
import type { ComputeGraphSpec, ComputeNodeSpec } from "./compute-contracts.ts";

export type ConfigLayer = "L0" | "L1" | "L2";
export type RuntimePowerProfile = "eco" | "balanced" | "performance";
export type SchedulingObjective = "latency" | "throughput";

export class PolicyViolationError extends Error {
  readonly contractId: string;
  constructor(contractId: string, message: string) {
    super(`Policy violation on contract '${contractId}': ${message}`);
    this.name = "PolicyViolationError";
    this.contractId = contractId;
  }
}

export interface ParameterSchemaEntry<T = unknown> {
  readonly path: string;
  readonly kind: "integer" | "number" | "boolean" | "enum";
  readonly default: T;
  readonly min?: number;
  readonly max?: number;
  readonly values?: readonly T[];
  readonly affectsResult: boolean;
  readonly summary: string;
}

export interface SubgraphOverrideSpec {
  readonly recipeId?: string;
  readonly spec?: ComputeGraphSpec;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly nodeOverrides?: Readonly<Record<string, SubgraphOverrideSpec>>;
}

export interface RuntimePolicyOverride {
  readonly profile?: RuntimePowerProfile;
  readonly objective?: SchedulingObjective;
  readonly maxWorkers?: number;
  readonly minOffloadCpuMs?: number;
  readonly maxConcurrentBackground?: number;
  readonly starvationMaxWaitMs?: number;
}

export interface NmgLayerConfig {
  readonly schemaVersion?: 1;
  readonly allowAlgorithmicOverrides?: boolean;
  readonly allowedAlgorithmicVariants?: readonly string[];
  readonly autoRecall?: {
    readonly tier?: number;
    readonly limit?: number;
    readonly initialTarget?: number;
    readonly strongHitTopGap?: number;
    readonly strongHitInitialTarget?: number;
    readonly graphHops?: number;
  };
  readonly maintenance?: {
    readonly writeThreshold?: number;
    readonly accessThreshold?: number;
    readonly nodeLimit?: number;
    readonly semanticEveryBatches?: number;
    readonly expiryLimit?: number;
    readonly pairLimit?: number;
    readonly topologyNodeLimit?: number;
    readonly autoMergeEnabled?: boolean;
    readonly autoMergeLimit?: number;
  };
  readonly stgSync?: {
    readonly enabled?: boolean;
    readonly limit?: number;
    readonly minimumIntervalMs?: number;
  };
  readonly stgConsolidation?: {
    readonly enabled?: boolean;
    readonly minimumIndependentVotes?: number;
    readonly minimumPosteriorMean?: number;
    readonly minimumConservativeLowerBound?: number;
    readonly minimumRetainedPosteriorMean?: number;
    readonly minimumRetainedConservativeLowerBound?: number;
  };
  readonly runtime?: RuntimePolicyOverride;
  readonly bindings?: Readonly<Record<string, SubgraphOverrideSpec>>;
}

export interface ConfigProvenanceEntry {
  readonly path: string;
  readonly value: unknown;
  readonly layer: ConfigLayer;
  readonly source: string;
  readonly affectsResult: boolean;
}

export const L0_PARAMETER_SCHEMA: readonly ParameterSchemaEntry[] = [
  {
    path: "autoRecall.tier",
    kind: "integer",
    default: 1,
    min: 0,
    max: 3,
    affectsResult: true,
    summary: "Default tier ceiling for automatic recall.",
  },
  {
    path: "autoRecall.limit",
    kind: "integer",
    default: 13,
    min: 1,
    max: 50,
    affectsResult: true,
    summary: "Maximum candidates scanned in automatic recall.",
  },
  {
    path: "autoRecall.initialTarget",
    kind: "integer",
    default: 13,
    min: 1,
    max: 50,
    affectsResult: true,
    summary: "First-pass Fibonacci target in portable recall.",
  },
  {
    path: "autoRecall.strongHitTopGap",
    kind: "number",
    default: 0.05,
    min: 0,
    max: 1,
    affectsResult: true,
    summary: "Relative top-1 to top-2 score margin for strong hits.",
  },
  {
    path: "autoRecall.strongHitInitialTarget",
    kind: "integer",
    default: 3,
    min: 1,
    max: 50,
    affectsResult: true,
    summary: "First-pass disclosure target when strong hit triggers.",
  },
  {
    path: "autoRecall.graphHops",
    kind: "integer",
    default: 0,
    min: 0,
    max: 3,
    affectsResult: true,
    summary: "Default graph expansion hops on search.",
  },
  {
    path: "maintenance.writeThreshold",
    kind: "integer",
    default: 16,
    min: 1,
    max: 1024,
    affectsResult: false,
    summary: "Writes before structural maintenance batch runs.",
  },
  {
    path: "maintenance.accessThreshold",
    kind: "integer",
    default: 32,
    min: 1,
    max: 4096,
    affectsResult: false,
    summary: "Reads before access-driven rebalance.",
  },
  {
    path: "maintenance.nodeLimit",
    kind: "integer",
    default: 4,
    min: 1,
    max: 64,
    affectsResult: false,
    summary: "Nodes processed per maintenance slice.",
  },
  {
    path: "maintenance.semanticEveryBatches",
    kind: "integer",
    default: 8,
    min: 1,
    max: 256,
    affectsResult: false,
    summary: "Batches between semantic maintenance sweeps.",
  },
  {
    path: "maintenance.expiryLimit",
    kind: "integer",
    default: 256,
    min: 1,
    max: 4096,
    affectsResult: false,
    summary: "Max expired rows retired per sweep.",
  },
  {
    path: "maintenance.pairLimit",
    kind: "integer",
    default: 64,
    min: 1,
    max: 1024,
    affectsResult: false,
    summary: "Max candidate edge pairs inspected per sweep.",
  },
  {
    path: "maintenance.topologyNodeLimit",
    kind: "integer",
    default: 32,
    min: 1,
    max: 512,
    affectsResult: false,
    summary: "Nodes scanned per topology sweep.",
  },
  {
    path: "maintenance.autoMergeEnabled",
    kind: "boolean",
    default: false,
    affectsResult: true,
    summary: "Enable automatic topology merge actuation.",
  },
  {
    path: "maintenance.autoMergeLimit",
    kind: "integer",
    default: 1,
    min: 1,
    max: 4,
    affectsResult: true,
    summary: "Max automatic merges per sweep.",
  },
  {
    path: "stgSync.enabled",
    kind: "boolean",
    default: false,
    affectsResult: true,
    summary: "Enable automatic STG to LTG sync.",
  },
  {
    path: "stgSync.limit",
    kind: "integer",
    default: 20,
    min: 1,
    max: 200,
    affectsResult: true,
    summary: "Max records synced per pass.",
  },
  {
    path: "stgSync.minimumIntervalMs",
    kind: "integer",
    default: 300_000,
    min: 1_000,
    max: 86_400_000,
    affectsResult: false,
    summary: "Minimum interval between STG sync runs.",
  },
  {
    path: "stgConsolidation.enabled",
    kind: "boolean",
    default: false,
    affectsResult: true,
    summary: "Promote STG records when claim posteriors clear threshold.",
  },
  {
    path: "stgConsolidation.minimumIndependentVotes",
    kind: "integer",
    default: 3,
    min: 1,
    max: 100,
    affectsResult: true,
    summary: "Minimum independent outcome votes for consolidation.",
  },
  {
    path: "stgConsolidation.minimumPosteriorMean",
    kind: "number",
    default: 0.75,
    min: 0,
    max: 1,
    affectsResult: true,
    summary: "Minimum Beta posterior mean to consolidate.",
  },
  {
    path: "stgConsolidation.minimumConservativeLowerBound",
    kind: "number",
    default: 0.5,
    min: 0,
    max: 1,
    affectsResult: true,
    summary: "Minimum conservative lower bound to consolidate.",
  },
  {
    path: "stgConsolidation.minimumRetainedPosteriorMean",
    kind: "number",
    default: 0.65,
    min: 0,
    max: 1,
    affectsResult: true,
    summary: "Posterior mean floor to retain promoted LTG record.",
  },
  {
    path: "stgConsolidation.minimumRetainedConservativeLowerBound",
    kind: "number",
    default: 0.35,
    min: 0,
    max: 1,
    affectsResult: true,
    summary: "Lower-bound floor to retain promoted LTG record.",
  },
  {
    path: "runtime.profile",
    kind: "enum",
    default: "balanced",
    values: ["eco", "balanced", "performance"],
    affectsResult: false,
    summary: "Host resource & energy budget profile.",
  },
  {
    path: "runtime.objective",
    kind: "enum",
    default: "latency",
    values: ["latency", "throughput"],
    affectsResult: false,
    summary: "Scheduler cost objective (tail latency vs batch throughput).",
  },
  {
    path: "runtime.maxWorkers",
    kind: "integer",
    default: 0,
    min: 0,
    max: 64,
    affectsResult: false,
    summary: "Max local worker threads (0 = auto by profile and CPU cores).",
  },
  {
    path: "runtime.minOffloadCpuMs",
    kind: "number",
    default: 1.5,
    min: 0.1,
    max: 1000,
    affectsResult: false,
    summary: "Minimum estimated CPU cost before offloading to worker thread.",
  },
  {
    path: "runtime.maxConcurrentBackground",
    kind: "integer",
    default: 2,
    min: 1,
    max: 16,
    affectsResult: false,
    summary: "Max concurrent background tasks on shared scheduler.",
  },
  {
    path: "runtime.starvationMaxWaitMs",
    kind: "integer",
    default: 1500,
    min: 100,
    max: 60_000,
    affectsResult: false,
    summary: "Anti-starvation wait ceiling promoting queued background tasks.",
  },
] as const;

const SCHEMA_BY_PATH = new Map(L0_PARAMETER_SCHEMA.map((entry) => [entry.path, entry]));

function validateNumericParameter(spec: ParameterSchemaEntry, raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`${spec.path} must be a finite number`);
  }
  if (spec.kind === "integer" && !Number.isInteger(raw)) {
    throw new Error(`${spec.path} must be an integer`);
  }
  if (spec.min !== undefined && raw < spec.min)
    throw new Error(`${spec.path} must be >= ${spec.min}`);
  if (spec.max !== undefined && raw > spec.max)
    throw new Error(`${spec.path} must be <= ${spec.max}`);
  return raw;
}

export function validateParameterValue(path: string, raw: unknown): unknown {
  const spec = SCHEMA_BY_PATH.get(path);
  if (!spec) throw new Error(`Unknown configuration parameter: ${path}`);
  if (spec.kind === "boolean") {
    if (typeof raw !== "boolean") throw new Error(`${path} must be a boolean`);
    return raw;
  }
  if (spec.kind === "enum") {
    if (!spec.values?.includes(raw))
      throw new Error(`${path} must be one of ${spec.values?.join(", ")}`);
    return raw;
  }
  return validateNumericParameter(spec, raw);
}

function readNested(obj: Record<string, unknown> | undefined, path: string): unknown {
  if (!obj) return undefined;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function writeNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    if (!cur[key] || typeof cur[key] !== "object") cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export interface ResolvedLayerBundle {
  readonly values: Record<string, unknown>;
  readonly provenance: ReadonlyMap<string, ConfigProvenanceEntry>;
  readonly bindings: Readonly<Record<string, SubgraphOverrideSpec>>;
  readonly bindingProvenance: ReadonlyMap<string, { layer: ConfigLayer; source: string }>;
  readonly allowAlgorithmicOverrides: boolean;
  readonly allowedAlgorithmicVariants: readonly string[];
  readonly resultIdentityHash: string;
}

function mergeBindingSpecs(
  base: SubgraphOverrideSpec | undefined,
  over: SubgraphOverrideSpec,
): SubgraphOverrideSpec {
  if (!base) return over;
  const mergedNodes: Record<string, SubgraphOverrideSpec> = { ...(base.nodeOverrides ?? {}) };
  for (const [nodeId, childOver] of Object.entries(over.nodeOverrides ?? {})) {
    mergedNodes[nodeId] = mergeBindingSpecs(mergedNodes[nodeId], childOver);
  }
  return {
    recipeId: over.recipeId ?? base.recipeId,
    spec: over.spec ?? base.spec,
    params: { ...(base.params ?? {}), ...(over.params ?? {}) },
    nodeOverrides: mergedNodes,
  };
}

function resolveEffectiveParameters(layers: {
  readonly l1?: { readonly config?: NmgLayerConfig; readonly source?: string };
  readonly l2?: { readonly config?: NmgLayerConfig; readonly source?: string };
}) {
  const values: Record<string, unknown> = {};
  const provenance = new Map<string, ConfigProvenanceEntry>();
  const l1Obj = layers.l1?.config as Record<string, unknown> | undefined;
  const l2Obj = layers.l2?.config as Record<string, unknown> | undefined;
  for (const spec of L0_PARAMETER_SCHEMA) {
    const l2Val = readNested(l2Obj, spec.path);
    const l1Val = readNested(l1Obj, spec.path);
    const chosen = selectLayeredParam(spec, l1Val, l2Val, layers.l1?.source, layers.l2?.source);
    writeNested(values, spec.path, chosen.value);
    provenance.set(spec.path, chosen);
  }
  return { values, provenance };
}

function selectLayeredParam(
  spec: ParameterSchemaEntry,
  l1Val: unknown,
  l2Val: unknown,
  l1Source: string | undefined,
  l2Source: string | undefined,
): ConfigProvenanceEntry {
  if (l2Val !== undefined) {
    return {
      path: spec.path,
      value: validateParameterValue(spec.path, l2Val),
      layer: "L2",
      source: l2Source ?? "adapter",
      affectsResult: spec.affectsResult,
    };
  }
  if (l1Val !== undefined) {
    return {
      path: spec.path,
      value: validateParameterValue(spec.path, l1Val),
      layer: "L1",
      source: l1Source ?? "shared",
      affectsResult: spec.affectsResult,
    };
  }
  return {
    path: spec.path,
    value: spec.default,
    layer: "L0",
    source: "builtin",
    affectsResult: spec.affectsResult,
  };
}

function mergeLayerBindings(layers: {
  readonly l1?: { readonly config?: NmgLayerConfig; readonly source?: string };
  readonly l2?: { readonly config?: NmgLayerConfig; readonly source?: string };
}) {
  const bindings: Record<string, SubgraphOverrideSpec> = {};
  const bindingProvenance = new Map<string, { layer: ConfigLayer; source: string }>();
  for (const [contractId, spec] of Object.entries(layers.l1?.config?.bindings ?? {})) {
    bindings[contractId] = spec;
    bindingProvenance.set(contractId, { layer: "L1", source: layers.l1?.source ?? "shared" });
  }
  for (const [contractId, spec] of Object.entries(layers.l2?.config?.bindings ?? {})) {
    bindings[contractId] = mergeBindingSpecs(bindings[contractId], spec);
    bindingProvenance.set(contractId, { layer: "L2", source: layers.l2?.source ?? "adapter" });
  }
  return { bindings, bindingProvenance };
}

/** Merge L0 defaults -> L1 shared config -> L2 adapter config with strict contract validation. */
export function resolveLayeredConfig(layers: {
  readonly l1?: { readonly config?: NmgLayerConfig; readonly source?: string };
  readonly l2?: { readonly config?: NmgLayerConfig; readonly source?: string };
}): ResolvedLayerBundle {
  const { values, provenance } = resolveEffectiveParameters(layers);
  const { bindings, bindingProvenance } = mergeLayerBindings(layers);
  const allowAlgorithmicOverrides =
    layers.l2?.config?.allowAlgorithmicOverrides ??
    layers.l1?.config?.allowAlgorithmicOverrides ??
    false;
  const allowedAlgorithmicVariants = [
    ...new Set([
      ...(layers.l1?.config?.allowedAlgorithmicVariants ?? []),
      ...(layers.l2?.config?.allowedAlgorithmicVariants ?? []),
    ]),
  ];
  const resultEntries = [...provenance.values()]
    .filter((entry) => entry.affectsResult)
    .map((entry) => [entry.path, entry.value]);
  const resultIdentityHash = createHash("sha256")
    .update(canonicalizeComputeValue({ params: resultEntries, bindings }))
    .digest("hex")
    .slice(0, 24);

  return {
    values,
    provenance,
    bindings,
    bindingProvenance,
    allowAlgorithmicOverrides,
    allowedAlgorithmicVariants,
    resultIdentityHash,
  };
}

function selectRecipeSpec(
  contractId: string,
  defaultSpec: ComputeGraphSpec,
  override: SubgraphOverrideSpec | undefined,
  recipes: Readonly<Record<string, ComputeGraphSpec>> | undefined,
  policy: { allowAlgorithmicOverrides: boolean; allowedAlgorithmicVariants: readonly string[] },
): ComputeGraphSpec {
  if (!override?.recipeId && !override?.spec) return defaultSpec;
  if (override.spec) {
    if (!policy.allowAlgorithmicOverrides) {
      throw new PolicyViolationError(
        contractId,
        `inline spec override '${override.spec.id}' requires allowAlgorithmicOverrides`,
      );
    }
    return override.spec;
  }
  const recipeId = override.recipeId!;
  const chosen = recipes?.[recipeId];
  if (!chosen) throw new PolicyViolationError(contractId, `unknown recipe '${recipeId}'`);
  const permitted =
    chosen.id === defaultSpec.id ||
    policy.allowAlgorithmicOverrides ||
    policy.allowedAlgorithmicVariants.includes(recipeId);
  if (!permitted) {
    throw new PolicyViolationError(
      contractId,
      `recipe '${recipeId}' alters retrieval semantics and is not in allowedAlgorithmicVariants`,
    );
  }
  return chosen;
}

function applyNodeOverride(
  contractId: string,
  node: ComputeNodeSpec,
  nodeOverride: SubgraphOverrideSpec | undefined,
  recipes: Readonly<Record<string, ComputeGraphSpec>> | undefined,
  policy: { allowAlgorithmicOverrides: boolean; allowedAlgorithmicVariants: readonly string[] },
): ComputeNodeSpec {
  if (!nodeOverride) return node;
  let nextSubgraph = node.subgraph;
  if (nextSubgraph) {
    nextSubgraph = materializeBoundGraph(contractId, nextSubgraph, nodeOverride, recipes, policy);
  }
  const nextParams = nodeOverride.params
    ? { ...(node.params ?? {}), ...nodeOverride.params }
    : node.params;
  return {
    ...node,
    ...(nextParams ? { params: nextParams } : {}),
    ...(nextSubgraph ? { subgraph: nextSubgraph } : {}),
  };
}

/** Recursively bind L1/L2 recipe selection and parameter overrides onto a ComputeGraphSpec. */
export function materializeBoundGraph(
  contractId: string,
  defaultSpec: ComputeGraphSpec,
  override: SubgraphOverrideSpec | undefined,
  recipes: Readonly<Record<string, ComputeGraphSpec>> | undefined,
  policy: { allowAlgorithmicOverrides: boolean; allowedAlgorithmicVariants: readonly string[] },
): ComputeGraphSpec {
  const base = selectRecipeSpec(contractId, defaultSpec, override, recipes, policy);
  if (!override?.nodeOverrides && !override?.params) return base;
  const nodes = base.nodes.map((node) => {
    const childOverride = override.nodeOverrides?.[node.id];
    const withRootParams =
      !node.subgraph && override.params
        ? { ...node, params: { ...(node.params ?? {}), ...override.params } }
        : node;
    return applyNodeOverride(contractId, withRootParams, childOverride, recipes, policy);
  });
  const suffix = createHash("sha256")
    .update(canonicalizeComputeValue(override))
    .digest("hex")
    .slice(0, 8);
  return { ...base, id: `${base.id}@cfg:${suffix}`, nodes };
}
