import { relevanceFeatureMatrix, type RelevanceFeatureOptions } from "./relevance-features.ts";
import type { MemorySearchResult, RelevanceModelLike } from "./types.ts";

/**
 * Model-side (learned) relevance gate — the strict half of the two-gate design
 * (`docs/decisions/implemented/2026-09-09-retrieval-relevance-gate.md`).
 *
 * It is a *loose* gate on its own (a low `floor`, so it only removes what it is
 * confident is off-topic). The AND with the program gate is what makes the
 * compound gate strict, so this never has to over-filter and risk dropping
 * useful context. It runs on the deterministic feature vector in
 * `src/core/relevance-features.ts`.
 */

/** Keep candidates the model scores at or above `floor`. May return nothing
 *  (abstain) when every candidate falls short. */
export function applyLearnedGate<T extends MemorySearchResult>(
  query: string,
  results: readonly T[],
  model: RelevanceModelLike,
  floor: number,
  options: RelevanceFeatureOptions = {},
): T[] {
  if (results.length === 0) return [];
  const features = relevanceFeatureMatrix(query, results, options);
  return results.filter((_, index) => model.predict(features[index]!) >= floor);
}
