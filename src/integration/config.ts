export type QppActuationMode = "off" | "shadow" | "active";
export type SearchRecommendationMode = "off" | "advisory" | "guardrail";

export function configuredGraphHops(fallback: number): number {
  const configured = Number.parseInt(process.env.NMG_GRAPH_HOPS ?? "", 10);
  return Number.isInteger(configured) ? Math.max(0, Math.min(configured, 3)) : fallback;
}

export function configuredQpp1Mode(): QppActuationMode {
  const configured = parseMode(process.env.NMG_QPP1_MODE, ["off", "shadow", "active"]);
  if (configured) return configured;
  if (process.env.NMG_CONTROLLER_SEARCH === "1") return "active";
  if (process.env.NMG_CONTROLLER_SEARCH === "0") return "shadow";
  return "shadow";
}

export function configuredQpp2Mode(): QppActuationMode {
  return parseMode(process.env.NMG_QPP2_MODE, ["off", "shadow", "active"]) ?? "off";
}

export function configuredQpp2RetainedMass(): number {
  const configured = Number(process.env.NMG_QPP2_RETAINED_MASS ?? 0.98);
  return Number.isFinite(configured) ? Math.max(0, Math.min(configured, 1)) : 0.98;
}

export function configuredSearchRecommendationMode(): SearchRecommendationMode {
  return (
    parseMode(process.env.NMG_SEARCH_RECOMMENDATION, ["off", "advisory", "guardrail"]) ?? "off"
  );
}

function parseMode<const T extends string>(
  value: string | undefined,
  modes: readonly T[],
): T | undefined {
  const normalized = value?.trim().toLowerCase();
  return modes.find((mode) => mode === normalized);
}
