// mergeSorted(a, b) merges two arrays that are already sorted ascending into one sorted array.
// This stage covers two non-empty arrays of equal length. The remaining cases of the contract
// arrive with the next handoff. The result is a new array.
export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const result: number[] = [];
  let i = 0;
  let j = 0;

  // Both inputs are non-empty and of equal length, so walk both with two pointers.
  while (i < a.length && j < b.length) {
    // Take from a on ties to keep the merge stable and deterministic.
    if (a[i] <= b[j]) {
      result.push(a[i]);
      i++;
    } else {
      result.push(b[j]);
      j++;
    }
  }

  // Drain whichever side still has elements left.
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
