import type { MemoryTier } from "../core/types.ts";
import { resolveParameterConfig } from "./parameter-config.ts";

export type QppActuationMode = "off" | "shadow" | "active";
export type SearchRecommendationMode = "off" | "advisory" | "guardrail";

/** Cross-Agent coordination is available by default. Explicit false-like values
 * disable the adapter tool and wake loop without disabling daemon/CLI storage. */
export function coordinationEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const configured = environment.NMG_ENABLE_COORDINATION?.trim().toLowerCase();
  return configured === undefined || !new Set(["0", "false", "off", "no"]).has(configured);
}

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
  return { ...resolveParameterConfig({ environment }).stgSync };
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
  return { ...resolveParameterConfig({ environment }).stgConsolidation };
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
  return { ...resolveParameterConfig({ environment }).maintenance };
}

export function configuredGraphHops(
  fallback: number,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const resolved = resolveParameterConfig({ environment });
  const prov = resolved.provenance.get("autoRecall.graphHops");
  return prov && prov.layer !== "L0" ? resolved.autoRecall.graphHops : fallback;
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

export function configuredAutoRecallTier(environment: NodeJS.ProcessEnv = process.env): MemoryTier {
  return resolveParameterConfig({ environment }).autoRecall.tier;
}

export function configuredAutoRecallLimit(environment: NodeJS.ProcessEnv = process.env): number {
  return resolveParameterConfig({ environment }).autoRecall.limit;
}

export function configuredInitialTarget(environment: NodeJS.ProcessEnv = process.env): number {
  return resolveParameterConfig({ environment }).autoRecall.initialTarget;
}

export function configuredStrongHitTopGap(environment: NodeJS.ProcessEnv = process.env): number {
  return resolveParameterConfig({ environment }).autoRecall.strongHitTopGap;
}

export function configuredStrongHitInitialTarget(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return resolveParameterConfig({ environment }).autoRecall.strongHitInitialTarget;
}

function parseMode<const T extends string>(
  value: string | undefined,
  modes: readonly T[],
): T | undefined {
  const normalized = value?.trim().toLowerCase();
  return modes.find((mode) => mode === normalized);
}
