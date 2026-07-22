import assert from "node:assert/strict";
import test from "node:test";

import {
  pairedAgainst,
  summarizeAccuracy,
  summarizeByMode,
  summarizeLatencyByMode,
} from "./report.ts";

const rows = [
  { questionId: "q1", repeat: 0, mode: "flat", passed: true, durationMs: 10 },
  { questionId: "q2", repeat: 0, mode: "flat", passed: false, durationMs: 30 },
  { questionId: "q1", repeat: 0, mode: "nmg", passed: false, durationMs: 20 },
  { questionId: "q2", repeat: 0, mode: "nmg", passed: true, durationMs: 40 },
  { questionId: "q1", repeat: 1, mode: "flat", passed: false, durationMs: 50 },
  { questionId: "q1", repeat: 1, mode: "nmg", passed: true, durationMs: 60 },
];

test("accuracy summaries include bounded Wilson intervals", () => {
  const summary = summarizeAccuracy(rows);
  assert.equal(summary.passed, 3);
  assert.equal(summary.total, 6);
  assert.equal(summary.accuracy, 0.5);
  assert.ok(summary.confidence95.lower > 0);
  assert.ok(summary.confidence95.upper < 1);
  assert.deepEqual(Object.keys(summarizeByMode(rows)), ["flat", "nmg"]);
});

test("latency summaries expose mean and nearest-rank percentiles", () => {
  assert.deepEqual(summarizeLatencyByMode(rows).flat, {
    count: 3,
    meanMs: 30,
    p50Ms: 30,
    p95Ms: 50,
  });
});

test("paired comparison matches question and repeat", () => {
  assert.deepEqual(pairedAgainst(rows, "flat").nmg, {
    baseline: "flat",
    candidate: "nmg",
    pairs: 3,
    bothPass: 0,
    candidateOnly: 2,
    baselineOnly: 1,
    bothFail: 0,
    netWins: 1,
  });
});
