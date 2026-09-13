import { DEFAULT_HYBRID_WEIGHTS, hybridScore, type HybridWeights } from "./store/search-ranking.ts";

/**
 * Program-side relevance gate — the deterministic half of the two-gate design
 * (`docs/decisions/implemented/2026-09-09-retrieval-relevance-gate.md`).
 *
 * It is deliberately LOOSE. Measured on the labeled recall corpus, candidate
 * relevance has no separating power between on-target and noise (noise top1
 * 0.54–0.87 vs partial 0.51–9.0, interleaved at every floor), and the
 * query-relative shape features below overlap too (any flat-abstain level that
 * removes noise also removes a partial). The gate therefore only drops
 * clearly-broken results and lets `k` act as a maximum rather than a target; the
 * strict half is the learned model gate that ANDs with it later. The shape
 * statistics it computes are the feature inputs that model gate will consume.
 *
 * Relevance is recomputed as the bounded, path-consistent `hybridScore` from the
 * component scores — never the raw `combinedScore`, whose scale differs between
 * the degraded `fts5` path (raw BM25, e.g. 9.0) and the vector path (bounded).
 * Per-query statistics additionally make any threshold scale-free, so the `fts5`
 * scale can no longer distort a comparison.
 *
 * Literature notes on why a first-stage threshold cannot gate recall and what
 * the standard mitigations are: `docs/experiments/retrieval-quality/relevance-gate-calibration-2026-09-09.md`.
 */

export interface RelevanceScored {
  lexicalScore: number;
  vectorScore: number;
  routeScore: number;
}

/** Loose default floor. Chosen low on purpose: it is not a relevance test, it
 *  only removes results that carry essentially no signal at all. On the degraded
 *  lexical path the bounded score is `raw / (raw + 10)`, so 0.05 ≈ raw BM25 0.53
 *  — anything higher is a hard cut, not a loose one (0.4 would mean BM25 ≈ 6.7). */
export const DEFAULT_RELEVANCE_FLOOR = 0.05;

/** Score-shape statistics for one query's candidate list. These are the
 *  program-side features the learned model gate consumes; `cv` (coefficient of
 *  variation) and `gap` are the flatness signals. */
export interface QueryScoreStats {
  count: number;
  mean: number;
  sd: number;
  /** sd / mean — a flat list (low cv) carries little discriminative signal. */
  cv: number;
  top1: number;
  top2: number;
  /** top1 − top2 — the score cliff the strong-hit early stop already uses. */
  gap: number;
}

/** Bounded, path-consistent relevance in [0, 1] for one result. */
export function boundedRelevance(result: RelevanceScored, weights?: HybridWeights): number {
  return hybridScore(result.lexicalScore, result.vectorScore, result.routeScore, weights);
}

/**
 * Unbounded, dynamic-range relevance: the hybrid sum WITHOUT the lexical
 * compression `lexical/(lexical+10)`.
 *
 * Dispersion (`cv`, `gap`) must be measured on a scale that keeps its range.
 * On the bounded score every query looks flat (relevance squeezed near one
 * value), so a flat list carries no signal; on the raw scale a flat list really
 * means "no match". The LoCoMo benchmark confirms this — `cv` on raw lexical
 * separates hit from miss while the bounded score does not
 * (`docs/experiments/retrieval-quality/relevance-gate-calibration-2026-09-09.md`).
 */
export function rawRelevance(result: RelevanceScored, weights?: HybridWeights): number {
  const w = weights ?? DEFAULT_HYBRID_WEIGHTS;
  return (
    Math.max(0, result.lexicalScore) * w.lexical +
    Math.max(0, result.vectorScore) * w.vector +
    Math.max(0, result.routeScore) * w.route
  );
}

/** Which scale a dispersion/relative comparison runs on. */
export type RelevanceScale = "raw" | "bounded";

/** Per-query score-shape statistics over the chosen scale (default `raw` — see
 *  {@link rawRelevance}: the bounded scale hides the flat-vs-peaked signal). */
export function queryScoreStats(
  results: readonly RelevanceScored[],
  weights?: HybridWeights,
  scale: RelevanceScale = "raw",
): QueryScoreStats {
  const score = scale === "raw" ? rawRelevance : boundedRelevance;
  const scores = results.map((result) => score(result, weights));
  const count = scores.length;
  const mean = count === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / count;
  const sd =
    count > 1 ? Math.sqrt(scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count) : 0;
  const sorted = [...scores].sort((left, right) => right - left);
  const top1 = sorted[0] ?? 0;
  const top2 = sorted[1] ?? 0;
  return { count, mean, sd, cv: mean > 0 ? sd / mean : 0, top1, top2, gap: top1 - top2 };
}

/**
 * Program-gate defaults. The gate is **ON by default**: it is deterministic, only
 * ever removes candidates (never adds), and the LoCoMo regression
 * (`tools/relevance-gate-calibration.ts`) shows the flat-list rule keeps 81% of
 * hit questions while doubling kept precision. There is deliberately no env
 * switch — a gate that must be turned on is a gate that never runs.
 */
export const DEFAULT_RELEVANCE_MAX_CV = 0.002;
/** Minimum candidate count before the flatness test may abstain. Dispersion is not
 *  estimable from a handful of points, and the rule was calibrated on full k≈20
 *  lists; a 2-item list of equal scores is not evidence that nothing is relevant,
 *  so a loose gate keeps it. Three is the smallest list where "flat" can still
 *  mean "no candidate stands out" rather than "only two things exist". */
export const MIN_CV_COUNT = 3;
/** Loose probability floor for the opt-in model gate. */
export const DEFAULT_MODEL_FLOOR = 0.5;

export interface RelevanceGateOptions {
  floor?: number;
  /** Maximum kept — k is a maximum, not a target. */
  limit?: number;
  weights?: HybridWeights;
  /** Scale for the dispersion and relative-floor comparison (default `raw`). */
  scale?: RelevanceScale;
  /** Per-query relative floor: keep only results at least this many σ above the
   *  query's own mean **on `scale`**. Scale-free. Undefined = keep all. */
  minZ?: number;
  /** Abstain (return nothing) when the query's scores are flatter than this cv. */
  maxCv?: number;
}

/**
 * Keep only results whose bounded relevance clears the absolute `floor` (a
 * portable [0,1] test) and the optional per-query relative floor; abstain when
 * the list is flatter than `maxCv`; then cap at `limit`. Dispersion and the
 * relative floor run on `scale` (default `raw`) so the flat-vs-peaked signal is
 * not compressed away. The result may be empty: a recall may inject nothing.
 */
export function applyRelevanceGate<T extends RelevanceScored>(
  results: readonly T[],
  options: RelevanceGateOptions = {},
): T[] {
  const floor = options.floor ?? DEFAULT_RELEVANCE_FLOOR;
  const scale = options.scale ?? "raw";
  const score = scale === "raw" ? rawRelevance : boundedRelevance;
  const stats = queryScoreStats(results, options.weights, scale);
  if (options.maxCv !== undefined && stats.count >= MIN_CV_COUNT && stats.cv < options.maxCv) {
    return [];
  }
  const kept = results.filter((result) => {
    if (boundedRelevance(result, options.weights) < floor) return false;
    if (options.minZ === undefined) return true;
    if (stats.sd <= 0) return true; // one value / no spread: relative floor is undefined
    return (score(result, options.weights) - stats.mean) / stats.sd >= options.minZ;
  });
  return options.limit === undefined ? kept : kept.slice(0, options.limit);
}
