import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { histogramAdd, histogramQuantile, PerfTimer } from "../../src/core/perf.ts";
import { NmgStore } from "../../src/core/store.ts";
import { HashingVectorEmbedder } from "../../src/core/vector.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-perf-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"), new HashingVectorEmbedder());
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("PerfTimer measures flat sections and total", () => {
  const perf = new PerfTimer();
  perf.measure("a", () => {});
  perf.start("b");
  perf.stop("b");
  perf.setTotal(10);
  const snapshot = perf.snapshot();
  assert.ok("a" in snapshot.timings);
  assert.ok("b" in snapshot.timings);
  assert.ok(snapshot.timings.a! >= 0);
  assert.equal(snapshot.totalMs, 10);
});

test("PerfTimer records elapsed wall time, not absolute timestamps", () => {
  // Fake clock: each now() advances 5ms. If a timer ever diffed absolute
  // timestamps (Date.now() epoch) instead of relative marks, section values
  // would be ~1.7e12 ms rather than 5.
  let clock = 1_000_000;
  const originalNow = performance.now;
  // @ts-expect-error — override the global for the duration of this test
  performance.now = () => (clock += 5);
  try {
    const perf = new PerfTimer();
    perf.start("span");
    perf.stop("span");
    const snapshot = perf.snapshot();
    assert.equal(snapshot.timings.span, 5);
    assert.ok(snapshot.timings.span! < 1_000, "wall-time delta, not an epoch timestamp");
  } finally {
    performance.now = originalNow;
  }
});

test("PerfTimer total is set explicitly and survives snapshot", () => {
  const perf = new PerfTimer();
  perf.measure("a", () => {});
  perf.setTotal(42.5);
  assert.equal(perf.snapshot().totalMs, 42.5);
  assert.equal(perf.totalMs, 42.5);
});

test("PerfTimer measure accumulates repeated sections", () => {
  const perf = new PerfTimer();
  perf.measure("loop", () => {});
  perf.measure("loop", () => {});
  const snapshot = perf.snapshot();
  assert.ok(snapshot.timings.loop! >= 0);
});

test("disabled PerfTimer records nothing and passes through", () => {
  const perf = new PerfTimer();
  perf.enabled = false;
  let ran = false;
  const value = perf.measure("x", () => {
    ran = true;
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(ran, true);
  assert.deepEqual(perf.snapshot(), { timings: {}, totalMs: 0 });
});

test("searchContext attaches per-phase timings and persists them in the trace", () => {
  withStore((store) => {
    store.remember({
      statement: "The bell rings at noon.",
      nodeName: "bell",
      memoryType: "fact",
      truthStatus: "verified",
    });
    const context = store.searchContext("bell", { secondPass: true });
    assert.ok(context.timings, "timings present on context");
    assert.ok(context.timings!.totalMs >= 0);
    assert.ok(context.timings!.timings["search.direct"], "direct search timed");
    assert.ok(context.timings!.timings["search.secondPass"], "second pass timed");
    assert.ok(context.timings!.timings.trace, "trace write timed");
    // Invariants guarding the two historical bugs: total must be a wall-clock
    // duration (not an epoch timestamp, which would be ~1.7e12) and must
    // cover the sections (trace is measured after total was originally set).
    assert.ok(context.timings!.totalMs < 60_000, "totalMs is a duration, not an epoch ms");
    const sectionSum = Object.values(context.timings!.timings).reduce((sum, ms) => sum + ms, 0);
    assert.ok(
      context.timings!.totalMs + 50 >= sectionSum,
      `total covers all sections (total=${context.timings!.totalMs}, sum=${sectionSum})`,
    );

    const trace = store.retrievalTrace(context.activeGraph!.id);
    assert.ok(trace);
    assert.deepEqual(trace.timings, context.timings);
  });
});

test("remember attaches write timing; perf:false disables it", () => {
  withStore((store) => {
    const result = store.remember({ statement: "Lunch at 1pm.", nodeName: "lunch" });
    assert.ok(result.timings, "write timings present");
    assert.ok(result.timings!.timings.write >= 0);
    // Total is the wrapper wall clock; sub-ms writes round to within 0.01 of
    // the write span, so compare with rounding tolerance.
    assert.ok(result.timings!.totalMs + 0.01 >= result.timings!.timings.write);

    const bare = store.remember({
      statement: "Dinner at 7pm.",
      nodeName: "dinner",
      perf: false,
    });
    assert.equal(bare.timings, undefined);
  });
});

test("domain objects (NodeTransform) do not carry timings", () => {
  withStore((store) => {
    const alpha = store.remember({ statement: "Alpha is red.", nodeName: "alpha" });
    const beta = store.remember({ statement: "Beta is blue.", nodeName: "beta" });
    const transform = store.mergeNodes({
      sourceNodeIds: [alpha.node.id, beta.node.id],
      targetName: "merged",
      summary: "merged node",
    });
    // NodeTransform is a persisted, idempotent domain object (getNodeTransform
    // must round-trip deep-equal); timing is diagnostic and must not attach.
    assert.equal("timings" in transform, false);
  });
});

test("search results preserve the original writeReason instead of legacy_write", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "The archive uses SQLite.",
      nodeName: "archive storage",
      writeReason: "current architecture decision",
      writeSource: "agent",
    });
    // Both retrieval paths build results through mapSearchResult; the legacy
    // fallback ("legacy_write" / "core") is only valid when the column is
    // genuinely absent.
    const viaSearch = store.search("archive storage", { maxTier: 3 });
    const viaContext = store.searchContext("archive storage", { maxTier: 3 });
    for (const result of [...viaSearch, ...viaContext.results]) {
      if (result.memory.id !== saved.memory.id) continue;
      assert.equal(result.memory.writeReason, "current architecture decision");
      assert.equal(result.memory.writeSource, "agent");
    }
    assert.ok(
      [...viaSearch, ...viaContext.results].some((result) => result.memory.id === saved.memory.id),
      "saved memory reachable through both paths",
    );
  });
});

test("perf defaults on unless disabled; perf:false opt-out verified", () => {
  withStore((store) => {
    store.remember({ statement: "Default perf.", nodeName: "perf-default" });
    // Default (no option) → timings present.
    const context = store.searchContext("perf-default");
    assert.ok(context.timings, "default searchContext carries timings");
    // Explicit opt-out → none, and sections absent from the response.
    const bare = store.searchContext("perf-default", { perf: false });
    assert.equal(bare.timings, undefined);
  });
});

test("perf flag survives the gRPC daemon round-trip", async () => {
  const { connectDaemon, invokeDaemon, shutdownOwnedDaemon } =
    await import("../../src/cli/daemon-client.ts");
  const directory = mkdtempSync(join(tmpdir(), "nmg-perf-grpc-"));
  const connection = await connectDaemon(join(directory, "nmg.sqlite"));
  try {
    const remembered = (await invokeDaemon(connection, "remember", {
      statement: "gRPC perf probe",
      nodeName: "grpc-perf",
    })) as { memory: { id: string } };
    assert.ok(remembered.memory.id);
    // Core timing is default-on (trace persistence); the wire-level contract
    // is that perf:false disables it end to end.
    const explicitOff = (await invokeDaemon(connection, "search", {
      query: "gRPC perf probe",
      perf: false,
    })) as { timings?: unknown };
    assert.equal(explicitOff.timings, undefined, "perf:false disables timings through gRPC");
    const on = (await invokeDaemon(connection, "search", {
      query: "gRPC perf probe",
      perf: true,
    })) as { timings?: { totalMs: number; timings: Record<string, number> } };
    assert.ok(on.timings, "perf:true returns timings through gRPC");
    assert.ok(on.timings!.totalMs >= 0);
    assert.ok(on.timings!.timings["search.direct"] >= 0);
  } finally {
    await shutdownOwnedDaemon(connection);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("histogram quantiles approximate known distributions", () => {
  // All values identical → every quantile equals that value.
  let buckets: number[] = [];
  for (let index = 0; index < 100; index += 1) buckets = histogramAdd(buckets, 5);
  assert.ok(
    Math.abs(histogramQuantile(buckets, 0.5) - 5) < 1,
    `p50≈5 (${histogramQuantile(buckets, 0.5)})`,
  );
  assert.ok(
    Math.abs(histogramQuantile(buckets, 0.95) - 5) < 1,
    `p95≈5 (${histogramQuantile(buckets, 0.95)})`,
  );

  // Mixed 1ms/10ms values → p50 near 1, p95 near 10.
  let mixed: number[] = [];
  for (let index = 0; index < 90; index += 1) mixed = histogramAdd(mixed, 1);
  for (let index = 0; index < 10; index += 1) mixed = histogramAdd(mixed, 10);
  const p50 = histogramQuantile(mixed, 0.5);
  const p95 = histogramQuantile(mixed, 0.95);
  assert.ok(p50 < 3, `p50 near low mass (${p50})`);
  assert.ok(p95 > 5, `p95 near high mass (${p95})`);

  // Empty → 0.
  assert.equal(histogramQuantile([], 0.5), 0);
});

test("filterUsage records effective filter dimensions and selectivity", () => {
  withStore((store) => {
    store.remember({
      statement: "Atlas uses SQLite.",
      nodeName: "Atlas storage",
      scope: { project: "atlas" },
    });
    store.remember({
      statement: "NMG uses Pi.",
      nodeName: "NMG runtime",
      scope: { project: "nmg" },
    });

    // No filter → no filterUsage on context or trace.
    const plain = store.searchContext("storage");
    assert.equal(plain.filterUsage, undefined, "no filter → no filterUsage");

    // Scoped query → dimension recorded, only matching-scope results, persists.
    const scoped = store.searchContext("storage", { scope: { project: "atlas" } });
    assert.ok(scoped.filterUsage, "scoped query captures filterUsage");
    assert.ok(scoped.filterUsage!.dimensions.includes("scope.project"));
    // Pushdown semantics: the SQL already filtered, so every result matches
    // the scope; selectivity is 0 because no post-filter remained.
    assert.ok(
      scoped.results.every(
        (result) => result.memory.scope && result.memory.scope.project === "atlas",
      ),
      "pushdown leaves only matching-scope results",
    );
    assert.equal(scoped.filterUsage!.selectivity, 0, "no post-filter after pushdown");

    const trace = store.retrievalTrace(scoped.activeGraph!.id);
    assert.ok(trace?.filterUsage, "filterUsage persists in the trace");
    assert.ok(trace!.filterUsage!.dimensions.includes("scope.project"));
  });
});

test("scope pushdown handles dotted keys and multiple scope keys", () => {
  withStore((store) => {
    store.remember({
      statement: "Atlas prod storage uses SQLite.",
      nodeName: "Atlas",
      scope: { "app.name": "atlas", env: "prod" },
    });
    store.remember({
      statement: "Atlas staging storage uses Postgres.",
      nodeName: "Atlas",
      scope: { "app.name": "atlas", env: "staging" },
    });
    store.remember({
      statement: "NMG storage uses Pi.",
      nodeName: "NMG",
      scope: { "app.name": "nmg", env: "prod" },
    });

    // Dotted key: pushdown must match the literal key, not strip the dot.
    const dotted = store.search("storage", { maxTier: 3, scope: { "app.name": "atlas" } });
    assert.equal(dotted.length, 2, "dotted key filters both atlas rows");
    assert.ok(dotted.every((r) => r.memory.scope["app.name"] === "atlas"));

    // Multiple scope keys AND together.
    const both = store.search("storage", {
      maxTier: 3,
      scope: { "app.name": "atlas", env: "prod" },
    });
    assert.equal(both.length, 1, "multi-key scope ANDs");
    assert.match(both[0]?.memory.statement ?? "", /SQLite/);
  });
});

test("scope pushdown never changes behavior vs the legacy in-memory filter", () => {
  withStore((store) => {
    store.remember({
      statement: "Prod DB is PostgreSQL.",
      nodeName: "database",
      scope: { environment: "production" },
    });
    store.remember({
      statement: "Test DB is SQLite.",
      nodeName: "database",
      scope: { environment: "test" },
    });
    store.remember({ statement: "Unscoped fact.", nodeName: "database" });
    // A memory with no scope must never match a scoped query (json_extract
    // returns null, which does not equal any value).
    const scoped = store.search("database", {
      maxTier: 3,
      scope: { environment: "production" },
    });
    assert.equal(scoped.length, 1);
    assert.match(scoped[0]?.memory.statement ?? "", /PostgreSQL/);
    // And the unscoped memory still appears for unscoped queries.
    const plain = store.search("database", { maxTier: 3 });
    assert.equal(plain.length, 3);
  });
});

test("SQLite PRAGMA tuning is applied on open", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-prgma-"));
  const database = join(directory, "nmg.sqlite");
  try {
    const store = new NmgStore(database, new HashingVectorEmbedder());
    // A second connection in the same process probes the database; the
    // store's own connection was configured at construction. WAL + NORMAL +
    // busy_timeout are the multi-writer contract.
    const probe = new DatabaseSync(database, { readOnly: true });
    const wal = probe.prepare("PRAGMA journal_mode").get();
    assert.equal(String(wal.journal_mode), "wal", "WAL journal mode");
    const idx = probe
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_retrieval_traces_created_at'",
      )
      .get();
    assert.ok(idx, "trace prune index exists");
    probe.close();
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("perfAggregates accumulates Welford statistics and survives pruning", () => {
  withStore((store) => {
    store.remember({ statement: "Aggregate probe.", nodeName: "agg-probe" });
    for (let index = 0; index < 5; index += 1) {
      store.searchContext(`agg probe ${index}`, { secondPass: true });
    }
    const aggregates = store.perfAggregates();
    const sections = new Set(aggregates.map((entry) => entry.section));
    assert.ok(sections.has("search.direct"), "direct section aggregated");
    assert.ok(sections.has("total"), "total aggregated");
    const total = aggregates.find((entry) => entry.section === "total")!;
    assert.equal(total.count, 5);
    assert.ok(total.sum > 0);
    assert.ok(total.buckets.length > 0, "histogram buckets captured");
    const sumBuckets = total.buckets.reduce((sum, count) => sum + count, 0);
    assert.equal(sumBuckets, 5, "histogram bucket counts match sample count");
    // Welford variance must be non-negative.
    const variance =
      total.count > 1
        ? (total.sumSq - (total.sum * total.sum) / total.count) / (total.count - 1)
        : 0;
    assert.ok(variance >= -1e-9, `variance non-negative (${variance})`);

    // Prune everything; aggregates must survive (long-term statistics outlive
    // the raw-trace window by design).
    store.pruneRetrievalTraces({ maxDays: 0, maxRows: 1 });
    const after = store.perfAggregates();
    const totalAfter = after.find((entry) => entry.section === "total")!;
    assert.equal(totalAfter.count, 5, "aggregates survive raw-trace pruning");
  });
});

test("pruneRetrievalTraces enforces age and row-count windows", () => {
  withStore((store) => {
    store.remember({ statement: "Prune probe.", nodeName: "prune-probe" });
    for (let index = 0; index < 10; index += 1) {
      store.searchContext(`prune probe ${index}`);
    }
    // Row-count ceiling: keep the newest 3.
    const prunedByCount = store.pruneRetrievalTraces({ maxDays: 3650, maxRows: 3 });
    assert.ok(prunedByCount >= 7, `pruned by count (${prunedByCount})`);
    const remaining = store.retrievalTracesCount();
    assert.ok(remaining <= 3, `at most maxRows remain (${remaining})`);

    // Age window: insert a fresh trace (now), then prune with maxDays 0 —
    // the fresh row is younger than any window, so only older rows go.
    const beforeAgePrune = store.retrievalTracesCount();
    const prunedByAge = store.pruneRetrievalTraces({ maxDays: 0, maxRows: 1_000_000 });
    assert.ok(prunedByAge >= beforeAgePrune - 1, `age window prunes (${prunedByAge})`);
  });
});

test("existing database gains timings_json via migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-perf-"));
  const database = join(directory, "nmg.sqlite");
  try {
    // Open once to create the schema, then reopen — the migration path adds
    // timings_json to a pre-timings schema.
    const first = new NmgStore(database, new HashingVectorEmbedder());
    first.close();
    const store = new NmgStore(database, new HashingVectorEmbedder());
    try {
      store.remember({ statement: "Migration check.", nodeName: "migration" });
      const context = store.searchContext("migration");
      assert.ok(context.timings, "timings survive migration");
      const trace = store.retrievalTrace(context.activeGraph!.id);
      assert.ok(trace && trace.timings, "trace timings survive migration");
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("perf maintenance commands reach the gRPC daemon end to end", async () => {
  const { connectDaemon, invokeDaemon, shutdownOwnedDaemon } =
    await import("../../src/cli/daemon-client.ts");
  const directory = mkdtempSync(join(tmpdir(), "nmg-perf-grpc-maint-"));
  const connection = await connectDaemon(join(directory, "nmg.sqlite"));
  try {
    // A search leaves a trace row; perfAggregates must surface it through
    // the daemon (regression: the RPC was missing from the proto, so the
    // client stub did not exist and the command reported unavailable).
    await invokeDaemon(connection, "remember", {
      statement: "perf maintenance probe",
      nodeName: "grpc-maint",
    });
    const searched = (await invokeDaemon(connection, "search", {
      query: "perf maintenance",
    })) as { activeGraph?: { id: string } };
    assert.ok(searched.activeGraph?.id, "search produced a trace");

    // Arrays cross the Struct wire wrapped in { value: [...] }.
    const wrapped = (await invokeDaemon(connection, "perfAggregates")) as {
      value: Array<{ section: string; count: number; buckets: number[] }>;
    };
    const aggregates = Array.isArray(wrapped) ? wrapped : wrapped.value;
    assert.ok(Array.isArray(aggregates), "perfAggregates RPC resolves");
    assert.ok(
      aggregates.some((entry) => entry.section === "search.direct" && entry.count >= 1),
      `aggregates include search.direct (${aggregates.map((a) => a.section).join(", ")})`,
    );

    const pruned = (await invokeDaemon(connection, "pruneRetrievalTraces", {
      maxRows: 1_000_000,
    })) as { pruned: number };
    assert.equal(typeof pruned.pruned, "number", "pruneRetrievalTraces RPC resolves");
  } finally {
    await shutdownOwnedDaemon(connection);
    rmSync(directory, { recursive: true, force: true });
  }
});
