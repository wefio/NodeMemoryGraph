// mergeSorted(a, b) merges two arrays that are already sorted ascending into one sorted array.
// Either input may be empty, duplicates are kept, and the inputs may differ in length.
// Neither input is modified; the result is a new array.
export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const result: number[] = [];
  const na = a.length;
  const nb = b.length;
  let i = 0;
  let j = 0;

  // Walk both inputs while each still has remaining elements. Ties drain from `a`
  // first (a[i] <= b[j]), which keeps every duplicate.
  while (i < na && j < nb) {
    if (a[i] <= b[j]) {
      result.push(a[i]);
      i++;
    } else {
      result.push(b[j]);
      j++;
    }
  }

  // Drain whichever input still has elements (handles empty and unequal lengths).
  while (i < na) {
    result.push(a[i]);
    i++;
  }
  while (j < nb) {
    result.push(b[j]);
    j++;
  }

  return result;
}
