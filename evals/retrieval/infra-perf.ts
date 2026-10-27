/** Offline paired infrastructure measurement. See the 2026-10-26 experiment report. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import type { InformationView } from "../../src/core/information-view.ts";
import { NmgStore } from "../../src/core/store.ts";
import { prepareInformationOutput } from "../../src/integration/information-output.ts";
import { writeJsonAtomic } from "../../tools/parts/fs.ts";
import { mean, percentileFloor } from "../../tools/parts/stats.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    compare: { type: "string" },
    iterations: { type: "string", default: "40" },
    records: { type: "string", default: "200" },
  },
});
if (!values.out) throw new Error("Required: --out <report.json> [--compare <baseline.json>]");
const iterations = positiveInteger(values.iterations);
const recordCount = positiveInteger(values.records);

function positiveInteger(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError("Expected positive integer");
  return result;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function measure<T>(operation: () => T) {
  for (let i = 0; i < 5; i++) operation();
  const samples: number[] = [];
  let result: T | undefined;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    result = operation();
    samples.push(performance.now() - start);
  }
  assert.ok(samples.length > 0 && samples.every(Number.isFinite));
  return {
    result: result!,
    latencyMs: {
      mean: mean(samples),
      p50: percentileFloor(samples, 0.5),
      p95: percentileFloor(samples, 0.95),
    },
  };
}

function measureInformation() {
  const reports = [];
  for (const count of [20, 200, 2000]) {
    const views: InformationView[] = Array.from({ length: count }, (_, i) => ({
      source: { kind: "memory", memoryId: `memory-${i}` },
      purpose: i % 5 === 0 ? "state" : "material",
      body: `Record ${i}: ${"Keep evidence provenance intact. ".repeat(5)}`,
      requiredLabels: ["[evidence]"],
    }));
    for (const format of ["flat", "context"] as const) {
      for (const maxCharacters of [8000, 1_000_000]) {
        const prepare = () => prepareInformationOutput(views, { format, maxCharacters });
        const { result, latencyMs } = measure(() => {
          const output = prepare();
          // Include deferred disclosure work in the original full-output metric.
          void output.included;
          return output;
        });
        const { latencyMs: textOnlyLatencyMs } = measure(() => prepare().text);
        assert.ok(result.text.length <= maxCharacters);
        assert.equal(result.included.length + result.omitted.length, count);
        reports.push({
          count,
          format,
          maxCharacters,
          latencyMs,
          textOnlyLatencyMs,
          characters: result.text.length,
          included: result.included.length,
          omitted: result.omitted.length,
          outputDigest: digest(result),
        });
      }
    }
  }
  return reports;
}

/** Owns one in-memory DB; deterministic IDs/timestamps remove cross-run tie noise. */
class FixtureStore extends NmgStore {
  seed(count: number): void {
    const node = this.db.prepare(`INSERT INTO memory_nodes
      (id, canonical_name, kind, summary, created_at, updated_at, status)
      VALUES (?, ?, 'topic', '', ?, ?, 'active')`);
    const history = this.db.prepare(`INSERT INTO history_records
      (id, session_id, source_message_id, role, content, source_ref, created_at)
      VALUES (?, 'infra-fixture', ?, 'user', ?, 'infra-fixture', ?)`);
    const memory = this.db.prepare(`INSERT INTO memory_records
      (id, node_id, evidence_id, statement, memory_type, source_actor, truth_status,
       scope_json, status, evidence_role, tier, importance, access_count, pending_access_count, created_at)
      VALUES (?, ?, ?, ?, 'fact', 'user', 'asserted', '{}', 'active', 'support', 1, ?, 0, 0, ?)`);
    const link = this.db.prepare(
      "INSERT INTO memory_evidence_links(memory_id, history_id) VALUES (?, ?)",
    );
    this.db.exec("BEGIN");
    for (let i = 0; i < count; i++) {
      const id = String(i).padStart(6, "0");
      const date = "2026-10-25T00:00:00.000Z";
      node.run(`node-${id}`, `infrastructure-${id}`, date, date);
      for (let j = 0; j < 3; j++) {
        history.run(
          `history-${id}-${j}`,
          `message-${id}-${j}`,
          `Source ${id}/${j}: ${"Infrastructure retrieval evidence provenance. ".repeat(10)}`,
          date,
        );
      }
      memory.run(
        `memory-${id}`,
        `node-${id}`,
        `history-${id}-0`,
        `Infrastructure retrieval observation ${id}: keep evidence provenance and batch database reads.`,
        0.5 + i / (2 * count),
        date,
      );
      for (let j = 0; j < 3; j++) link.run(`memory-${id}`, `history-${id}-${j}`);
    }
    this.db.exec("COMMIT");
  }

  statementCount(operation: () => unknown): number {
    const original = this.db.prepare;
    let calls = 0;
    this.db.prepare = function (sql) {
      return new Proxy(original.call(this, sql), {
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (["all", "get", "run"].includes(String(key))) calls++;
            return Reflect.apply(value, target, args);
          };
        },
      });
    };
    try {
      operation();
    } finally {
      this.db.prepare = original;
    }
    return calls;
  }
}

function measureRetrieval() {
  const store = new FixtureStore(":memory:");
  try {
    store.seed(recordCount);
    const search = () =>
      store.searchContext("Infrastructure retrieval observation", {
        limit: 20,
        maxTier: 3,
        graphHops: 0,
        secondPass: false,
        persistTrace: false,
        perf: true,
        activeGraphBudget: { maxNodes: 20, maxEvidence: 20, maxTokens: 6000, maxTierBudget: 20 },
      });
    const { result, latencyMs } = measure(search);
    assert.equal(result.results.length, Math.min(recordCount, 20));
    return {
      latencyMs,
      statementsPerQuery: store.statementCount(search),
      returned: result.results.length,
      outputDigest: digest(result.results),
      phases: result.timings,
    };
  } finally {
    store.close();
  }
}

const report = {
  schema: 1,
  measuredAt: new Date().toISOString(),
  nodeVersion: process.version,
  input: { fixture: "infra-v1", iterations, recordCount },
  implementation: Object.fromEntries(
    [
      "evals/retrieval/infra-perf.ts",
      "src/integration/information-output.ts",
      "src/core/store/base.ts",
      "src/core/store/retrieval.ts",
    ].map((path) => [path, digest(readFileSync(path, "utf8"))]),
  ),
  information: measureInformation(),
  retrieval: measureRetrieval(),
};
if (values.compare) {
  const baseline = JSON.parse(readFileSync(values.compare, "utf8")) as typeof report;
  assert.deepEqual(report.input, baseline.input, "Comparable input configuration required");
  assert.deepEqual(
    report.information.map((row) => row.outputDigest),
    baseline.information.map((row) => row.outputDigest),
    "Information output changed",
  );
  assert.equal(
    report.retrieval.outputDigest,
    baseline.retrieval.outputDigest,
    "Retrieval results changed",
  );
}
writeJsonAtomic(values.out, report);
console.log(JSON.stringify(report, null, 2));
