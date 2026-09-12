import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL_FLOOR,
  DEFAULT_RELEVANCE_FLOOR,
  DEFAULT_RELEVANCE_MAX_CV,
  applyRelevanceGate,
  boundedRelevance,
  queryScoreStats,
} from "../../src/core/relevance-gate.ts";

const high = { lexicalScore: 20, vectorScore: 1, routeScore: 1 };
const low = { lexicalScore: 0, vectorScore: 0, routeScore: 0 };
const lexical = (lexicalScore: number) => ({ lexicalScore, vectorScore: 0, routeScore: 0 });

test("boundedRelevance is bounded even for the raw-fts5 lexical scale", () => {
  // The degraded fts5 path records raw BM25 (e.g. 9.0) in combinedScore; the
  // gate must recompute a bounded score from the components instead.
  const raw = boundedRelevance({ lexicalScore: 9, vectorScore: 0, routeScore: 0 });
  assert.ok(raw >= 0 && raw <= 1, `expected [0,1], got ${raw}`);
  assert.ok(boundedRelevance(high) >= 0.4);
  assert.equal(boundedRelevance(low), 0);
});

test("applyRelevanceGate drops below-floor results and keeps above-floor ones", () => {
  const kept = applyRelevanceGate([high, low], { floor: DEFAULT_RELEVANCE_FLOOR });
  assert.deepEqual(kept, [high]);
});

test("applyRelevanceGate may return nothing (abstain) and caps at limit", () => {
  assert.deepEqual(applyRelevanceGate([low], { floor: 0.4 }), []);
  const many = Array.from({ length: 5 }, () => high);
  assert.equal(applyRelevanceGate(many, { floor: 0.4, limit: 2 }).length, 2);
});

test("the program gate is on by default with code-level knobs (no env switch)", () => {
  assert.equal(DEFAULT_RELEVANCE_FLOOR, 0.05);
  assert.equal(DEFAULT_RELEVANCE_MAX_CV, 0.002);
  assert.equal(DEFAULT_MODEL_FLOOR, 0.5);
});

test("queryScoreStats reports the per-query score-shape features", () => {
  const stats = queryScoreStats([lexical(10), lexical(0)]);
  assert.equal(stats.count, 2);
  assert.ok(stats.top1 > stats.top2);
  assert.ok(stats.gap > 0);
  assert.ok(stats.cv > 0 && stats.sd > 0);
});

test("queryScoreStats measures dispersion on the raw scale by default", () => {
  // The bounded hybrid compression squeezes dispersion; the same pair is much
  // flatter on the bounded scale than on the raw scale.
  const pair = [lexical(100), lexical(50)];
  const raw = queryScoreStats(pair, undefined, "raw");
  const bounded = queryScoreStats(pair, undefined, "bounded");
  assert.ok(raw.cv > bounded.cv * 3, `raw cv ${raw.cv} should dominate bounded ${bounded.cv}`);
});

test("applyRelevanceGate abstains on a flat list when maxCv is set", () => {
  const flat = [lexical(10), lexical(10), lexical(10), lexical(10)];
  assert.deepEqual(applyRelevanceGate(flat, { floor: 0, maxCv: 0.01 }), []);
  const peaked = [lexical(20), lexical(1)];
  assert.equal(applyRelevanceGate(peaked, { floor: 0, maxCv: 0.01 }).length, 2);
  // Below MIN_CV_COUNT the flatness estimate is meaningless, so it never abstains.
  assert.equal(applyRelevanceGate([lexical(10), lexical(10)], { floor: 0, maxCv: 0.01 }).length, 2);
});

test("applyRelevanceGate honours the per-query relative floor (minZ)", () => {
  const kept = applyRelevanceGate([lexical(10), lexical(0)], { floor: 0, minZ: 0 });
  assert.deepEqual(kept, [lexical(10)]);
});
