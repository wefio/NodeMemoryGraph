export const CONTEXT_FEATURE_VERSION = "context-features-v1";

/** Values occupy [0,16); missing indicators occupy [16,32).
 * Ratios are supplied by the caller using its fixed hard envelope. Counts are
 * saturated at 32. No outcome from the current decision belongs in this input.
 */
export const CONTEXT_FEATURE_KEYS = [
  "contextOccupancy",
  "remainingTokenRatio",
  "remainingToolRatio",
  "topCandidateScore",
  "candidateScoreGap",
  "candidateCount",
  "candidateRedundancy",
  "candidateFreshness",
  "stepsSinceVerification",
  "consecutiveFailures",
  "returnedFromInterruption",
  "previousNone",
  "previousCue",
  "previousResurface",
  "previousRetrieve",
  "previousReward",
] as const;
export type ContextFeatureKey = (typeof CONTEXT_FEATURE_KEYS)[number];
export type ContextFeatureState = Partial<Record<ContextFeatureKey, number | null>>;
const COUNTS: readonly ContextFeatureKey[] = [
  "candidateCount",
  "stepsSinceVerification",
  "consecutiveFailures",
];

export function encodeContextFeatures(state: ContextFeatureState): number[] {
  const missing: number[] = [];
  const values = CONTEXT_FEATURE_KEYS.map((key) => {
    const value = state[key];
    const absent = value === null || value === undefined;
    missing.push(Number(absent));
    if (absent) return 0;
    if (!Number.isFinite(value)) throw new Error(`non-finite feature: ${key}`);
    if (COUNTS.includes(key)) {
      if (value < 0) throw new Error(`negative count: ${key}`);
      return Math.min(value, 32) / 32;
    }
    const minimum = key === "previousReward" ? -1 : 0;
    if (value < minimum || value > 1) throw new Error(`out-of-range feature: ${key}`);
    return value;
  });
  return [...values, ...missing];
}

/** History-free ablation keeps the same 132-parameter architecture. */
export function withoutContextHistory(features: readonly number[]): number[] {
  if (features.length !== 32) throw new Error("expected 32 context features");
  const result = [...features];
  for (let i = 8; i < 16; i++) {
    result[i] = 0;
    result[i + 16] = 1;
  }
  return result;
}
