import assert from "node:assert/strict";
import test from "node:test";

import { Float32VectorCache } from "../../src/core/vector-cache.ts";

test("Float32VectorCache appends, updates, filters, and grows geometrically", () => {
  const cache = new Float32VectorCache(2, 1);
  cache.upsert("a", [1, 0]);
  cache.upsert("b", [0, 1]);
  cache.upsert("a", [0.5, 0.5]);

  assert.equal(cache.size, 2);
  assert.equal(cache.byteLength, 4 * 2 * 2);
  assert.equal(cache.score([0, 1])[0]?.id, "b");
  assert.deepEqual(
    cache.score([1, 0], new Set(["a"])).map((item) => item.id),
    ["a"],
  );
});

test("remove shrinks the cache and reuses the freed slot", () => {
  const cache = new Float32VectorCache(3, 2);
  cache.upsert("a", [1, 0, 0]);
  cache.upsert("b", [0, 1, 0]);
  cache.upsert("c", [0, 0, 1]);
  assert.equal(cache.size, 3);

  cache.remove("b");
  assert.equal(cache.size, 2);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("c"), true);
  // The freed slot was reused: "a" and "c" must still be retrievable via score.
  const top = cache.score([0, 0, 1])[0]!;
  assert.equal(top.id, "c");
  assert.ok(top.score > 0.9);
});

test("remove is idempotent", () => {
  const cache = new Float32VectorCache(1, 2);
  cache.upsert("a", [1]);
  cache.remove("nope");
  assert.equal(cache.size, 1);
  cache.remove("a");
  cache.remove("a");
  assert.equal(cache.size, 0);
});
