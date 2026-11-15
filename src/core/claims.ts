import type { ClaimPosterior, ExtractMethod, MemoryClaim, Polarity } from "./types.ts";

export function claimPosterior(
  input: Omit<ClaimPosterior, "mean" | "conservativeLowerBound">,
): ClaimPosterior {
  const total = input.alpha + input.beta;
  const mean = total > 0 ? input.alpha / total : 0.5;
  const standardError = Math.sqrt((mean * (1 - mean)) / Math.max(1, total + 1));
  return {
    ...input,
    mean,
    conservativeLowerBound: Math.max(0, Math.min(1, mean - 1.96 * standardError)),
  };
}

export interface ClaimRollup {
  claims: MemoryClaim[] | null;
  confidence: number | null;
  polarity: Polarity | null;
  predicateKey: string | null;
  extractMethod: ExtractMethod | null;
}

/**
 * Claims are the source of truth when supplied. Record-level logical fields
 * remain a compatibility cache derived from the first non-neutral claim.
 */
export function normalizeClaims(
  claims: readonly MemoryClaim[] | null | undefined,
): ClaimRollup | null {
  if (claims === undefined || claims === null) return null;
  const normalized = claims.flatMap((claim) => {
    const text = claim.text.trim();
    if (!text) return [];
    const polarity = normalizePolarity(claim.polarity);
    const predicateKey =
      polarity === "neutral" || !claim.predicateKey?.trim()
        ? null
        : claim.predicateKey.trim().toLocaleLowerCase();
    return [
      {
        text,
        polarity,
        predicateKey,
        confidence:
          claim.confidence === null || !Number.isFinite(claim.confidence)
            ? null
            : Math.max(0, Math.min(claim.confidence, 1)),
        extractMethod: claim.extractMethod,
      } satisfies MemoryClaim,
    ];
  });
  if (normalized.length === 0) {
    return {
      claims: null,
      confidence: null,
      polarity: null,
      predicateKey: null,
      extractMethod: null,
    };
  }
  const representative =
    normalized.find((claim) => claim.polarity === "affirmative" || claim.polarity === "negative") ??
    normalized[0]!;
  return {
    claims: normalized,
    confidence: representative.confidence,
    polarity: representative.polarity,
    predicateKey: representative.predicateKey,
    extractMethod: representative.extractMethod,
  };
}

function normalizePolarity(value: Polarity | null): Polarity | null {
  return value === "affirmative" || value === "negative" || value === "neutral" ? value : null;
}
