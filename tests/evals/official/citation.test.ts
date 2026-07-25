import assert from "node:assert/strict";
import test from "node:test";

import { computeCitationSignal } from "../../../evals/official/citation.ts";

test("computeCitationSignal returns empty for empty answer or empty evidence", () => {
  assert.deepEqual(computeCitationSignal("", new Map([["e1", "hello world"]])), {
    citedCount: 0,
    totalRetrieved: 1,
    citedEvidenceIds: new Set(),
  });
  assert.deepEqual(computeCitationSignal("no citations needed here", new Map()), {
    citedCount: 0,
    totalRetrieved: 0,
    citedEvidenceIds: new Set(),
  });
});

test("computeCitationSignal detects exact substrings in the answer", () => {
  const evidence = new Map([
    ["e1", "Alice left the company in 2024"],
    ["e2", "Bob prefers dark mode"],
  ]);
  const hypothesis = "Alice left the company in 2024, so I'll update the directory.";
  const signal = computeCitationSignal(hypothesis, evidence);
  assert.equal(signal.citedCount, 1);
  assert.equal(signal.citedEvidenceIds.has("e1"), true);
  assert.equal(signal.citedEvidenceIds.has("e2"), false);
});

test("computeCitationSignal counts multiple cited sources", () => {
  const evidence = new Map([
    ["e1", "the budget was approved May 1st"],
    ["e2", "the team chose PostgreSQL as the database"],
  ]);
  const hypothesis =
    "The budget was approved May 1st, and the team chose PostgreSQL as the database for storage.";
  const signal = computeCitationSignal(hypothesis, evidence);
  assert.equal(signal.citedCount, 2);
  assert.equal(signal.citedEvidenceIds.has("e1"), true);
  assert.equal(signal.citedEvidenceIds.has("e2"), true);
});

test("computeCitationSignal is case-insensitive and whitespace-insensitive", () => {
  const evidence = new Map([["e1", "Deploy Every Friday At Midnight UTC"]]);
  const hypothesis = "deploy every friday at midnight utc is the current schedule";
  assert.equal(computeCitationSignal(hypothesis, evidence).citedCount, 1);
});

test("computeCitationSignal avoids false positives from common words", () => {
  // Five-token threshold: a four-word overlap should not count.
  const evidence = new Map([["e1", "the system is running well today"]]);
  assert.equal(computeCitationSignal("the system is running", evidence).citedCount, 0);
});
