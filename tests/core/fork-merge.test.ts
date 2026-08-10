import assert from "node:assert/strict";
import test from "node:test";
import { HierarchicalActivation } from "../../src/core/hierarchical-activation.ts";
import { ForkMerge } from "../../src/lab/fork-merge.ts";
import type {
  HierarchicalActivationState,
  NodeActivationInput,
} from "../../src/core/hierarchical-activation.ts";

// ── helpers ──

function rvec(d: number): Float32Array {
  const v = new Float32Array(d);
  for (let i = 0; i < d; i++) v[i] = Math.random() * 2 - 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < d; i++) v[i] /= n;
  return v;
}

function cands(d: number, n: number): NodeActivationInput[] {
  return Array.from({ length: n }, (_, i) => ({
    nodeId: `c${i}`,
    vector: rvec(d),
  }));
}

const D = 32;

// ── forward ──

test("ForkMerge forward: returns left/right scores and divergence", () => {
  const left = new HierarchicalActivation(D);
  const right = new HierarchicalActivation(D);
  const fm = new ForkMerge(left, right);

  const q = rvec(D);
  const cs = cands(D, 10);

  const result = fm.forward(q, cs);

  assert.equal(result.leftScores.length, 10);
  assert.equal(result.rightScores.length, 10);
  assert.ok(result.divergence >= 0 && result.divergence <= 2);
  assert.ok(
    result.leftScores.every((v, i) => Math.abs(v - result.rightScores[i]!) < 1e-9),
    "identical params produce identical scores",
  );
});

test("ForkMerge forward: divergence stays in range under float32 rounding", () => {
  // Regression: divergence is computed as 1 - cos over float32 score tensors.
  // Identical branch parameters should give cos == 1 exactly, but float32
  // rounding pushed cos slightly above 1.0 in ~20% of random forwards, leaking a
  // small negative divergence. Many trials because the flake is data-dependent.
  for (let trial = 0; trial < 300; trial++) {
    const fm = new ForkMerge(
      new HierarchicalActivation(D),
      new HierarchicalActivation(D),
    );
    const { divergence } = fm.forward(rvec(D), cands(D, 10));
    assert.ok(
      divergence >= 0 && divergence <= 2,
      `divergence out of range on trial ${trial}: ${divergence}`,
    );
  }
});

test("ForkMerge forward: empty candidates returns empty", () => {
  const left = new HierarchicalActivation(D);
  const right = new HierarchicalActivation(D);
  const fm = new ForkMerge(left, right);

  const result = fm.forward(rvec(D), []);
  assert.equal(result.leftScores.length, 0);
  assert.equal(result.rightScores.length, 0);
  assert.equal(result.divergence, 0);
});

test("ForkMerge forward: identical HAs produce near-zero divergence", () => {
  const ha = new HierarchicalActivation(D);
  const clone = HierarchicalActivation.fromJSON(ha.toJSON());
  const fm = new ForkMerge(ha, clone);

  const q = rvec(D);
  const cs = cands(D, 8);

  const result = fm.forward(q, cs);
  // Same params → same scores → divergence ≈ 0
  assert.ok(result.divergence < 1e-5);
});

test("ForkMerge forward: different temperatures produce higher divergence", () => {
  const base = new HierarchicalActivation(D);

  const jHot = base.toJSON();
  jHot.temperature = 0.2;
  const hot = HierarchicalActivation.fromJSON(jHot);

  const jCold = base.toJSON();
  jCold.temperature = 5.0;
  const cold = HierarchicalActivation.fromJSON(jCold);

  const fm = new ForkMerge(hot, cold);
  const result = fm.forward(rvec(D), cands(D, 8));

  // Different temps → different softmax → non-zero divergence
  assert.ok(result.divergence > 1e-6);
});

// ── train contrastive ──

test("ForkMerge trainContrastive: divergence grows", () => {
  const base = new HierarchicalActivation(D);

  const j1 = base.toJSON();
  j1.temperature = 1.0;
  const ha1 = HierarchicalActivation.fromJSON(j1);

  const j2 = base.toJSON();
  j2.temperature = 1.0;
  const ha2 = HierarchicalActivation.fromJSON(j2);

  const fm = new ForkMerge(ha1, ha2, { divergenceWeight: 1.0 });

  const q = rvec(D);
  const cs = cands(D, 8);
  const before = fm.forward(q, cs).divergence;

  for (let i = 0; i < 5; i++) {
    fm.trainContrastive({ query: q, candidates: cs }, 0.05);
  }

  const after = fm.forward(q, cs).divergence;
  assert.ok(after >= before, `divergence should grow: ${before} → ${after}`);
});

test("ForkMerge trainContrastive: loss decreases over repeated steps", () => {
  const ha1 = new HierarchicalActivation(D);
  const ha2 = new HierarchicalActivation(D);
  const fm = new ForkMerge(ha1, ha2);

  const q = rvec(D);
  const cs = cands(D, 8);

  const losses: number[] = [];
  for (let i = 0; i < 10; i++) {
    const { loss } = fm.trainContrastive({ query: q, candidates: cs }, 0.05);
    losses.push(loss);
  }

  // First half avg should be higher than last half (loss = cos sim, we minimise it)
  const firstHalf = losses.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const lastHalf = losses.slice(5).reduce((a, b) => a + b, 0) / 5;
  assert.ok(lastHalf <= firstHalf, "contrastive loss should decrease");
});

// ── train align ──

test("ForkMerge trainAlign: divergence shrinks", () => {
  const base = new HierarchicalActivation(D);

  const j1 = base.toJSON();
  j1.temperature = 1.0;
  const ha1 = HierarchicalActivation.fromJSON(j1);

  const j2 = base.toJSON();
  j2.temperature = 3.0; // start different
  const ha2 = HierarchicalActivation.fromJSON(j2);

  const fm = new ForkMerge(ha1, ha2, { divergenceWeight: 1.0 });

  const q = rvec(D);
  const cs = cands(D, 8);
  const before = fm.forward(q, cs).divergence;

  assert.ok(before > 1e-6, "should start with non-zero divergence");

  for (let i = 0; i < 10; i++) {
    fm.trainAlign({ query: q, candidates: cs }, 0.05);
  }

  const after = fm.forward(q, cs).divergence;
  assert.ok(after <= before, `divergence should shrink: ${before} → ${after}`);
});

test("ForkMerge trainAlign: loss decreases", () => {
  const j1 = new HierarchicalActivation(D).toJSON();
  j1.temperature = 0.5;
  const ha1 = HierarchicalActivation.fromJSON(j1);

  const j2 = new HierarchicalActivation(D).toJSON();
  j2.temperature = 4.0;
  const ha2 = HierarchicalActivation.fromJSON(j2);

  const fm = new ForkMerge(ha1, ha2);

  const q = rvec(D);
  const cs = cands(D, 8);

  const losses: number[] = [];
  for (let i = 0; i < 10; i++) {
    const { loss } = fm.trainAlign({ query: q, candidates: cs }, 0.05);
    losses.push(loss);
  }

  const firstHalf = losses.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const lastHalf = losses.slice(5).reduce((a, b) => a + b, 0) / 5;
  assert.ok(lastHalf <= firstHalf, "alignment loss should decrease");
});

// ── serialisation ──

test("ForkMerge toJSON/fromJSON round-trip", () => {
  const left = new HierarchicalActivation(D);
  const right = new HierarchicalActivation(D);
  const fm = new ForkMerge(left, right, { divergenceWeight: 0.5 });

  const json = fm.toJSON() as {
    left: HierarchicalActivationState;
    right: HierarchicalActivationState;
    config: { divergenceWeight: number };
  };

  assert.equal(json.config.divergenceWeight, 0.5);
  assert.equal(json.left.dimensions, D);
  assert.equal(json.right.dimensions, D);

  // Reconstruct
  const left2 = HierarchicalActivation.fromJSON(json.left);
  const right2 = HierarchicalActivation.fromJSON(json.right);

  assert.equal(left2.dimensions, D);
  assert.equal(right2.dimensions, D);
});

// ── dimension mismatch ──

test("ForkMerge rejects dimension mismatch", () => {
  const ha32 = new HierarchicalActivation(32);
  const ha64 = new HierarchicalActivation(64);
  assert.throws(() => new ForkMerge(ha32, ha64), /dimension mismatch/);
});
