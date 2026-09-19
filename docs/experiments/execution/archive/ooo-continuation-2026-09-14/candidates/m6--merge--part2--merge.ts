// mergeSorted(a, b) merges two arrays that are already sorted ascending into one sorted array.
// Contract covered here: either or both inputs may be empty; duplicates are preserved;
// the inputs may differ in length; and neither input is modified (both are treated as
// read-only, only reads are performed on them). The result is a new array.
export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const result: number[] = [];
  let i = 0;
  let j = 0;

  // Walk both inputs while each still has elements. This loop is skipped entirely
  // when either input is empty, so empty inputs fall through to the drain loops.
  while (i < a.length && j < b.length) {
    // Take from a on ties to keep the merge stable and deterministic (duplicates kept).
    if (a[i] <= b[j]) {
      result.push(a[i]);
      i++;
    } else {
      result.push(b[j]);
      j++;
    }
  }

  // Drain whichever side still has elements left. This covers inputs of differing
  // lengths and the case where one input is empty.
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
