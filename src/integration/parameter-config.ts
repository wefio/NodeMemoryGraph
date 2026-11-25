import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveNmgDataDir } from "../cli/data-path.ts";
import {
  resolveLayeredConfig,
  type ConfigLayer,
  type ConfigProvenanceEntry,
  type NmgLayerConfig,
  type ResolvedLayerBundle,
  type RuntimePolicyOverride,
  type RuntimePolicy,
} from "../core/capability-config.ts";

export interface EffectiveAutoRecallPolicy {
  readonly tier: 0 | 1 | 2 | 3;
  readonly limit: number;
  readonly initialTarget: number;
  readonly strongHitTopGap: number;
  readonly strongHitInitialTarget: number;
  readonly graphHops: number;
}

export type EffectiveRuntimePolicy = RuntimePolicy;

export interface EffectiveParameterConfig {
  readonly autoRecall: EffectiveAutoRecallPolicy;
  readonly maintenance: {
    readonly writeThreshold: number;
    readonly accessThreshold: number;
    readonly nodeLimit: number;
    readonly semanticEveryBatches: number;
    readonly expiryLimit: number;
    readonly pairLimit: number;
    readonly topologyNodeLimit: number;
    readonly autoMergeEnabled: boolean;
    readonly autoMergeLimit: number;
  };
  readonly stgSync: {
    readonly enabled: boolean;
    readonly limit: number;
    readonly minimumIntervalMs: number;
  };
  readonly stgConsolidation: {
    readonly enabled: boolean;
    readonly minimumIndependentVotes: number;
    readonly minimumPosteriorMean: number;
    readonly minimumConservativeLowerBound: number;
    readonly minimumRetainedPosteriorMean: number;
    readonly minimumRetainedConservativeLowerBound: number;
  };
  readonly runtime: EffectiveRuntimePolicy;
  readonly resultIdentityHash: string;
  readonly provenance: ReadonlyMap<string, ConfigProvenanceEntry>;
  readonly bindingProvenance: ReadonlyMap<string, { layer: ConfigLayer; source: string }>;
}

const FILE_CACHE = new Map<
  string,
  { readonly mtimeMs: number; readonly size: number; readonly config: NmgLayerConfig }
>();

function readJsonLayerFile(filePath: string): NmgLayerConfig | undefined {
  if (!existsSync(filePath)) return undefined;
  const stat = statSync(filePath);
  const cached = FILE_CACHE.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.config;
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as NmgLayerConfig;
  FILE_CACHE.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, config: parsed });
  return parsed;
}

function intEnv(raw: string | undefined, min: number, max: number): number | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  if (!/^-?\d+$/u.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < min) return undefined;
  return Math.min(max, value);
}

function numEnv(raw: string | undefined, min: number, max: number): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < min) return undefined;
  return Math.min(max, value);
}

function envAutoRecallOverrides(env: NodeJS.ProcessEnv): NmgLayerConfig["autoRecall"] | undefined {
  const tier = intEnv(env.NMG_AUTO_RECALL_TIER, 0, 3);
  const limit = intEnv(env.NMG_AUTO_RECALL_LIMIT, 1, 50);
  const initialTarget = intEnv(env.NMG_AUTO_RECALL_INITIAL_TARGET, 1, 50);
  const strongHitTopGap = numEnv(env.NMG_AUTO_RECALL_STRONG_HIT_TOP_GAP, 0, 1);
  const strongHitInitialTarget = intEnv(env.NMG_AUTO_RECALL_STRONG_HIT_INITIAL_TARGET, 1, 50);
  const graphHops = intEnv(env.NMG_GRAPH_HOPS, 0, 3);
  const out = {
    ...(tier !== undefined ? { tier } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(initialTarget !== undefined ? { initialTarget } : {}),
    ...(strongHitTopGap !== undefined ? { strongHitTopGap } : {}),
    ...(strongHitInitialTarget !== undefined ? { strongHitInitialTarget } : {}),
    ...(graphHops !== undefined ? { graphHops } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function envMaintenanceOverrides(
  env: NodeJS.ProcessEnv,
): NmgLayerConfig["maintenance"] | undefined {
  const writeThreshold = intEnv(env.NMG_MAINTENANCE_WRITE_THRESHOLD, 1, 1024);
  const accessThreshold = intEnv(env.NMG_MAINTENANCE_ACCESS_THRESHOLD, 1, 4096);
  const nodeLimit = intEnv(env.NMG_MAINTENANCE_NODE_LIMIT, 1, 64);
  const semanticEveryBatches = intEnv(env.NMG_MAINTENANCE_SEMANTIC_EVERY, 1, 256);
  const autoMergeEnabled = env.NMG_TOPOLOGY_AUTO_MERGE === "1" ? true : undefined;
  const autoMergeLimit = intEnv(env.NMG_TOPOLOGY_AUTO_MERGE_LIMIT, 1, 4);
  const out = {
    ...(writeThreshold !== undefined ? { writeThreshold } : {}),
    ...(accessThreshold !== undefined ? { accessThreshold } : {}),
    ...(nodeLimit !== undefined ? { nodeLimit } : {}),
    ...(semanticEveryBatches !== undefined ? { semanticEveryBatches } : {}),
    ...(autoMergeEnabled !== undefined ? { autoMergeEnabled } : {}),
    ...(autoMergeLimit !== undefined ? { autoMergeLimit } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function envStgSyncOverrides(env: NodeJS.ProcessEnv): NmgLayerConfig["stgSync"] | undefined {
  const enabled = env.NMG_STG_AUTO_SYNC === "1" ? true : undefined;
  const limit = intEnv(env.NMG_STG_AUTO_SYNC_LIMIT, 1, 200);
  const intervalSec = intEnv(env.NMG_STG_AUTO_SYNC_INTERVAL_SECONDS, 1, 86_400);
  const out = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(intervalSec !== undefined ? { minimumIntervalMs: intervalSec * 1000 } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function envStgConsolidationOverrides(
  env: NodeJS.ProcessEnv,
): NmgLayerConfig["stgConsolidation"] | undefined {
  const enabled = env.NMG_STG_AUTO_CONSOLIDATE === "1" ? true : undefined;
  const minimumIndependentVotes = intEnv(env.NMG_STG_CONSOLIDATE_MIN_VOTES, 1, 100);
  const minimumPosteriorMean = numEnv(env.NMG_STG_CONSOLIDATE_MIN_MEAN, 0, 1);
  const minimumConservativeLowerBound = numEnv(env.NMG_STG_CONSOLIDATE_MIN_LOWER_BOUND, 0, 1);
  const retainMean = numEnv(env.NMG_STG_RETAIN_MIN_MEAN, 0, 1);
  const retainLower = numEnv(env.NMG_STG_RETAIN_MIN_LOWER_BOUND, 0, 1);
  const out = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(minimumIndependentVotes !== undefined ? { minimumIndependentVotes } : {}),
    ...(minimumPosteriorMean !== undefined ? { minimumPosteriorMean } : {}),
    ...(minimumConservativeLowerBound !== undefined ? { minimumConservativeLowerBound } : {}),
    ...(retainMean !== undefined
      ? {
          minimumRetainedPosteriorMean:
            minimumPosteriorMean !== undefined
              ? Math.min(minimumPosteriorMean, retainMean)
              : retainMean,
        }
      : {}),
    ...(retainLower !== undefined
      ? {
          minimumRetainedConservativeLowerBound:
            minimumConservativeLowerBound !== undefined
              ? Math.min(minimumConservativeLowerBound, retainLower)
              : retainLower,
        }
      : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function envRuntimeOverrides(env: NodeJS.ProcessEnv): RuntimePolicyOverride | undefined {
  const profileRaw = env.NMG_RUNTIME_PROFILE?.trim().toLowerCase();
  const profile =
    profileRaw === "eco" || profileRaw === "balanced" || profileRaw === "performance"
      ? profileRaw
      : undefined;
  return profile ? { profile } : undefined;
}

const MERGE_SECTIONS = [
  "autoRecall",
  "maintenance",
  "stgSync",
  "stgConsolidation",
  "runtime",
  "bindings",
] as const;

function mergeNmgLayerConfigs(base?: NmgLayerConfig, over?: NmgLayerConfig): NmgLayerConfig {
  if (!base) return over ?? {};
  if (!over) return base;
  const out: Record<string, unknown> = { ...base, ...over };
  for (const key of MERGE_SECTIONS) {
    out[key] = {
      ...((base[key] as Record<string, unknown> | undefined) ?? {}),
      ...((over[key] as Record<string, unknown> | undefined) ?? {}),
    };
  }
  return out as NmgLayerConfig;
}

/** Load shared L1 config from NMG_CONFIG_PATH or <dataDir>/nmg.config.json plus env overrides. */
export function loadSharedL1Config(
  environment: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): { readonly config: NmgLayerConfig; readonly source: string } {
  const explicitPath = environment.NMG_CONFIG_PATH?.trim();
  const resolvedDir = dataDir ?? resolveNmgDataDir(environment);
  const targetPath = explicitPath ? resolve(explicitPath) : join(resolvedDir, "nmg.config.json");
  const fileConfig = readJsonLayerFile(targetPath);
  const envLayer: NmgLayerConfig = {
    autoRecall: envAutoRecallOverrides(environment),
    maintenance: envMaintenanceOverrides(environment),
    stgSync: envStgSyncOverrides(environment),
    stgConsolidation: envStgConsolidationOverrides(environment),
    runtime: envRuntimeOverrides(environment),
  };
  const hasEnv = Object.values(envLayer).some(Boolean);
  return {
    config: mergeNmgLayerConfigs(fileConfig, envLayer),
    source: fileConfig ? (hasEnv ? `${targetPath}+env` : targetPath) : hasEnv ? "env" : "builtin",
  };
}

export interface ResolveParameterConfigOptions {
  readonly l1?: NmgLayerConfig;
  readonly l1Source?: string;
  readonly l2?: NmgLayerConfig;
  readonly l2Source?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly dataDir?: string;
}

export function resolveParameterBundle(options: ResolveParameterConfigOptions = {}): {
  readonly bundle: ResolvedLayerBundle;
  readonly parameters: EffectiveParameterConfig;
} {
  const loadedL1 = options.l1
    ? { config: options.l1, source: options.l1Source ?? "explicit-l1" }
    : loadSharedL1Config(options.environment ?? process.env, options.dataDir);
  const bundle = resolveLayeredConfig({
    l1: loadedL1,
    l2: options.l2 ? { config: options.l2, source: options.l2Source ?? "adapter" } : undefined,
  });
  const stgC = bundle.values.stgConsolidation as EffectiveParameterConfig["stgConsolidation"];
  return {
    bundle,
    parameters: {
      autoRecall: bundle.values.autoRecall as EffectiveAutoRecallPolicy,
      maintenance: bundle.values.maintenance as EffectiveParameterConfig["maintenance"],
      stgSync: bundle.values.stgSync as EffectiveParameterConfig["stgSync"],
      stgConsolidation: {
        ...stgC,
        minimumRetainedPosteriorMean: Math.min(
          stgC.minimumPosteriorMean,
          stgC.minimumRetainedPosteriorMean,
        ),
        minimumRetainedConservativeLowerBound: Math.min(
          stgC.minimumConservativeLowerBound,
          stgC.minimumRetainedConservativeLowerBound,
        ),
      },
      runtime: bundle.values.runtime as EffectiveRuntimePolicy,
      resultIdentityHash: bundle.resultIdentityHash,
      provenance: bundle.provenance,
      bindingProvenance: bundle.bindingProvenance,
    },
  };
}

/** Resolve L0 -> L1 -> L2 parameter values without pulling compute-graph memory modules. */
export function resolveParameterConfig(
  options: ResolveParameterConfigOptions = {},
): EffectiveParameterConfig {
  return resolveParameterBundle(options).parameters;
}
