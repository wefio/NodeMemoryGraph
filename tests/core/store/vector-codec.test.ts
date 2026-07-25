import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeVector,
  parseVector,
  storedVector,
} from "../../../src/core/store/vector-codec.ts";

test("encodeVector and parseVector round-trip through float32", () => {
  const original = [0.5, -0.25, 1, 0];
  const decoded = parseVector(encodeVector(original));
  assert.equal(decoded.length, original.length);
  decoded.forEach((value, index) => {
    assert.ok(Math.abs(value - original[index]!) < 1e-6);
  });
});

test("parseVector reads the legacy JSON form", () => {
  assert.deepEqual(parseVector("[1,2,3]"), [1, 2, 3]);
});

test("parseVector returns empty for malformed or absent values", () => {
  // A corrupt embedding should degrade retrieval, not throw on the read path.
  assert.deepEqual(parseVector("not json"), []);
  assert.deepEqual(parseVector(null), []);
  assert.deepEqual(parseVector(undefined), []);
  assert.deepEqual(parseVector("[1,\"x\",null,2]"), [1, 2]);
});

test("storedVector prefers the binary column over legacy JSON", () => {
  const row = {
    vector_blob: new Uint8Array(encodeVector([1, 2])),
    vector_json: "[9,9,9]",
  };
  assert.deepEqual(storedVector(row), [1, 2]);
});

test("storedVector falls back to JSON when no blob is present", () => {
  assert.deepEqual(storedVector({ vector_blob: null, vector_json: "[4,5]" }), [4, 5]);
});

test("storedVector honours a column prefix for joined queries", () => {
  assert.deepEqual(storedVector({ ve_vector_json: "[7]" }, "ve_"), [7]);
});
