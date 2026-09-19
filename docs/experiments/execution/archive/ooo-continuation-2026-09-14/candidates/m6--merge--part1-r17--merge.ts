// mergeSorted(a, b) merges two arrays that are already sorted ascending into one sorted array.
// This stage covers two non-empty arrays of equal length. The remaining cases of the contract
// arrive with the next handoff. The result is a new array.
export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const result: number[] = [];
  const n = a.length;
  let i = 0;
  let j = 0;

  // Both inputs are non-empty and of equal length, so this walks both fully.
  while (i < n && j < n) {
    if (a[i] <= b[j]) {
      result.push(a[i]);
      i++;
    } else {
      result.push(b[j]);
      j++;
    }
  }

  while (i < n) {
    result.push(a[i]);
    i++;
  }
  while (j < n) {
    result.push(b[j]);
    j++;
  }

  return result;
}
