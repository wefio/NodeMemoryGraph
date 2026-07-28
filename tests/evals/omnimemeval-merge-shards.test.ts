import assert from "node:assert/strict";
import test from "node:test";

import { mergeLongMemEvalShards } from "../../evals/omnimemeval/merge-longmemeval-shards.ts";

test("LongMemEval shard merge restores deterministic conversation order", () => {
  const merged = mergeLongMemEvalShards([
    { "user_shard_b_1": [{ question: "one" }] },
    { "user_shard_a_0": [{ question: "zero" }] },
  ], 2);

  assert.deepEqual(Object.keys(merged), ["user_shard_a_0", "user_shard_b_1"]);
});

test("LongMemEval shard merge rejects duplicate and missing indices", () => {
  assert.throws(
    () => mergeLongMemEvalShards([
      { "user_a_0": [] },
      { "user_b_0": [] },
    ], 1),
    /duplicate conversation index 0/,
  );
  assert.throws(
    () => mergeLongMemEvalShards([{ "user_a_1": [] }], 2),
    /missing conversation index 0/,
  );
});
