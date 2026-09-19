// mergeSorted(a, b) merges two arrays that are already sorted ascending into one sorted array.
// Contract (all cases):
//   - either input may be empty: mergeSorted([], []) === []; mergeSorted([], [1]) === [1].
//   - duplicates are kept: mergeSorted([1, 1], [1]) === [1, 1, 1].
//   - the inputs may differ in length.
//   - neither input array is modified; only reads and `push` on the new `result` are used.
// The merge is stable: on ties `a` is preferred. The result is a new array.
export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const result: number[] = [];
  let i = 0;
  let j = 0;
  // Main loop: only runs when both inputs still have elements, so an empty
  // input simply skips it and the trailing loops copy the other input verbatim
  // (handles mergeSorted([], []) === [] and mergeSorted([], [1]) === [1]).
  while (i < a.length && j < b.length) {
    // Stable: prefer `a` on ties. Using `<=` also keeps duplicates: equal values
    // from `a` and `b` are each pushed (mergeSorted([1, 1], [1]) === [1, 1, 1]).
    if (a[i] <= b[j]) {
      result.push(a[i]);
      i++;
    } else {
      result.push(b[j]);
      j++;
    }
  }
  // Drain whichever input is longer; covers inputs of differing lengths.
  while (i < a.length) {
    result.push(a[i]);
    i++;
  }
  while (j < b.length) {
    result.push(b[j]);
    j++;
  }
  return result;
}
