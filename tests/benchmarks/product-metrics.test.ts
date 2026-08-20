import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateMatchedProductMetrics,
  matchedProductMetricsFromArtifact,
  type MatchedProductRow,
} from "../../evals/benchmarks/product-metrics.ts";

function row(
  id: string,
  mode: string,
  overrides: Partial<MatchedProductRow> = {},
): MatchedProductRow {
  return {
    id,
    repeat: 0,
    mode,
    rowScore: {
      taskScore: 1,
      taskSuccess: true,
      evidence: { kind: "id", any: 1, all: 1, recall: 1 },
    },
    toolRounds: mode === "baseline" ? 1 : 2,
    tokenUsage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
    durationMs: mode === "baseline" ? 500 : 600,
    controllerActuation:
      mode === "candidate"
        ? {
            attempted: 1,
            changed: 1,
            actions: { allocate: 0, fold: 0, rerank: 1 },
            maxTrainingSteps: 3,
          }
        : null,
    ...overrides,
  };
}

test("emits typed gate metrics only for complete causal arm pairs", () => {
  const result = aggregateMatchedProductMetrics(
    [row("a", "baseline"), row("a", "candidate"), row("b", "baseline"), row("b", "candidate")],
    { baselineMode: "baseline", candidateMode: "candidate" },
  );
  assert.deepEqual(result.blockers, []);
  assert.equal(result.pairedCases, 2);
  assert.deepEqual(result.metrics, {
    cases: 2,
    baseline: {
      taskSuccessRate: 1,
      evidenceSufficiencyRate: 1,
      meanToolRounds: 1,
      meanTokens: 120,
      meanEndToEndLatencyMs: 500,
    },
    learned: {
      taskSuccessRate: 1,
      evidenceSufficiencyRate: 1,
      meanToolRounds: 2,
      meanTokens: 120,
      meanEndToEndLatencyMs: 600,
    },
  });
});

test("fails closed when the candidate is observational or labels are incomplete", () => {
  const result = aggregateMatchedProductMetrics(
    [
      row("a", "baseline"),
      row("a", "candidate", {
        rowScore: { taskScore: 0.5, taskSuccess: null, evidence: null },
        controllerActuation: null,
      }),
    ],
    { baselineMode: "baseline", candidateMode: "candidate" },
  );
  assert.equal(result.metrics, null);
  assert.deepEqual(
    result.blockers.map((blocker) => blocker.code),
    ["candidate_does_not_affect_ranking", "missing_binary_task_success", "no_complete_pairs"],
  );
});

test("does not silently average an incomplete matched run", () => {
  const result = aggregateMatchedProductMetrics(
    [row("a", "baseline"), row("a", "candidate"), row("b", "baseline")],
    { baselineMode: "baseline", candidateMode: "candidate" },
  );
  assert.equal(result.pairedCases, 1);
  assert.equal(result.metrics, null);
  assert.deepEqual(result.blockers, [{ code: "missing_arm_pair", count: 1 }]);
});

test("rejects a contaminated baseline even when the candidate actuates", () => {
  const contaminated = row("a", "baseline", {
    controllerActuation: {
      attempted: 1,
      changed: 1,
      actions: { allocate: 1, fold: 0, rerank: 0 },
      maxTrainingSteps: 3,
    },
  });
  const result = aggregateMatchedProductMetrics([contaminated, row("a", "candidate")], {
    baselineMode: "baseline",
    candidateMode: "candidate",
  });
  assert.equal(result.metrics, null);
  assert.deepEqual(result.blockers, [{ code: "baseline_controller_actuation_detected", count: 1 }]);
});

test("extracts only complete gate-safe metrics from an official score artifact", () => {
  const metrics = {
    cases: 3,
    baseline: {
      taskSuccessRate: 0.5,
      evidenceSufficiencyRate: 0.5,
      meanToolRounds: 1,
      meanTokens: 100,
      meanEndToEndLatencyMs: 200,
    },
    learned: {
      taskSuccessRate: 0.6,
      evidenceSufficiencyRate: 0.7,
      meanToolRounds: 1.2,
      meanTokens: 110,
      meanEndToEndLatencyMs: 220,
    },
  };
  assert.deepEqual(matchedProductMetricsFromArtifact({ matchedProduct: { metrics } }), metrics);
  assert.equal(
    matchedProductMetricsFromArtifact({ matchedProduct: { metrics: { ...metrics, learned: {} } } }),
    null,
  );
  assert.equal(matchedProductMetricsFromArtifact({ matchedProduct: { metrics: null } }), null);
});
