import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { queryIntentFamilies } from "../../src/core/store/search-ranking.ts";
import type { MemoryType, QppCandidate, RecallCue } from "../../src/core/types.ts";
import { NmgStore } from "../../src/core/store.ts";
import {
  composeQpp,
  computeQpp,
  computeQppComponents,
  DEFAULT_QPP_THRESHOLD,
  DEFAULT_QPP_WEIGHTS,
  qppCandidates,
  shouldTriggerSecondPass,
} from "../../src/core/qpp.ts";

interface CandidateOpts {
  usefulness?: number;
  reason?: RecallCue["reason"];
  memoryType?: MemoryType;
  isDirect?: boolean;
}

function candidate(opts: CandidateOpts = {}): QppCandidate {
  return {
    usefulness: opts.usefulness ?? 0.5,
    reason: opts.reason ?? "lexical_match",
    memoryType: opts.memoryType ?? "fact",
    isDirect: opts.isDirect ?? true,
  };
}

function approx(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${expected}, got ${actual}`,
  );
}

test("queryIntentFamilies detects the three intent families (en + zh)", () => {
  assert.deepEqual(queryIntentFamilies("recommend a hotel").map((f) => f.name), ["recommend"]);
  assert.deepEqual(queryIntentFamilies("how many users").map((f) => f.name), ["list_count"]);
  assert.deepEqual(queryIntentFamilies("what did the assistant say").map((f) => f.name), ["assistant"]);
  assert.deepEqual(queryIntentFamilies("推荐一家酒店").map((f) => f.name), ["recommend"]);
  assert.deepEqual(queryIntentFamilies("what is the weather").map((f) => f.name), []);
});

test("computeQppComponents returns zeros and neutral intentCoverage for empty candidates", () => {
  const components = computeQppComponents("weather", []);
  assert.equal(components.totalCount, 0);
  assert.equal(components.directCount, 0);
  assert.equal(components.top1, 0);
  assert.equal(components.variance, 0);
  assert.equal(components.reasonHealth, 0);
  // No intent family matched -> neutral 0.5 (do not penalise single-hop facts).
  approx(components.intentCoverage, 0.5);
});

test("computeQppComponents intentCoverage is 0 when an intent family matches but the type is absent", () => {
  // "recommend" expects preference/constraint; only a fact returned -> miss.
  const components = computeQppComponents("recommend a hotel", [candidate({ memoryType: "fact" })]);
  approx(components.intentCoverage, 0);
});

test("computeQppComponents intentCoverage is 1 when the expected type is present", () => {
  const components = computeQppComponents("recommend a hotel", [candidate({ memoryType: "preference" })]);
  approx(components.intentCoverage, 1);
});

test("computeQppComponents covers multiple matched families independently", () => {
  // "you said recommend" matches both assistant and recommend.
  const components = computeQppComponents(
    "you said recommend",
    [candidate({ memoryType: "conversation_evidence" })],
  );
  // assistant covered, recommend not -> 1 of 2.
  approx(components.intentCoverage, 0.5);
});

test("top1 clamps usefulness above 1 to 1.0 (bonus saturation)", () => {
  const components = computeQppComponents("weather", [candidate({ usefulness: 1.3 })]);
  approx(components.top1, 1);
});

test("variance is 0 for a single direct candidate and bounded for a spread", () => {
  const single = computeQppComponents("weather", [candidate({ usefulness: 0.8 })]);
  assert.equal(single.variance, 0);
  // [1, 0] -> stdev 0.5 -> *2 = 1.0 (max variance).
  const spread = computeQppComponents("weather", [
    candidate({ usefulness: 1 }),
    candidate({ usefulness: 0 }),
  ]);
  approx(spread.variance, 1);
  // [0.5, 0.5] -> stdev 0 -> 0.
  const flat = computeQppComponents("weather", [
    candidate({ usefulness: 0.5 }),
    candidate({ usefulness: 0.5 }),
  ]);
  approx(flat.variance, 0);
});

test("reasonHealth counts only direct candidates and excludes hybrid_match", () => {
  const components = computeQppComponents("weather", [
    candidate({ reason: "lexical_match", isDirect: true }),
    candidate({ reason: "hybrid_match", isDirect: true }),
    // graph_expansion hybrid_match must NOT pull the ratio down.
    candidate({ reason: "hybrid_match", isDirect: false }),
  ]);
  approx(components.reasonHealth, 0.5);
  assert.equal(components.directCount, 2);
  assert.equal(components.totalCount, 3);
});

test("score-based signals ignore graph_expansion candidates", () => {
  // Direct usefulness 0.5, expansion usefulness 1.0 -> top1 must be 0.5.
  const components = computeQppComponents("weather", [
    candidate({ usefulness: 0.5, isDirect: true }),
    candidate({ usefulness: 1, isDirect: false }),
  ]);
  approx(components.top1, 0.5);
  assert.equal(components.directCount, 1);
});

test("composeQpp is the learned-weight sum C = Top1 + tauV*var + wIc*ic + wRh*rh", () => {
  const components = computeQppComponents("recommend a hotel", [
    candidate({ usefulness: 0.8, memoryType: "preference" }),
    candidate({ usefulness: 0.4, memoryType: "preference" }),
  ]);
  const qpp = composeQpp(components, { tauV: 0.3, wIc: 0.3, wRh: 0.2 });
  const expected =
    components.top1 +
    0.3 * components.variance +
    0.3 * components.intentCoverage +
    0.2 * components.reasonHealth;
  approx(qpp, expected);
});

test("computeQpp matches composeQpp with the same weights", () => {
  const candidates = [candidate({ usefulness: 0.9, memoryType: "fact" })];
  const qpp = computeQpp("weather", candidates, DEFAULT_QPP_WEIGHTS);
  approx(qpp, composeQpp(computeQppComponents("weather", candidates), DEFAULT_QPP_WEIGHTS));
});

test("shouldTriggerSecondPass fires guardrail_empty when no candidates", () => {
  const decision = shouldTriggerSecondPass("weather", []);
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "guardrail_empty");
  assert.equal(decision.threshold, DEFAULT_QPP_THRESHOLD);
});

test("shouldTriggerSecondPass fires guardrail_all_fallback even when C is high", () => {
  // Two direct, both hybrid_match, max usefulness -> C would clear threshold,
  // but all-fallback means no real search signal matched -> must trigger.
  const decision = shouldTriggerSecondPass("weather", [
    candidate({ usefulness: 1, reason: "hybrid_match" }),
    candidate({ usefulness: 1, reason: "hybrid_match" }),
  ]);
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "guardrail_all_fallback");
  assert.ok(decision.qpp >= DEFAULT_QPP_THRESHOLD);
});

test("shouldTriggerSecondPass fires below_threshold when recall is weak", () => {
  const decision = shouldTriggerSecondPass("weather", [
    candidate({ usefulness: 0, reason: "lexical_match" }),
  ]);
  // top1=0, variance=0, ic=0.5 (no intent), rh=1 -> C = 0.3*0.5 + 0.2 = 0.35 < 0.45.
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "below_threshold");
  approx(decision.qpp, 0.35);
});

test("shouldTriggerSecondPass does not trigger when recall is strong", () => {
  const decision = shouldTriggerSecondPass("weather", [
    candidate({ usefulness: 1, reason: "lexical_match" }),
  ]);
  // top1=1, variance=0, ic=0.5, rh=1 -> C = 1 + 0.15 + 0.2 = 1.35 >= 0.45.
  assert.equal(decision.trigger, false);
  assert.equal(decision.reason, "ok");
  approx(decision.qpp, 1.35);
});

test("qppCandidates joins results and selections by memoryId and tags direct vs expansion", () => {
  const memoryId = "mem-1";
  const result = {
    memory: { id: memoryId, memoryType: "preference" },
  } as unknown as import("../../src/core/types.ts").MemorySearchResult;
  const selection = {
    memoryId,
    source: "direct",
    reason: "vector_match",
    scores: { usefulness: 0.77, lexical: 0, vector: 0.8, route: 0, combined: 0.8 },
  } as unknown as import("../../src/core/types.ts").ActiveGraphSelection;
  const [candidate] = qppCandidates([result], [selection]);
  assert.equal(candidate?.isDirect, true);
  assert.equal(candidate?.memoryType, "preference");
  assert.equal(candidate?.reason, "vector_match");
  approx(candidate?.usefulness ?? -1, 0.77);
});

test("searchContext records a shadow QPP decision on the trace (no behaviour change)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-qpp-shadow-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    store.remember({
      statement: "user prefers a window seat on flights",
      nodeName: "SeatPreference",
      memoryType: "preference",
    });
    const context = store.searchContext("recommend a seat", { limit: 8 });
    assert.ok(context.activeGraph);
    // Shadow: retrieval still returns results normally; QPP does not gate it.
    assert.ok(context.results.length > 0);
    const trace = store.retrievalTrace(context.activeGraph.id);
    assert.ok(trace);
    assert.ok(trace.qpp, "trace must carry a shadow QPP decision");
    assert.equal(typeof trace.qpp!.qpp, "number");
    assert.equal(trace.qpp!.threshold, DEFAULT_QPP_THRESHOLD);
    assert.equal(trace.qpp!.components.totalCount, context.activeGraph.selections.length);
    assert.ok(
      ["ok", "below_threshold", "guardrail_empty", "guardrail_all_fallback"].includes(
        trace.qpp!.reason,
      ),
    );
    // A recall that surfaced a preference should cover the recommend intent.
    if (context.results.some((result) => result.memory.memoryType === "preference")) {
      approx(trace.qpp!.components.intentCoverage, 1);
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a trace recorded without qpp reads back qpp undefined (backward compatible)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-qpp-legacy-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    store.remember({ statement: "a remembered detail", nodeName: "Detail" });
    const traceId = store.recordRetrievalTrace({
      query: "remembered detail",
      resultMemoryIds: [],
      resultNodeIds: [],
    });
    const trace = store.retrievalTrace(traceId);
    assert.ok(trace);
    assert.equal(trace.qpp, undefined);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
