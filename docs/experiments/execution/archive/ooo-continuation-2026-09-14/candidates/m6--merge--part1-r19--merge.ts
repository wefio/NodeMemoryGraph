// mergeSorted(a, b) merges two arrays that are already sorted ascending into one sorted array.
// This stage covers two non-empty arrays of equal length. The remaining cases of the contract
// arrive with the next handoff. The result is a new array.
export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const result: number[] = [];
  let i = 0;
  let j = 0;

  // Both arrays are non-empty and equal length, but we still bound by each
  // array's own length so we never read out of range.
  while (i < a.length && j < b.length) {
    // <= keeps the merge stable: an equal element from `a` is taken first.
    if (a[i] <= b[j]) {
      result.push(a[i]);
      i += 1;
    } else {
      result.push(b[j]);
      j += 1;
    }
  }

  while (i < a.length) {
    result.push(a[i]);
    i += 1;
  }

  while (j < b.length) {
    result.push(b[j]);
    j += 1;
  }

  return result;
}
