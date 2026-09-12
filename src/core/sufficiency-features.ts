/**
 * Query-level "is this recall worth opening" features: the normalized shape of a
 * retriever's own score list, plus query-surface statistics.
 *
 * Feature families and definitions follow the retrieval-sufficiency line of query
 * performance prediction — see
 * `docs/experiments/retrieval-quality/sufficiency-shape-features-2026-09-12.md`,
 * which also records why raw magnitude is replaced by normalized shape.
 *
 * Everything here is pure: it reads no store and no model, so the same code runs
 * at capture time, at training time and in the certification tool.
 */

/**
 * Shape features of the score list. `tau` is supplied by the caller because it is
 * calibrated on a target coverage, not derived from the list.
 */
export const SHAPE_FEATURE_NAMES = [
  "top1",
  "top_gap",
  "gap_concentration",
  "top10_std",
  "decay_slope",
  "bimodal_gap",
  "top5_concentration",
  "elbow",
  "list_length",
  "nn_above_tau",
  "margin_over_tau",
] as const;

/**
 * Query-surface statistics. They need the query text, which the recall capture did
 * not keep before this plan (step S2).
 */
export const QUERY_SURFACE_FEATURE_NAMES = [
  "query_chars",
  "query_words",
  "query_avg_word_length",
  "query_has_numbers",
  "query_punctuation",
] as const;

export const SUFFICIENCY_FEATURE_NAMES = [
  ...SHAPE_FEATURE_NAMES,
  ...QUERY_SURFACE_FEATURE_NAMES,
] as const;

/**
 * Features whose value is in score units rather than a ratio or a count. They are
 * comparable inside one retriever configuration and not across configurations, so
 * a head that has to transfer between configurations should drop them; declaring
 * that here keeps the choice mechanical instead of remembered.
 */
export const SCALE_BOUND_FEATURE_NAMES: ReadonlySet<string> = new Set<string>([
  "top1",
  "top_gap",
  "top10_std",
  "decay_slope",
  "bimodal_gap",
  "margin_over_tau",
]);

const TOP_WINDOW = 10;
const DEEP_START = 10;
const DEEP_END = 30;

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** A descending copy; the caller's array is never mutated. */
function ranked(scores: readonly number[]): number[] {
  for (const score of scores) {
    if (!Number.isFinite(score)) throw new Error(`a score must be finite, got ${score}`);
  }
  return [...scores].sort((left, right) => right - left);
}

/** Least-squares slope of score against rank over the top window (negative when decaying). */
function slopeOfTop(scores: readonly number[]): number {
  const window = scores.slice(0, TOP_WINDOW);
  if (window.length < 2) return 0;
  const meanRank = (window.length - 1) / 2;
  const meanScore = mean(window);
  let covariance = 0;
  let variance = 0;
  window.forEach((score, rank) => {
    covariance += (rank - meanRank) * (score - meanScore);
    variance += (rank - meanRank) ** 2;
  });
  return variance === 0 ? 0 : covariance / variance;
}

/** Largest second difference inside the top window: where the list has an elbow. */
function elbowOfTop(scores: readonly number[]): number {
  const window = scores.slice(0, TOP_WINDOW);
  let best = 0;
  for (let rank = 1; rank < window.length - 1; rank += 1) {
    const second = window[rank - 1]! - 2 * window[rank]! + window[rank + 1]!;
    best = Math.max(best, second);
  }
  return best;
}

/**
 * Shape features of one score list, in {@link SHAPE_FEATURE_NAMES} order. An empty
 * list yields zeros: "no candidates" is a value the decision layer has to see, not
 * an error here. Ratios whose range is zero are zero rather than undefined.
 */
export function shapeFeatures(scores: readonly number[], tau: number): number[] {
  if (!Number.isFinite(tau)) throw new Error(`tau must be finite, got ${tau}`);
  const ordered = ranked(scores);
  if (ordered.length === 0) return SHAPE_FEATURE_NAMES.map(() => 0);
  const top = ordered[0]!;
  const topWindow = ordered.slice(0, TOP_WINDOW);
  const tenth = ordered[topWindow.length - 1]!;
  const total = ordered.reduce((sum, score) => sum + score, 0);
  const topGap = top - (ordered[1] ?? 0);
  const range = top - tenth;
  const windowMean = mean(topWindow);
  const topFive = ordered.slice(0, 5).reduce((sum, score) => sum + score, 0);
  return [
    top,
    topGap,
    range <= 0 ? 0 : topGap / range,
    Math.sqrt(mean(topWindow.map((score) => (score - windowMean) ** 2))),
    slopeOfTop(ordered),
    mean(ordered.slice(0, 3)) - mean(ordered.slice(DEEP_START, DEEP_END)),
    total <= 0 ? 0 : topFive / total,
    elbowOfTop(ordered),
    ordered.length,
    ordered.filter((score) => score >= tau).length,
    top - tau,
  ];
}

/** Query-surface statistics, in {@link QUERY_SURFACE_FEATURE_NAMES} order. */
export function querySurfaceFeatures(query: string): number[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  const letters = words.reduce((sum, word) => sum + word.length, 0);
  return [
    query.length,
    words.length,
    words.length === 0 ? 0 : letters / words.length,
    /\d/.test(query) ? 1 : 0,
    (query.match(/[^\p{L}\p{N}\s]/gu) ?? []).length,
  ];
}

/** Shape and query-surface features concatenated, in the order the names declare. */
export function sufficiencyFeatures(
  scores: readonly number[],
  query: string,
  tau: number,
): number[] {
  return [...shapeFeatures(scores, tau), ...querySurfaceFeatures(query)];
}
