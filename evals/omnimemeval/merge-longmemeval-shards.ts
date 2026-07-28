import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type SearchResults = Record<string, unknown>;

export function mergeLongMemEvalShards(
  shards: readonly SearchResults[],
  expectedCount?: number,
): SearchResults {
  const indexed = new Map<number, [string, unknown]>();

  for (const shard of shards) {
    for (const [userId, value] of Object.entries(shard)) {
      const match = userId.match(/_(\d+)$/);
      if (!match) throw new Error(`cannot derive conversation index from ${userId}`);
      const index = Number(match[1]);
      if (indexed.has(index)) throw new Error(`duplicate conversation index ${index}`);
      indexed.set(index, [userId, value]);
    }
  }

  const count = expectedCount ?? indexed.size;
  const merged: SearchResults = {};
  for (let index = 0; index < count; index += 1) {
    const entry = indexed.get(index);
    if (!entry) throw new Error(`missing conversation index ${index}`);
    merged[entry[0]] = entry[1];
  }
  if (indexed.size !== count) {
    throw new Error(`expected ${count} conversations, found ${indexed.size}`);
  }
  return merged;
}

if (process.argv[1]?.endsWith("merge-longmemeval-shards.ts")) {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length === 0) {
    throw new Error(
      "usage: merge-longmemeval-shards.ts <output.json> <shard.json>...",
    );
  }
  const shards = inputs.map((path) =>
    JSON.parse(readFileSync(resolve(path), "utf8")) as SearchResults
  );
  const merged = mergeLongMemEvalShards(shards, 500);
  writeFileSync(resolve(output), `${JSON.stringify(merged, null, 2)}\n`);
  process.stdout.write(`merged ${Object.keys(merged).length} conversations\n`);
}
