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
  strength?: number;
  reason?: RecallCue["reason"];
  memoryType?: MemoryType;
  isDirect?: boolean;
}

function candidate(opts: CandidateOpts = {}): QppCandidate {
  return {
    strength: opts.strength ?? 0.5,
    reason: opts.reason ?? "lexical_match",
    memoryType: opts.memoryType ?? "fact",
    isDirect: opts.isDirect ?? true,
  };
}

function approx(actual: number, expected: number, eps = 1e-6): void {
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
  const components = computeQppComponents("recommend a hotel", [candidate({ memoryType: "fact" })]);
  approx(components.intentCoverage, 0);
});

test("computeQppComponents intentCoverage is 1 when the expected type is present", () => {
  const components = computeQppComponents("recommend a hotel", [candidate({ memoryType: "preference" })]);
  approx(components.intentCoverage, 1);
});

test("computeQppComponents covers multiple matched families independently", () => {
  const components = computeQppComponents(
    "you said recommend",
    [candidate({ memoryType: "conversation_evidence" })],
  );
  // assistant covered, recommend not -> 1 of 2.
  approx(components.intentCoverage, 0.5);
});

test("top1 uses strength (hybridScore, bounded [0,1]) with gradation", () => {
  // strength is recomputed hybridScore (bounded [0,1], path-consistent), not the
  // path-inconsistent combinedScore. top1 = max(strength), clamped to [0,1].
  const strong = computeQppComponents("weather", [candidate({ strength: 0.894 })]);
  approx(strong.top1, 0.894);
  const medium = computeQppComponents("weather", [candidate({ strength: 0.4 })]);
  approx(medium.top1, 0.4);
  // Negative strength (shouldn't happen, but clamp guards) -> 0.
  const neg = computeQppComponents("weather", [candidate({ strength: -2 })]);
  approx(neg.top1, 0);
});

test("variance is 0 for a single direct candidate and bounded for a spread", () => {
  const single = computeQppComponents("weather", [candidate({ strength: 0.894 })]);
  assert.equal(single.variance, 0);
  // [0.894, 0] -> stdev ~0.447 -> *2 ~0.894 (clear winner).
  const spread = computeQppComponents("weather", [
    candidate({ strength: 0.894 }),
    candidate({ strength: 0 }),
  ]);
  approx(spread.variance, 0.894);
  // [0.5, 0.5] -> equal -> 0 (flat, no clear winner).
  const flat = computeQppComponents("weather", [
    candidate({ strength: 0.5 }),
    candidate({ strength: 0.5 }),
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
  // Direct strength 0.5, expansion strength 0.894 -> top1 must be 0.5 (expansion ignored).
  const components = computeQppComponents("weather", [
    candidate({ strength: 0.5, isDirect: true }),
    candidate({ strength: 0.894, isDirect: false }),
  ]);
  approx(components.top1, 0.5);
  assert.equal(components.directCount, 1);
});

test("composeQpp is the learned-weight sum C = Top1 + tauV*var + wIc*ic + wRh*rh", () => {
  const components = computeQppComponents("recommend a hotel", [
    candidate({ strength: 0.894, memoryType: "preference" }),
    candidate({ strength: 0.4, memoryType: "preference" }),
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
  const candidates = [candidate({ strength: 0.894, memoryType: "fact" })];
  const qpp = computeQpp("weather", candidates, DEFAULT_QPP_WEIGHTS);
  approx(qpp, composeQpp(computeQppComponents("weather", candidates), DEFAULT_QPP_WEIGHTS));
});

test("shouldTriggerSecondPass fires guardrail_empty when no candidates", () => {
  const decision = shouldTriggerSecondPass("weather", []);
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "guardrail_empty");
  assert.equal(decision.threshold, DEFAULT_QPP_THRESHOLD);
});

test("shouldTriggerSecondPass fires guardrail_all_fallback when every direct match is hybrid_match", () => {
  // All direct are hybrid_match -> reasonHealth=0 -> triggers; the guardrail is a
  // defensive invariant against bad learned weights.
  const decision = shouldTriggerSecondPass("weather", [
    candidate({ strength: 0, reason: "hybrid_match" }),
    candidate({ strength: 0, reason: "hybrid_match" }),
  ]);
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "guardrail_all_fallback");
});

test("shouldTriggerSecondPass fires guardrail_low_top1 when the best match is too weak", () => {
  // strength 0.1 < QPP_TOP1_FLOOR (0.2) -> triggers.
  const decision = shouldTriggerSecondPass("weather", [
    candidate({ strength: 0.1, reason: "lexical_match" }),
  ]);
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "guardrail_low_top1");
  assert.ok(decision.components.top1 < 0.2);
});

test("shouldTriggerSecondPass fires below_threshold when Top1 clears the floor but C is low", () => {
  // strength 0.22 (>= 0.2 floor). "recommend" matches intent but no preference
  // memory -> intentCoverage=0. reasonHealth=1. C = 0.22 + 0 + 0 + 0.2 = 0.42 < 0.45.
  const decision = shouldTriggerSecondPass("recommend a hotel", [
    candidate({ strength: 0.22, reason: "lexical_match", memoryType: "fact" }),
  ]);
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "below_threshold");
  approx(decision.qpp, 0.22 + 0.2);
});

test("shouldTriggerSecondPass does not trigger when recall is strong", () => {
  // strength 0.894, ic=0.5, rh=1 -> C = 0.894 + 0.15 + 0.2 = 1.244 >= 0.45.
  const decision = shouldTriggerSecondPass("weather", [
    candidate({ strength: 0.894, reason: "lexical_match" }),
  ]);
  assert.equal(decision.trigger, false);
  assert.equal(decision.reason, "ok");
  approx(decision.qpp, 0.894 + 0.3 * 0.5 + 0.2);
});

test("qppCandidates recomputes strength as hybridScore from component scores", () => {
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
  // hybridScore(0, 0.8, 0) = 0.5*0 + 0.35*0.8 + 0.15*0 = 0.28.
  approx(candidate?.strength ?? -1, 0.28);
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
      ["ok", "below_threshold", "guardrail_empty", "guardrail_all_fallback", "guardrail_low_top1"].includes(
        trace.qpp!.reason,
      ),
    );
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

test("searchContextWithSecondPass: secondPass off returns the normal result", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-qpp-2p-off-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    store.remember({ statement: "user prefers a window seat", nodeName: "Seat", memoryType: "preference" });
    const normal = store.searchContext("window seat");
    const adaptive = store.searchContextWithSecondPass("window seat");
    assert.equal(adaptive.activeGraph!.budget.maxEvidence, normal.activeGraph!.budget.maxEvidence);
    assert.equal(adaptive.results.length, normal.results.length);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("searchContextWithSecondPass: no trigger returns first pass (normal budget)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-qpp-2p-notrig-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    store.remember({ statement: "user prefers a window seat", nodeName: "Seat", memoryType: "preference" });
    // strong lexical match -> top1 high -> qpp ok -> no trigger.
    const result = store.searchContextWithSecondPass("window seat", { secondPass: true });
    assert.equal(result.activeGraph!.qpp?.trigger, false);
    assert.equal(result.activeGraph!.budget.maxEvidence, 8);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("searchContextWithSecondPass: trigger runs expanded pass (doubled budget)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-qpp-2p-trig-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    store.remember({ statement: "user prefers a window seat", nodeName: "Seat", memoryType: "preference" });
    // no real match -> qpp triggers (guardrail_low_top1 or guardrail_empty) -> expanded pass runs.
    const result = store.searchContextWithSecondPass("zzz-no-such-thing", { secondPass: true });
    assert.equal(result.activeGraph!.qpp?.trigger, true);
    assert.equal(result.activeGraph!.budget.maxEvidence, 16);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("searchContextWithSecondPass: qppThreshold forces trigger on a strong match", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-qpp-2p-tau-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    store.remember({ statement: "user prefers a window seat", nodeName: "Seat", memoryType: "preference" });
    // strong match -> default τ=0.45 does NOT trigger.
    const normal = store.searchContextWithSecondPass("window seat", { secondPass: true });
    assert.equal(normal.activeGraph!.qpp?.trigger, false);
    // raised τ forces below_threshold -> expanded pass runs (budget doubled).
    const forced = store.searchContextWithSecondPass("window seat", {
      secondPass: true,
      qppThreshold: 2.0,
    });
    assert.equal(forced.activeGraph!.qpp?.trigger, true);
    assert.equal(forced.activeGraph!.budget.maxEvidence, 16);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("searchContextWithSecondPass: truncated first pass re-selects from pool (no re-search)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-qpp-2p-trunc-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    // Four memories sharing "running" so a lexical query matches all; small budget
    // truncates the first pass to 2.
    for (const m of [
      "I like running in the morning",
      "I like running in the evening",
      "I like running fast on trails",
      "I like running slow in the park",
    ]) {
      store.remember({ statement: m, nodeName: "Run", memoryType: "fact" });
    }
    const small = { maxEvidence: 2, maxNodes: 2, maxTokens: 8_000 };
    // Normal: only 2 of 4 surfaced (truncated).
    const normal = store.searchContext("running", { limit: 2, activeGraphBudget: small });
    assert.equal(normal.results.length, 2);
    // secondPass: truncation triggers re-select from the SAME pool with expanded
    // budget (4) — surfaces all 4. No re-search (one retrieval).
    const adaptive = store.searchContextWithSecondPass("running", {
      limit: 2,
      activeGraphBudget: small,
    });
    assert.equal(adaptive.results.length, 4);
    assert.equal(adaptive.activeGraph!.budget.maxEvidence, 4);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
