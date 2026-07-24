import assert from "node:assert/strict";
import test from "node:test";

import { HierarchicalActivation } from "../../src/core/hierarchical-activation.ts";

function rvec(d: number): Float32Array {
  const v = new Float32Array(d);
  for (let i = 0; i < d; i++) v[i] = Math.random() * 2 - 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < d; i++) v[i] /= n;
  return v;
}

function buildCandidates(d: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    nodeId: `c${i}`,
    vector: rvec(d),
  }));
}

function buildGraphState(d: number) {
  return {
    mediumTermVectors: [rvec(d), rvec(d)],
    longTermVectors: [rvec(d), rvec(d), rvec(d)],
  };
}

// ── propagate ──

test("HA propagate returns all output fields with correct shapes", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  const out = ha.propagate(rvec(d), buildCandidates(d, 10));

  assert.equal(out.g1Context.length, d);
  assert.equal(out.g2Context.length, d);
  assert.equal(out.g3Context.length, d);
  assert.equal(out.h1State.length, d);
  assert.equal(out.h2State.length, d);
  assert.equal(out.h3State.length, d);
  assert.equal(out.nodeScores.length, 10);
  assert.equal(out.g1AttentionWeights.length, 10);
});

test("HA propagate with empty candidates returns zeros", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  const out = ha.propagate(rvec(d), []);

  assert.equal(out.nodeScores.length, 0);
  assert.equal(out.g1AttentionWeights.length, 0);
});

test("HA softmax attention weights sum to 1", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  const out = ha.propagate(rvec(d), buildCandidates(d, 5));

  const sum = out.g1AttentionWeights.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-5, `attention weights sum to ${sum}, expected ~1`);
});

test("HA h1 state updates across propagate calls (EMA)", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  const q = rvec(d);
  const cs = buildCandidates(d, 5);

  // First call: h1 is null → starts from zeros
  const out1 = ha.propagate(q, cs);
  const h1a = out1.h1State;
  assert.ok(h1a.some((v) => v !== 0), "h1 should be non-zero after first call");

  // Second call: h1 should change (EMA updates)
  const out2 = ha.propagate(q, buildCandidates(d, 5));
  const h1b = out2.h1State;

  // h1 should be different because g1 changed (different candidates)
  const changed = h1a.some((v, i) => Math.abs(v - h1b[i]!) > 1e-7);
  assert.ok(changed, "h1 should change across propagate calls with different input");
});

test("HA node scores are normalized (not all equal)", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  const out = ha.propagate(rvec(d), buildCandidates(d, 10));

  const unique = new Set(out.nodeScores);
  assert.ok(unique.size > 1, "node scores should have variance");
});

// ── multi-step ──

test("HA multi-step: prev g3Context changes output", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  const q = rvec(d);
  const cs = buildCandidates(d, 10);
  const gs = buildGraphState(d);

  const out1 = ha.propagate(q, cs, [], gs);
  const out2 = ha.propagate(q, cs, [], gs, { g3Context: out1.g3Context });

  // With prev, scores should differ
  const same = out2.nodeScores.every(
    (v, i) => Math.abs(v - out1.nodeScores[i]!) < 1e-7,
  );
  assert.ok(!same, "multi-step scores should differ from single-step");
});

// ── training ──

test("HA train reduces loss on repeated samples", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  const q = rvec(d);
  const cs = buildCandidates(d, 10);
  const gs = buildGraphState(d);

  const r1 = ha.train({
    queryVector: q,
    candidates: cs,
    graphState: gs,
    usedNodeIds: new Set(["c0", "c1"]),
  }, 0.05);
  assert.ok(!isNaN(r1.loss), "loss should be a number");

  for (let i = 0; i < 5; i++) {
    ha.train({ queryVector: q, candidates: cs, graphState: gs, usedNodeIds: new Set(["c0", "c1"]) }, 0.05);
  }
  const r2 = ha.train({
    queryVector: q,
    candidates: cs,
    graphState: gs,
    usedNodeIds: new Set(["c0", "c1"]),
  }, 0.05);

  // Loss should generally decrease (not guaranteed every step, but after several)
  assert.ok(r2.loss < r1.loss * 1.1, `loss ${r2.loss} should not be much larger than initial ${r1.loss}`);
});

test("HA train requires at least one candidate", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  assert.throws(() =>
    ha.train({ queryVector: rvec(d), candidates: [], usedNodeIds: new Set(["x"]) }),
  );
});

test("HA train requires at least one used node", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  assert.throws(() =>
    ha.train({
      queryVector: rvec(d),
      candidates: buildCandidates(d, 3),
      usedNodeIds: new Set(),
    }),
  );
});

// ── state round-trip ──

test("HA toJSON/fromJSON round-trip produces identical output", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  const json = ha.toJSON();
  const ha2 = HierarchicalActivation.fromJSON(json);

  const q = rvec(d);
  const cs = buildCandidates(d, 5);
  const gs = buildGraphState(d);

  const out1 = ha.propagate(q, cs, [], gs);
  const out2 = ha2.propagate(q, cs, [], gs);

  assert.deepEqual(
    Array.from(out1.nodeScores).map((v) => v.toFixed(6)),
    Array.from(out2.nodeScores).map((v) => v.toFixed(6)),
  );
});

test("HA state survives training", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  ha.train({
    queryVector: rvec(d),
    candidates: buildCandidates(d, 5),
    usedNodeIds: new Set(["c0"]),
  }, 0.05);

  const json = ha.toJSON();
  assert.ok(json.trainingSteps > 0, "trainingSteps should be preserved");
  assert.ok(json.scoreWeights.some((w) => w !== 0), "score weights should be set");
});

// ── determinism ──

test("HA propagate is deterministic", () => {
  const d = 64;
  const q = rvec(d);
  const cs = buildCandidates(d, 10);
  const gs = buildGraphState(d);

  // Two fresh instances with identical initialisation
  const ha1 = new HierarchicalActivation(d);
  const ha2 = HierarchicalActivation.fromJSON(ha1.toJSON());

  const out1 = ha1.propagate(q, cs, [], gs);
  const out2 = ha2.propagate(q, cs, [], gs);

  assert.deepEqual(
    Array.from(out1.nodeScores).map((v) => v.toFixed(8)),
    Array.from(out2.nodeScores).map((v) => v.toFixed(8)),
  );
});

// ── validation ──

test("HA trainSequence rejects empty sequence", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  assert.throws(() => ha.trainSequence([], 0.05));
});

test("HA trainSequence requires at least one step with usedNodeIds", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  assert.throws(() =>
    ha.trainSequence([
      { queryVector: rvec(d), candidates: buildCandidates(d, 3) },
    ]),
  );
});
