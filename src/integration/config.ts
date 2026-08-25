export type QppActuationMode = "off" | "shadow" | "active";
export type SearchRecommendationMode = "off" | "advisory" | "guardrail";

export interface MaintenancePolicyConfig {
  writeThreshold: number;
  accessThreshold: number;
  nodeLimit: number;
  semanticEveryBatches: number;
  expiryLimit: number;
  pairLimit: number;
  topologyNodeLimit: number;
  autoMergeEnabled: boolean;
  autoMergeLimit: number;
}

export interface StgConsolidationPolicyConfig {
  enabled: boolean;
  minimumIndependentVotes: number;
  minimumPosteriorMean: number;
  minimumConservativeLowerBound: number;
  minimumRetainedPosteriorMean: number;
  minimumRetainedConservativeLowerBound: number;
}

export interface StgSyncPolicyConfig {
  enabled: boolean;
  limit: number;
  minimumIntervalMs: number;
}

export const DEFAULT_STG_SYNC_POLICY: StgSyncPolicyConfig = {
  enabled: false,
  limit: 20,
  minimumIntervalMs: 5 * 60 * 1_000,
};

export function configuredStgSyncPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): StgSyncPolicyConfig {
  return {
    enabled: environment.NMG_STG_AUTO_SYNC === "1",
    limit: Math.min(
      200,
      positiveInteger(environment.NMG_STG_AUTO_SYNC_LIMIT, DEFAULT_STG_SYNC_POLICY.limit),
    ),
    minimumIntervalMs:
      Math.min(
        86_400,
        positiveInteger(
          environment.NMG_STG_AUTO_SYNC_INTERVAL_SECONDS,
          DEFAULT_STG_SYNC_POLICY.minimumIntervalMs / 1_000,
        ),
      ) * 1_000,
  };
}

export const DEFAULT_STG_CONSOLIDATION_POLICY: StgConsolidationPolicyConfig = {
  // Shadow by default until natural-use precision has been measured.
  enabled: false,
  minimumIndependentVotes: 3,
  minimumPosteriorMean: 0.75,
  minimumConservativeLowerBound: 0.5,
  // Lower than promotion thresholds: a correction reopens the claim without
  // immediately oscillating the materialized LTG projection.
  minimumRetainedPosteriorMean: 0.65,
  minimumRetainedConservativeLowerBound: 0.35,
};

export function configuredStgConsolidationPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): StgConsolidationPolicyConfig {
  const minimumPosteriorMean = boundedNumber(
    environment.NMG_STG_CONSOLIDATE_MIN_MEAN,
    DEFAULT_STG_CONSOLIDATION_POLICY.minimumPosteriorMean,
  );
  const minimumConservativeLowerBound = boundedNumber(
    environment.NMG_STG_CONSOLIDATE_MIN_LOWER_BOUND,
    DEFAULT_STG_CONSOLIDATION_POLICY.minimumConservativeLowerBound,
  );
  return {
    enabled: environment.NMG_STG_AUTO_CONSOLIDATE === "1",
    minimumIndependentVotes: positiveInteger(
      environment.NMG_STG_CONSOLIDATE_MIN_VOTES,
      DEFAULT_STG_CONSOLIDATION_POLICY.minimumIndependentVotes,
    ),
    minimumPosteriorMean,
    minimumConservativeLowerBound,
    minimumRetainedPosteriorMean: Math.min(
      minimumPosteriorMean,
      boundedNumber(
        environment.NMG_STG_RETAIN_MIN_MEAN,
        DEFAULT_STG_CONSOLIDATION_POLICY.minimumRetainedPosteriorMean,
      ),
    ),
    minimumRetainedConservativeLowerBound: Math.min(
      minimumConservativeLowerBound,
      boundedNumber(
        environment.NMG_STG_RETAIN_MIN_LOWER_BOUND,
        DEFAULT_STG_CONSOLIDATION_POLICY.minimumRetainedConservativeLowerBound,
      ),
    ),
  };
}

export const DEFAULT_MAINTENANCE_POLICY: MaintenancePolicyConfig = {
  writeThreshold: 16,
  accessThreshold: 32,
  nodeLimit: 4,
  semanticEveryBatches: 8,
  expiryLimit: 256,
  pairLimit: 64,
  topologyNodeLimit: 32,
  autoMergeEnabled: false,
  autoMergeLimit: 1,
};

export function configuredMaintenancePolicy(
  environment: NodeJS.ProcessEnv = process.env,
): MaintenancePolicyConfig {
  return {
    writeThreshold: positiveInteger(
      environment.NMG_MAINTENANCE_WRITE_THRESHOLD,
      DEFAULT_MAINTENANCE_POLICY.writeThreshold,
    ),
    accessThreshold: positiveInteger(
      environment.NMG_MAINTENANCE_ACCESS_THRESHOLD,
      DEFAULT_MAINTENANCE_POLICY.accessThreshold,
    ),
    nodeLimit: Math.min(
      64,
      positiveInteger(environment.NMG_MAINTENANCE_NODE_LIMIT, DEFAULT_MAINTENANCE_POLICY.nodeLimit),
    ),
    semanticEveryBatches: positiveInteger(
      environment.NMG_MAINTENANCE_SEMANTIC_EVERY,
      DEFAULT_MAINTENANCE_POLICY.semanticEveryBatches,
    ),
    expiryLimit: DEFAULT_MAINTENANCE_POLICY.expiryLimit,
    pairLimit: DEFAULT_MAINTENANCE_POLICY.pairLimit,
    topologyNodeLimit: DEFAULT_MAINTENANCE_POLICY.topologyNodeLimit,
    autoMergeEnabled: environment.NMG_TOPOLOGY_AUTO_MERGE === "1",
    autoMergeLimit: Math.min(
      4,
      positiveInteger(
        environment.NMG_TOPOLOGY_AUTO_MERGE_LIMIT,
        DEFAULT_MAINTENANCE_POLICY.autoMergeLimit,
      ),
    ),
  };
}

export function configuredGraphHops(fallback: number): number {
  const configured = Number.parseInt(process.env.NMG_GRAPH_HOPS ?? "", 10);
  return Number.isInteger(configured) ? Math.max(0, Math.min(configured, 3)) : fallback;
}

export function configuredQpp1Mode(environment: NodeJS.ProcessEnv = process.env): QppActuationMode {
  const configured = parseMode(environment.NMG_QPP1_MODE, ["off", "shadow", "active"]);
  if (configured) return configured;
  if (environment.NMG_CONTROLLER_SEARCH === "1") return "active";
  if (environment.NMG_CONTROLLER_SEARCH === "0") return "shadow";
  return "shadow";
}

export function configuredQpp2Mode(environment: NodeJS.ProcessEnv = process.env): QppActuationMode {
  return parseMode(environment.NMG_QPP2_MODE, ["off", "shadow", "active"]) ?? "off";
}

export function configuredControllerRerankMode(
  environment: NodeJS.ProcessEnv = process.env,
): QppActuationMode {
  return parseMode(environment.NMG_CONTROLLER_RERANK, ["off", "shadow", "active"]) ?? "off";
}

export function configuredControllerRuntimeMode(
  environment: NodeJS.ProcessEnv = process.env,
): import("./controller-channel.ts").ControllerRuntimeMode {
  return (
    parseMode(environment.NMG_CONTROLLER_RUNTIME_MODE, ["off", "shadow", "controlled", "active"]) ??
    "shadow"
  );
}

export function configuredQpp2RetainedMass(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.NMG_QPP2_RETAINED_MASS ?? 0.98);
  return Number.isFinite(configured) ? Math.max(0, Math.min(configured, 1)) : 0.98;
}

export function configuredSearchRecommendationMode(
  environment: NodeJS.ProcessEnv = process.env,
): SearchRecommendationMode {
  return (
    parseMode(environment.NMG_SEARCH_RECOMMENDATION, ["off", "advisory", "guardrail"]) ?? "off"
  );
}

function parseMode<const T extends string>(
  value: string | undefined,
  modes: readonly T[],
): T | undefined {
  const normalized = value?.trim().toLowerCase();
  return modes.find((mode) => mode === normalized);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedNumber(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 1)) : fallback;
}
