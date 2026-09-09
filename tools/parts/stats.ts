/**
 * Statistics parts shared by one-off scripts.
 *
 * Four different percentile conventions exist in the eval scripts. They are not
 * interchangeable: the same input and `q` can give different numbers, so each
 * one keeps its own name instead of a `method` flag. See `docs/guides/parts.md`.
 */

/** Arithmetic mean. An empty series is 0. */
export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Middle element by rank, upper of the two middles when the length is even. */
export function median(values: readonly number[]): number {
  const sorted = sortedNumbers(values);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
}

/** `sorted[min(n-1, floor(n*q))]`. */
export function percentileFloor(values: readonly number[], q: number): number {
  const sorted = sortedNumbers(values);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[index] ?? 0;
}

/** `sorted[max(0, ceil(n*q) - 1)]` — the nearest-rank definition. */
export function percentileNearestRank(values: readonly number[], q: number): number {
  const sorted = sortedNumbers(values);
  const index = Math.max(0, Math.ceil(sorted.length * q) - 1);
  return sorted[index] ?? 0;
}

/** `sorted[min(n-1, round((n-1)*q))]` — index scaled to the sample span. */
export function percentileScaled(values: readonly number[], q: number): number {
  const sorted = sortedNumbers(values);
  const index = Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q));
  return sorted[index] ?? 0;
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}
