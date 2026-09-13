import assert from "node:assert/strict";
import test from "node:test";

import { coverageThreshold } from "../../src/core/sufficiency-features.ts";

const countAt = (scores: readonly number[], tau: number) => scores.filter((s) => s >= tau).length;

test("the coverage threshold opens the requested share of queries", () => {
  const scores = [1, 2, 3, 4, 5];
  // 40% of five is two queries, so the threshold is the second highest score.
  assert.equal(coverageThreshold(scores, 0.4), 4);
  assert.equal(countAt(scores, coverageThreshold(scores, 0.4)), 2);
  // Full coverage opens everything; a tiny coverage opens only the best.
  assert.equal(countAt(scores, coverageThreshold(scores, 1)), 5);
  assert.equal(countAt(scores, coverageThreshold(scores, 0.1)), 1);
  // Monotone in the target: a larger budget cannot open fewer queries.
  let previous = -1;
  for (const coverage of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const opened = countAt(scores, coverageThreshold(scores, coverage));
    assert.ok(opened >= previous, `coverage ${coverage} opened ${opened}, before it ${previous}`);
    previous = opened;
  }
});

test("ties open together rather than being broken", () => {
  const tied = [5, 5, 5];
  // Two of three are wanted, but the run cannot be split, so all three open.
  assert.equal(countAt(tied, coverageThreshold(tied, 0.34)), 3);
});

test("the coverage threshold refuses impossible input and never reorders the caller's list", () => {
  assert.throws(() => coverageThreshold([1, 2], 0), /target coverage/);
  assert.throws(() => coverageThreshold([1, 2], 1.5), /target coverage/);
  assert.throws(() => coverageThreshold([], 0.5), /at least one score/);
  assert.throws(() => coverageThreshold([1, Number.NaN], 0.5), /must be finite/);
  const unsorted = [0.2, 0.9, 0.4];
  coverageThreshold(unsorted, 0.5);
  assert.deepEqual(unsorted, [0.2, 0.9, 0.4]);
});
