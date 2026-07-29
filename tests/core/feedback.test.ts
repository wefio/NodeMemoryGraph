import assert from "node:assert/strict";
import test from "node:test";

import { contentTokens, deriveUsedMemoryIds } from "../../src/core/feedback.ts";
import type { MemorySearchResult } from "../../src/core/types.ts";

function mkResult(id: string, statement: string): MemorySearchResult {
  return {
    memory: { id, statement },
    node: {} as MemorySearchResult["node"],
    evidence: {} as MemorySearchResult["evidence"],
    evidenceRecords: [],
    lexicalScore: 0,
    vectorScore: 0,
    routeScore: 0,
    combinedScore: 0,
  } as unknown as MemorySearchResult;
}

test("contentTokens: numbers (any length) + len>=4 non-stopword words", () => {
  // "ran"/"in" too short, "the"/"I" stopwords/short, "5k"/"25" numeric.
  assert.deepEqual(contentTokens("I ran the 5K in 25 minutes"), ["5k", "25", "minutes"]);
});

test("deriveUsedMemoryIds: verbatim quote of the answer-bearing memory is detected", () => {
  const results = [
    mkResult("a", "My personal best time in the 5K was 25 minutes 50 seconds"),
    mkResult("b", "I prefer running in the morning"),
  ];
  // Answer restates the 5K time -> memory "a" used, "b" not.
  const used = deriveUsedMemoryIds(
    "Your personal best time was 25 minutes 50 seconds.",
    results,
  );
  assert.deepEqual(used, ["a"]);
});

test("deriveUsedMemoryIds: paraphrase with >=half token overlap is detected", () => {
  const results = [mkResult("b", "I prefer running in the morning")];
  // "running in the morning is cool" -> running, morning overlap (2 of 3).
  const used = deriveUsedMemoryIds("running in the morning is cool", results);
  assert.deepEqual(used, ["b"]);
});

test("deriveUsedMemoryIds: unrelated answer yields no used memories", () => {
  const results = [mkResult("a", "My personal best time in the 5K was 25 minutes 50 seconds")];
  const used = deriveUsedMemoryIds("I don't have that information.", results);
  assert.deepEqual(used, []);
});

test("deriveUsedMemoryIds: empty answer or empty statement is safe", () => {
  assert.deepEqual(deriveUsedMemoryIds("", [mkResult("a", "something distinctive")]), []);
  assert.deepEqual(deriveUsedMemoryIds("something distinctive", [mkResult("a", "")]), []);
});
