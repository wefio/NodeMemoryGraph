import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEVANCE_FEATURE_COUNT,
  relevanceFeatureMatrix,
  tokenize,
} from "../../src/core/relevance-features.ts";
import { applyLearnedGate } from "../../src/core/learned-gate.ts";
import type { MemorySearchResult, RelevanceModelLike } from "../../src/core/types.ts";

function result(
  statement: string,
  lexical: number,
  tier = 1,
  importance = 0.5,
): MemorySearchResult {
  return {
    memory: {
      statement,
      tier,
      importance,
      confidence: null,
      eventTime: null,
      createdAt: new Date(0).toISOString(),
    },
    node: {},
    evidence: {},
    evidenceRecords: [],
    lexicalScore: lexical,
    vectorScore: 0,
    routeScore: 0,
    combinedScore: lexical,
  } as unknown as MemorySearchResult;
}

test("relevanceFeatureMatrix emits one row per result, aligned with the names", () => {
  const results = [result("alpha beta", 10), result("gamma", 2)];
  const matrix = relevanceFeatureMatrix("alpha beta", results, { nowMs: Date.parse("2026-01-01") });
  assert.equal(matrix.length, 2);
  for (const row of matrix) assert.equal(row.length, RELEVANCE_FEATURE_COUNT);
  // rank_norm runs 0 → 1 over the list.
  assert.equal(matrix[0]![6], 0);
  assert.equal(matrix[1]![6], 1);
  // term_coverage: first statement has every query token, second has none.
  assert.equal(matrix[0]![7], 1);
  assert.equal(matrix[1]![7], 0);
  // rel_ratio: the top candidate is 1, the rest ≤ 1.
  assert.equal(matrix[0]![5], 1);
  assert.ok(matrix[1]![5]! < 1);
});

test("tokenize keeps ascii words and individual CJK characters", () => {
  assert.deepEqual(tokenize("Atlas 项目 SQLite"), ["atlas", "项", "目", "sqlite"]);
});

test("applyLearnedGate keeps only candidates the model admits and may abstain", () => {
  const results = [result("a", 10), result("b", 1)];
  // Stub model scores by raw_log (feature 0): 10 → 2.4, 1 → 0.69.
  const model: RelevanceModelLike = { predict: (features) => features[0]! };
  assert.deepEqual(applyLearnedGate("q", results, model, 1.0), [results[0]]);
  // A floor above every score injects nothing (abstain).
  assert.deepEqual(applyLearnedGate("q", results, { predict: () => 0.1 }, 0.5), []);
});
