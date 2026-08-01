/**
 * Perf & hotspot analysis for an nmg database.
 *
 * Reads a store's `perf_aggregates` (cumulative timing stats written by the
 * PerfTimer) plus raw retrieval_traces, and prints:
 *   - per-section latency share of total (the hotspot map),
 *   - the store's scale (memories / nodes / relations / history / traces),
 *   - a latency histogram for search.direct.
 *
 * Data source is the real SQLite DB (read-only), not a running store — so it
 * works on any database a CLI/eval produced. Aggregates come through
 * NmgStore's public `perfAggregates()` (single source of truth for sections);
 * scale + trace stats go straight to the DB (no per-trace API exists).
 *
 * Usage:
 *   node --experimental-strip-types scripts/perf-hotspots.ts [db-path]
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NmgStore } from "../src/core/store.ts";

interface StoreRow {
  n: number;
}

const databasePath = resolve(process.argv[2] ?? ".nmg/nmg.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

// ── aggregates through the store API ──
const store = new NmgStore(databasePath);
const aggregates = store.perfAggregates();
store.close();

// ── raw scale + trace stats (read-only) ──
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const count = (sql: string): number => (db.prepare(sql).get() as StoreRow).n;

  console.log(`\n== scale (${databasePath}) ==`);
  console.log(`  memories:       ${count("SELECT COUNT(*) n FROM memory_records")}`);
  console.log(
    `  memories active: ${count("SELECT COUNT(*) n FROM memory_records WHERE status = 'active'")}`,
  );
  console.log(`  nodes:          ${count("SELECT COUNT(*) n FROM memory_nodes")}`);
  console.log(`  relations:      ${count("SELECT COUNT(*) n FROM node_relations")}`);
  console.log(`  history:        ${count("SELECT COUNT(*) n FROM history_records")}`);
  console.log(`  retrieval trace:${count("SELECT COUNT(*) n FROM retrieval_traces")}`);

  const byTier = db
    .prepare("SELECT tier, COUNT(*) n FROM memory_records WHERE status = 'active' GROUP BY tier")
    .all() as StoreRow & { tier: number }[];
  if (byTier.length) {
    console.log(`  tiers:          ${byTier.map((r) => `L${r.tier}=${r.n}`).join(", ")}`);
  }

  // ── hotspot map ──
  const rows = aggregates.filter((r) => r.section !== "total");
  const total = rows.reduce((a, r) => a + r.sum, 0);
  const totalAgg = aggregates.find((r) => r.section === "total");
  console.log(
    `\n== hotspot map (${rows.length} sections, ${totalAgg ? `${totalAgg.count} samples` : "?"}) ==`,
  );
  if (total <= 0) {
    console.log("  no perf data recorded yet");
  } else {
    const sorted = [...rows].sort((a, b) => b.sum - a.sum);
    for (const r of sorted) {
      const avg = r.count ? r.sum / r.count : 0;
      console.log(
        `  ${r.section.padEnd(16)} n=${String(r.count).padStart(6)} ` +
          `avg=${avg.toFixed(2).padStart(7)}ms  share=${((r.sum / total) * 100).toFixed(1).padStart(5)}%`,
      );
    }
    if (totalAgg && totalAgg.count) {
      console.log(
        `  ${"total".padEnd(16)} n=${String(totalAgg.count).padStart(6)} ` +
          `avg=${(totalAgg.sum / totalAgg.count).toFixed(2).padStart(7)}ms  (sum=${totalAgg.sum.toFixed(0)}ms)`,
      );
    }
  }

  // ── search.direct histogram (log-scale buckets, 0.05–10s, see perf.ts) ──
  const direct = aggregates.find((r) => r.section === "search.direct");
  if (direct) {
    console.log("\n== search.direct histogram ==");
    const { buckets } = direct;
    // PerfTimer uses 64 log-spaced buckets over [0.05ms, 10_000ms]. Render
    // the nonzero tail with its bucket range.
    const LOG_MIN = Math.log(0.05);
    const LOG_MAX = Math.log(10_000);
    for (let i = 0; i < buckets.length; i++) {
      const c = buckets[i];
      if (!c) continue;
      const lower = Math.exp(LOG_MIN + (i / 64) * (LOG_MAX - LOG_MIN));
      const upper = Math.exp(LOG_MIN + ((i + 1) / 64) * (LOG_MAX - LOG_MIN));
      console.log(
        `  ${lower.toFixed(1)}–${upper.toFixed(0)}ms  ${"█".repeat(Math.min(c, 60))} ${c}`,
      );
    }
    const avg = direct.count ? direct.sum / direct.count : 0;
    console.log(`  avg ${avg.toFixed(2)}ms over ${direct.count} samples`);
  }
} finally {
  db.close();
}
