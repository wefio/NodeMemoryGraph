import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateGraphMetrics,
  pickTier,
  type MetricNode,
} from "../../src/lab/backend-selection.ts";

// Mirrors the shapes of tools/batch-backend-bench.ts's two training forms.
function stackedNodes(d: number, b: number): MetricNode[] {
  // leaf inputs first (X [B,D], W [D,1], T [B,1]) then the compute chain
  return [
    { rows: b, columns: d, isMatmul: false, matmulInner: 0 },
    { rows: d, columns: 1, isMatmul: false, matmulInner: 0 },
    { rows: b, columns: 1, isMatmul: false, matmulInner: 0 },
    { rows: b, columns: 1, isMatmul: true, matmulInner: d },
    { rows: b, columns: 1, isMatmul: false, matmulInner: 0 },
    { rows: b, columns: 1, isMatmul: false, matmulInner: 0 },
    { rows: b, columns: 1, isMatmul: false, matmulInner: 0 },
    { rows: b, columns: 1, isMatmul: false, matmulInner: 0 },
    { rows: b, columns: 1, isMatmul: false, matmulInner: 0 },
    { rows: 1, columns: 1, isMatmul: false, matmulInner: 0 },
    { rows: 1, columns: 1, isMatmul: false, matmulInner: 0 },
  ];
}

function loopNodes(d: number, b: number): MetricNode[] {
  const nodes: MetricNode[] = [];
  for (let i = 0; i < b; i += 1) {
    nodes.push(
      { rows: d, columns: 1, isMatmul: false, matmulInner: 0 },
      { rows: 1, columns: 1, isMatmul: false, matmulInner: 0 },
      { rows: 1, columns: 1, isMatmul: false, matmulInner: 0 },
      { rows: 1, columns: 1, isMatmul: false, matmulInner: 0 },
      { rows: 1, columns: 1, isMatmul: false, matmulInner: 0 },
    );
  }
  nodes.push({ rows: 1, columns: 1, isMatmul: false, matmulInner: 0 });
  return nodes;
}

test("estimateGraphMetrics: bytes and matmul flops", () => {
  const m = estimateGraphMetrics(stackedNodes(128, 1024));
  assert.equal(m.nodeCount, 11);
  assert.equal(m.matmulFlops, 2 * 1024 * 128 * 1); // 2·B·D·1
  assert.ok(m.totalBytes > 1024 * 128 * 4); // the [B,D] matmul input alone
});

test("pickTier: reusable training loop → compiled-tape across the batch grid", () => {
  const context = { reusable: true, expectedRuns: 200 };
  for (const nodes of [stackedNodes(16, 1), stackedNodes(128, 1024), loopNodes(16, 1024)]) {
    const decision = pickTier(estimateGraphMetrics(nodes), context);
    assert.equal(decision.tier, "compiled-tape");
    assert.ok(decision.reason.length > 0);
  }
});

test("pickTier: single-shot or un-amortized → interpreter", () => {
  const metrics = estimateGraphMetrics(stackedNodes(16, 64));
  assert.equal(pickTier(metrics, { reusable: true, expectedRuns: 1 }).tier, "interpreter");
  assert.equal(pickTier(metrics, { reusable: false, expectedRuns: 100 }).tier, "interpreter");
  assert.match(pickTier(metrics, { reusable: true, expectedRuns: 1 }).reason, /not amortized/);
});

test("pickTier: large graphs still select an executable CPU tier", () => {
  const context = { reusable: true, expectedRuns: 200 };
  const big = estimateGraphMetrics([
    { rows: 1024, columns: 1024, isMatmul: true, matmulInner: 1024 },
  ]);
  const decision = pickTier(big, context);
  assert.equal(decision.tier, "compiled-tape");
  assert.doesNotMatch(decision.reason, /GPU|WGSL/iu);
});
