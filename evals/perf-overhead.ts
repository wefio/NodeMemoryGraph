/**
 * Perf-instrumentation overhead benchmark.
 *
 * Measures `searchContext` (full pipeline: direct search + graph expansion +
 * QPP second pass + trace write) with performance timing ON vs OFF at two
 * store sizes, plus a phase profile from one run.
 *
 * Falsifiable claim being tested: the per-phase timing added for performance
 * monitoring costs ~0 (its measurement overhead is far below the variance of
 * the operations it measures). If the overhead exceeds a few percent of
 * median latency, the instrumentation design needs revisiting.
 *
 * Usage: node --experimental-strip-types evals/perf-overhead.ts
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { NmgStore } from "../src/index.ts";

const SIZES = [1_000, 10_000];
const QUERIES = [
  "What is my telescope access code?",
  "What is my archive nickname?",
  "What was my retired project codename?",
  "Should notifications make sound late at night?",
  "May I remove the lunar telemetry archive?",
  "How did I previously solve the display startup issue?",
];
const ITERATIONS = 30;
const outputDir = join(process.cwd(), "evals", "scale", ".tmp");

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}

function seedStore(path: string, size: number): void {
  rmSync(path, { force: true });
  const seed = new NmgStore(path);
  const cases = [
    { statement: "The user's telescope access code is ORBIT-7319", tier: 0 },
    { statement: "The user's archive nickname is cobalt heron", tier: 1 },
    { statement: "The user's retired project codename is lantern fern", tier: 3 },
    { statement: "Never delete the lunar telemetry archive", tier: 0 },
    { statement: "The user avoids auditory alerts after midnight", tier: 0 },
    { statement: "The user once fixed rendering by switching to software graphics", tier: 3 },
  ];
  for (const item of cases) {
    seed.remember({
      statement: item.statement,
      nodeName: `perf-${item.statement.slice(0, 12)}`,
      memoryType: item.statement.startsWith("Never") ? "constraint" : "fact",
      tier: item.tier as 0 | 1 | 2 | 3,
      importance: 0.7,
      evidence: item.statement,
    });
  }
  seed.close();
  insertDistractors(path, size - cases.length);
}

function insertDistractors(path: string, count: number): void {
  if (count <= 0) return;
  const db = new DatabaseSync(path);
  const node = db.prepare(
    `INSERT INTO memory_nodes
      (id, canonical_name, kind, summary, created_at, updated_at, status)
     VALUES (?, ?, 'topic', ?, ?, ?, 'active')`,
  );
  const history = db.prepare(
    `INSERT INTO history_records
      (id, session_id, source_message_id, role, content, source_ref, created_at)
     VALUES (?, 'perf-distractors', ?, 'user', ?, 'perf-generator', ?)`,
  );
  const memory = db.prepare(
    `INSERT INTO memory_records
      (id, node_id, evidence_id, statement, memory_type, source_actor, truth_status,
       scope_json, status, evidence_role, tier, importance, access_count,
       pending_access_count, created_at)
     VALUES (?, ?, ?, ?, 'fact', 'user', 'asserted', '{}', 'active', 'support',
             ?, 0.5, 0, 0, ?)`,
  );
  const link = db.prepare("INSERT INTO memory_evidence_links(memory_id, history_id) VALUES (?, ?)");
  db.exec("BEGIN");
  try {
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(6, "0");
      const text = `Routine unrelated synthetic observation ${suffix}`;
      const createdAt = new Date(Date.UTC(2030, 0, 1, 0, 0, index % 60, index)).toISOString();
      node.run(`noise-node-${suffix}`, `noise ${suffix}`, text, createdAt, createdAt);
      history.run(`noise-history-${suffix}`, `noise-message-${suffix}`, text, createdAt);
      memory.run(
        `noise-memory-${suffix}`,
        `noise-node-${suffix}`,
        `noise-history-${suffix}`,
        text,
        index % 4,
        createdAt,
      );
      link.run(`noise-memory-${suffix}`, `noise-history-${suffix}`);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

const reports = [];
for (const size of SIZES) {
  const path = join(outputDir, `perf-overhead-${size}.sqlite`);
  seedStore(path, size);
  const store = new NmgStore(path);
  try {
    // Warm up prepared statements / index pages once per mode.
    store.searchContext(QUERIES[0]!, { secondPass: true });
    store.searchContext(QUERIES[0]!, { secondPass: true, perf: false });

    let profileTotal = 0;
    const phaseAccumulator = new Map<string, number[]>();
    let profileSamples = 0;
    const run = (perfOn: boolean): number[] => {
      const latencies: number[] = [];
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const query = QUERIES[iteration % QUERIES.length]!;
        const started = performance.now();
        const context = store.searchContext(query, { secondPass: true, perf: perfOn });
        const elapsed = performance.now() - started;
        latencies.push(elapsed);
        if (perfOn && context.timings) {
          for (const [section, ms] of Object.entries(context.timings.timings)) {
            phaseAccumulator.set(section, [...(phaseAccumulator.get(section) ?? []), ms]);
          }
          profileTotal += context.timings.totalMs;
          profileSamples += 1;
        }
      }
      return latencies;
    };

    const on = run(true);
    const off = run(false);
    const sortedOn = [...on].sort((a, b) => a - b);
    const sortedOff = [...off].sort((a, b) => a - b);
    const latencyStats = (sorted: number[]): Record<string, number> => ({
      avg: sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length,
      median: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    });
    const onStats = latencyStats(sortedOn);
    const offStats = latencyStats(sortedOff);
    const phaseProfile = Object.fromEntries(
      [...phaseAccumulator.entries()].map(([section, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return [
          section,
          {
            ...latencyStats(sorted),
            // Share of wall clock: mean section time over mean total per query.
            shareOfTotal:
              profileSamples > 0
                ? values.reduce((sum, ms) => sum + ms, 0) /
                  profileSamples /
                  (profileTotal / profileSamples)
                : 0,
          },
        ];
      }),
    );
    reports.push({
      size,
      iterations: ITERATIONS,
      latencyMs: {
        perfOn: onStats,
        perfOff: offStats,
        overheadPct: offStats.median > 0 ? ((onStats.median - offStats.median) / offStats.median) * 100 : null,
      },
      phaseProfile,
    });
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
}
console.log(JSON.stringify(reports, null, 2));
