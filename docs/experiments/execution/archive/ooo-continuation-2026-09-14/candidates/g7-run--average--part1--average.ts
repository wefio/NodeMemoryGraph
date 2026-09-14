// movingAverage(values, window) returns the mean of each run of `window` consecutive values.
// This stage covers an input longer than a window of 2 or more. The remaining cases of the
// contract arrive with the next handoff.
export function movingAverage(values: readonly number[], window: number): number[] {
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
