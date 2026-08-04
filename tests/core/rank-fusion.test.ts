import assert from "node:assert/strict";
import test from "node:test";

import { reciprocalRankFusion } from "../../src/lab/rank-fusion.ts";

test("RRF preserves one route and removes duplicate ids", () => {
  assert.deepEqual(
    reciprocalRankFusion([{ ids: ["a", "b", "b", "c"] }], 3).map(({ id }) => id),
    ["a", "b", "c"],
  );
});

test("RRF rewards agreement across retrieval routes", () => {
  const fused = reciprocalRankFusion([
    { ids: ["a", "b", "c"], weight: 1.5 },
    { ids: ["c", "b", "d"] },
  ], 4);
  assert.deepEqual(fused.map(({ id }) => id), ["b", "c", "a", "d"]);
});

test("RRF is deterministic and obeys the hard output cap", () => {
  const routes = [{ ids: ["b", "a"] }, { ids: ["a", "b"] }];
  assert.deepEqual(reciprocalRankFusion(routes, 1), reciprocalRankFusion(routes, 1));
  assert.equal(reciprocalRankFusion(routes, 1).length, 1);
});
