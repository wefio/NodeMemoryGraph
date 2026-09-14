// chunk(items, size) splits items into consecutive groups of at most `size` items.
// For this stage the contract is the ordinary case: a non-empty list whose length is not a
// multiple of `size`, where the last group may be short. The remaining cases of the contract
// arrive with the next handoff. The input array is never modified.
export function chunk(items: readonly unknown[], size: number): unknown[][] {
  const result: unknown[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}
