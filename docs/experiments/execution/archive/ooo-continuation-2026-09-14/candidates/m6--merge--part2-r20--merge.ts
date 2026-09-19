// mergeSorted(a, b) merges two arrays that are already sorted ascending into one sorted array.
// Full contract: either input may be empty (mergeSorted([], []) is [], mergeSorted([], [1]) is [1]);
// duplicates are kept (mergeSorted([1, 1], [1]) is [1, 1, 1]); the inputs may differ in length; and
// neither input array is modified. The result is a new array; only `push` is used on it, and the
// inputs are read by index only, so no mutating array method is called on them.
export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const result: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] <= b[j]) {
      result.push(a[i]);
      i++;
    } else {
      result.push(b[j]);
      j++;
    }
  }
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
