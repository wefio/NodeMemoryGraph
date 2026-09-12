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

/**
 * Re-rank by the model's score instead of deleting with it. A gate can only
 * remove what another rule already placed inside the budget, so it can never
 * recover a good candidate that rule ranked below the cut; ordering the whole
 * pool and *then* spending the budget can. The original order is the tie-break,
 * so equal scores keep the retriever's own preference.
 */
export function rerankByRelevance<T extends MemorySearchResult>(
  query: string,
  results: readonly T[],
  model: RelevanceModelLike,
  options: RelevanceFeatureOptions = {},
): T[] {
  if (results.length <= 1) return [...results];
  const features = relevanceFeatureMatrix(query, results, options);
  return results
    .map((result, index) => ({ result, index, score: model.predict(features[index]!) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.result);
}
