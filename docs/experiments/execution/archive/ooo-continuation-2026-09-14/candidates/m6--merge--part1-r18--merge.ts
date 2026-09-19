// mergeSorted(a, b) merges two arrays that are already sorted ascending into one sorted array.
// This stage covers two non-empty arrays of equal length. The remaining cases of the contract
// arrive with the next handoff. The result is a new array.
export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const result: number[] = [];
  let i = 0;
  let j = 0;

  // Both arrays are non-empty and of equal length at this stage, so the pointers
  // reach the ends of their arrays simultaneously and no draining is required.
  while (i < a.length && j < b.length) {
    if (a[i] <= b[j]) {
      result.push(a[i]);
      i++;
    } else {
      result.push(b[j]);
      j++;
    }
  }

  return result;
}
