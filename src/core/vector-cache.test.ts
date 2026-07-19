import assert from "node:assert/strict";
import test from "node:test";

import { Float32VectorCache } from "./vector-cache.ts";

test("Float32VectorCache appends, updates, filters, and grows geometrically", () => {
  const cache = new Float32VectorCache(2, 1);
  cache.upsert("a", [1, 0]);
  cache.upsert("b", [0, 1]);
  cache.upsert("a", [0.5, 0.5]);

  assert.equal(cache.size, 2);
  assert.equal(cache.byteLength, 4 * 2 * 2);
  assert.equal(cache.score([0, 1])[0]?.id, "b");
  assert.deepEqual(cache.score([1, 0], new Set(["a"])).map((item) => item.id), ["a"]);
});
