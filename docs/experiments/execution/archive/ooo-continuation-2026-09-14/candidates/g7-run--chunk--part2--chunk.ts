// chunk(items, size) splits items into consecutive groups of at most `size` items.
// Contract:
//   - a non-empty list whose length is not a multiple of `size`: the last group may be short
//   - an empty list yields no groups at all: chunk([], 3) is []
//   - a length that is an exact multiple of `size` yields full groups only
//   - size 1 yields one group per item
//   - `size` must be a positive integer; 0, negative or fractional sizes are refused with an Error
// The input array is never modified.
export function chunk(items: readonly unknown[], size: number): unknown[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk: size must be a positive integer, received ${size}`);
  }

  const result: unknown[][] = [];
  if (items.length === 0) {
    return result;
  }

  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}
