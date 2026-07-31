import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PerfTimer } from "../../src/core/perf.ts";
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
