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

const defaults = resolveParameterConfig({ l1: {} });

export const DEFAULT_STG_SYNC_POLICY = defaults.stgSync;

export function configuredStgSyncPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): StgSyncPolicyConfig {
  return { ...resolveParameterConfig({ environment }).stgSync };
}

export const DEFAULT_STG_CONSOLIDATION_POLICY = defaults.stgConsolidation;

export function configuredStgConsolidationPolicy(
  environment: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): StgConsolidationPolicyConfig {
  return { ...resolveParameterConfig({ environment, dataDir }).stgConsolidation };
}

export const DEFAULT_MAINTENANCE_POLICY = defaults.maintenance;

export function configuredMaintenancePolicy(
  environment: NodeJS.ProcessEnv = process.env,
): MaintenancePolicyConfig {
  return { ...resolveParameterConfig({ environment }).maintenance };
}

export function configuredGraphHops(
  fallback: number,
  environment: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): number {
  const resolved = resolveParameterConfig({ environment, dataDir });
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
