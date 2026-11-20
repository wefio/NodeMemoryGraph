import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceCharacterCount, packRankedEvidence } from "../../src/core/memory/evidence-page.ts";

function item(value: string, utility: number, length: number) {
  return { key: value, value, utility, text: "x".repeat(length) };
}

test("the first candidate competes with other evidence for the shared budget", () => {
  const ranked = [
    item("long", 0.9, 30),
    item("oversized", 1, 50),
    item("short-a", 0.6, 16),
    item("short-b", 0.5, 14),
    item("short-a", 0.4, 16),
  ];
  const result = packRankedEvidence(ranked, 20, 36);
  assert.deepEqual(result.values, ["short-a", "short-b"]);
  assert.equal(result.characters, 32);
});

test("evidence page counts Unicode characters and includes exact boundary candidates", () => {
  const item = { key: "unicode", value: "selected", text: "😀中A", utility: 0.9 };
  assert.equal(evidenceCharacterCount(item.text), 3);
  assert.deepEqual(packRankedEvidence([item], 1, 3), {
    values: ["selected"],
    characters: 3,
  });
  assert.deepEqual(packRankedEvidence([item], 20, 3), {
    values: ["selected"],
    characters: 3,
  });
  assert.deepEqual(packRankedEvidence([item], 1, 2), { values: [], characters: 0 });
});

test("evidence page selects each exact source once with a cap of twenty records", () => {
  const shared = { ...item("same", 0.3, 12), key: "source" };
  const preferred = { ...item("better-rendering", 0.9, 12), key: "source" };
  const ranked = [
    shared,
    preferred,
    ...Array.from({ length: 25 }, (_, i) => item(`item-${i}`, 0.5, 12)),
  ];
  const result = packRankedEvidence(ranked, 100, 9_000);
  assert.equal(result.values.length, 20);
  assert.equal(result.values[0], "better-rendering");
  assert.ok(!result.values.includes("same"));
  assert.equal(result.characters, 278);
});
