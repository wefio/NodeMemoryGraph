import assert from "node:assert/strict";
import test from "node:test";

import {
  hammingDistance,
  simhash64,
  simhashFromHex,
  simhashToHex,
} from "../../src/core/simhash.ts";

test("simhash: identical text produces identical fingerprint", () => {
  const content = "const x = 1;\n// a comment\nfunction alpha() { return x; }\n";
  assert.equal(simhash64(content), simhash64(content));
  assert.equal(simhash64(""), simhash64(""));
});

test("simhash: near-duplicate documents sit within the drift threshold", () => {
  const original = [
    "The indexing pipeline batches embeddings before the store drains them.",
    "A bounded passive-scope file index crawled project files on every search.",
    "Tesserae are content-anchored bookmarks; snippets relocate on read.",
    "SimHash fingerprints documents so a small edit stays recoverable.",
    "Memory records carry provenance, scope and verification; files do not.",
  ].join("\n");
  const edited = original.replace(
    "batches embeddings before the store drains them",
    "batches embeddings before the store drains them all",
  );
  const fingerprint = simhash64(original);
  const editedFingerprint = simhash64(edited);
  assert.ok(
    hammingDistance(fingerprint, editedFingerprint) <= 6,
    `1%-scale edit stays within threshold (distance ${hammingDistance(fingerprint, editedFingerprint)})`,
  );
});

test("simhash: unrelated documents sit far beyond the threshold", () => {
  const one = simhash64("The quick brown fox jumps over the lazy dog near the river bank at dusk.");
  const two = simhash64(
    "Database transactions must be atomic, consistent, isolated and durable by contract.",
  );
  assert.ok(
    hammingDistance(one, two) > 10,
    `unrelated texts separate (distance ${hammingDistance(one, two)})`,
  );
});

test("simhash: hex round-trips losslessly across the full 64-bit range", () => {
  const samples = [0n, 1n, 0xffffffffffffffffn, simhash64("any content"), 0xdeadbeefcafef00dn];
  for (const sample of samples) {
    assert.equal(simhashFromHex(simhashToHex(sample)), sample);
    assert.equal(simhashToHex(sample).length, 16, "canonical 16 hex chars");
  }
});

test("hammingDistance counts differing bits", () => {
  assert.equal(hammingDistance(0n, 0n), 0);
  assert.equal(hammingDistance(1n, 0n), 1);
  assert.equal(hammingDistance(0xfn, 0x0n), 4);
  assert.equal(hammingDistance(0xffffffffffffffffn, 0x0000000000000000n), 64);
});

test("simhashTokens lowercases words and isolates Han ideographs", () => {
  // token stream is an implementation detail; exercise via fingerprint stability
  const mixed = simhash64("NodeMemoryGraph 记忆系统 uses nodeMemoryGraph consistently");
  const stable = simhash64("nodememorygraph 记 忆 系 统 uses nodememorygraph consistently");
  // Case folding makes the English halves identical; Han runs tokenize per char,
  // so splitting a Han run into separate characters must NOT change the result.
  assert.equal(mixed, stable);
});
