import assert from "node:assert/strict";
import test from "node:test";

import { buildSnapshot, normalizeByMode } from "../../../evals/official/snapshot.ts";

test("normalizeByMode accepts the official scorer shape", () => {
  const result = normalizeByMode({
    "nmg-graph": { score: 0.75, count: 8, byCategory: { multi_hop: 0.5 } },
  });
  assert.deepEqual(result["nmg-graph"], {
    score: 0.75,
    count: 8,
    byCategory: { multi_hop: 0.5 },
  });
});

test("normalizeByMode accepts the longmemeval accuracy/total shape", () => {
  const result = normalizeByMode({ "flat-hybrid": { accuracy: 0.5, total: 14 } });
  assert.deepEqual(result["flat-hybrid"], { score: 0.5, count: 14 });
});

test("normalizeByMode reports NaN for a missing score rather than defaulting to zero", () => {
  // A zero default would be indistinguishable from a genuine score of 0.0 and
  // would silently corrupt trend comparisons.
  const result = normalizeByMode({ broken: { count: 3 } });
  assert.ok(Number.isNaN(result.broken!.score));
  assert.equal(result.broken!.count, 3);
});

test("buildSnapshot records provenance and never claims leaderboard comparability", () => {
  const snapshot = buildSnapshot({
    benchmark: "locomo",
    protocol: "official-protocol/deterministic",
    judgeModel: null,
    upstream: { commit: "abc123" },
    byMode: { "nmg-auto": { score: 0.6, count: 5 } },
    codeRevision: "deadbeefcafe1234",
    sampleFingerprint: "fp-1",
  });

  assert.equal(snapshot.benchmark, "locomo");
  assert.equal(snapshot.codeRevision, "deadbeefcafe1234");
  assert.equal(snapshot.sampleFingerprint, "fp-1");
  assert.equal(snapshot.leaderboardComparable, false);
  assert.deepEqual(snapshot.byMode["nmg-auto"], { score: 0.6, count: 5 });
  assert.ok(!Number.isNaN(Date.parse(snapshot.recordedAt)));
});

test("buildSnapshot tolerates missing provenance", () => {
  const snapshot = buildSnapshot({
    benchmark: "beam",
    protocol: "official-protocol/deepseek-judge",
    judgeModel: "deepseek/deepseek-v4-flash",
    upstream: null,
    byMode: {},
  });
  assert.equal(snapshot.codeRevision, null);
  assert.equal(snapshot.sampleFingerprint, null);
});
