// movingAverage(values, window) returns the mean of each run of `window` consecutive values.
// Contract:
// - One output per full window, so an input shorter than the window yields [] and an
//   empty input yields [].
// - A window of 1 returns the values themselves.
// - A window that is not a positive integer (0 or fractional) is refused with an Error.
export function movingAverage(values: readonly number[], window: number): number[] {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error('window must be a positive integer');
  }
  const result: number[] = [];
  for (let i = 0; i + window <= values.length; i++) {
    let sum = 0;
    for (let j = i; j < i + window; j++) {
      sum += values[j];
    }
    result.push(sum / window);
  }
  return result;
}
