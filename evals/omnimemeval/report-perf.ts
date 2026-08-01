import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PerfSnapshot } from "../../src/core/types.ts";

interface PerfRow {
  userId: string;
  timings?: PerfSnapshot;
}

const path = resolve(process.argv[2] ?? ".benchmarks/omnimemeval-nmg/search-perf.jsonl");
const userPrefix = process.argv[3];
const rows = readFileSync(path, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as PerfRow)
  .filter((row) => row.timings && (!userPrefix || row.userId.startsWith(userPrefix)));

if (rows.length === 0) throw new Error("no matching OmniMemEval performance rows");

const samples = new Map<string, number[]>();
for (const row of rows) {
  add("total", row.timings!.totalMs);
  for (const [section, value] of Object.entries(row.timings!.timings)) add(section, value);
}

const report = Object.fromEntries(
  [...samples.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([section, values]) => {
      values.sort((left, right) => left - right);
      return [
        section,
        {
          count: values.length,
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          p99: percentile(values, 0.99),
        },
      ];
    }),
);

console.log(JSON.stringify({ path, userPrefix: userPrefix ?? null, samples: rows.length, report }, null, 2));

function add(section: string, value: number): void {
  if (!Number.isFinite(value)) return;
  const values = samples.get(section) ?? [];
  values.push(value);
  samples.set(section, values);
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}
