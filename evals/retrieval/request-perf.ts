/** Offline paired query-preparation measurement; no network or production store. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { NmgStore } from "../../src/core/store.ts";
import { requestQueryEmbeddingClient, searchMemoryContext } from "../../src/integration/search.ts";
import { mean, percentileFloor } from "../../tools/parts/stats.ts";
import { writeJsonAtomic } from "../../tools/parts/fs.ts";
import { requirePositiveInteger } from "../../tools/parts/numbers.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    iterations: { type: "string", default: "30" },
    records: { type: "string", default: "60" },
    "delay-ms": { type: "string", default: "20" },
  },
});
if (!values.out) throw new Error("Required --out <report.json>");
const iterations = requirePositiveInteger(values.iterations, "iterations");
const records = requirePositiveInteger(values.records, "records");
const delayMs = requirePositiveInteger(values["delay-ms"], "delay-ms");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const options = {
  limit: 20,
  maxTier: 3 as const,
  graphHops: 0,
  secondPass: false,
  persistTrace: false,
};
const stores = [new NmgStore(":memory:"), new NmgStore(":memory:")];
try {
  for (const store of stores) {
    const entries = [];
    for (let i = 0; i < records; i++) {
      const saved = store.remember({
        statement: `Atlas database deployment region ${i} stores SQLite observations`,
        nodeName: `region-${i}`,
      });
      entries.push({ memoryId: saved.memory.id, vector: [1, i / records] });
    }
    assert.equal(new Set(entries.map((e) => e.memoryId)).size, records);
    store.beginEmbeddingIndex({
      indexId: "fixture",
      model: "fixture",
      profile: "test",
      targets: ["records"],
    });
    store.upsertExternalEmbeddings("fixture", entries);
    store.completeEmbeddingIndex("fixture");
  }
  const reports = [];
  for (const queries of [
    ["Atlas database"],
    ["Atlas database", "Atlas database"],
    ["Atlas database", "SQLite observations"],
  ]) {
    const samples = { direct: [] as number[], request: [] as number[] };
    const calls = { direct: 0, request: 0 };
    let matched = 0;
    for (let i = -3; i < iterations; i++) {
      const outputs: Record<string, unknown> = {};
      // Alternate order so the request arm does not always get the warmer DB.
      for (const mode of (i % 2 ? ["request", "direct"] : ["direct", "request"]) as Array<
        "direct" | "request"
      >) {
        let count = 0;
        const client = {
          indexId: "fixture",
          async embedQueries(texts: string[]) {
            count++;
            await delay(delayMs);
            return texts.map(() => [1, 0]);
          },
        };
        const embedding = mode === "request" ? requestQueryEmbeddingClient(client) : client;
        const start = performance.now();
        const rows = [];
        for (const [index, query] of queries.entries()) {
          const result = await searchMemoryContext(
            stores[index % stores.length],
            embedding,
            query,
            options,
          );
          assert.equal(result.retrieval?.mode, "hybrid");
          assert.ok(result.results.length > 0 && result.results.length <= 20);
          rows.push(result.results);
        }
        if (i >= 0) {
          samples[mode].push(performance.now() - start);
          calls[mode] += count;
        }
        outputs[mode] = rows;
      }
      assert.deepEqual(outputs.request, outputs.direct);
      if (i >= 0) matched++;
    }
    assert.equal(calls.direct, iterations * queries.length);
    assert.equal(calls.request, iterations * new Set(queries).size);
    reports.push({
      queries,
      matched,
      calls,
      latencyMs: Object.fromEntries(
        Object.entries(samples).map(([mode, values]) => {
          assert.ok(values.length === iterations && values.every(Number.isFinite));
          return [
            mode,
            {
              mean: mean(values),
              p50: percentileFloor(values, 0.5),
              p95: percentileFloor(values, 0.95),
            },
          ];
        }),
      ),
    });
  }
  writeJsonAtomic(values.out, {
    measuredAt: new Date().toISOString(),
    runtime: process.version,
    platform: process.platform,
    input: "synthetic in-memory stores; deterministic vectors; simulated provider wait",
    recordsPerStore: records,
    iterations,
    delayMs,
    warmup: 3,
    options,
    sourceHashes: Object.fromEntries(
      ["src/integration/search.ts", "src/cli/service.ts"].map((path) => [
        path,
        hash(readFileSync(path, "utf8")),
      ]),
    ),
    reports,
  });
} finally {
  for (const store of stores) store.close();
}
