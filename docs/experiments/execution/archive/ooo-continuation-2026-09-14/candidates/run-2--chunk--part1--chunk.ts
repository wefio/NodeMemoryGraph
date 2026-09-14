// chunk(items, size) splits items into consecutive groups of at most `size`.
// Contract: the last group may be short; an empty input yields no groups; a size that is not a
// positive integer is refused with an Error; the input array is never modified.
export function chunk(items: readonly unknown[], size: number): unknown[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("size must be a positive integer");
  }
  const result: unknown[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}
