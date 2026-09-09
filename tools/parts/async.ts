/**
 * Concurrency part shared by one-off scripts. See `docs/guides/parts.md`.
 */

/** Run `worker` over `values`, at most `limit` at a time, keeping the input order. */
export async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  limit: number,
  worker: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(values[index]!);
      }
    }),
  );
  return results;
}
