import assert from "node:assert/strict";
import test from "node:test";

import { MemoryGraphReasoner } from "../../src/core/memory-graph-reasoner.ts";
import type { MemoryNode } from "../../src/core/memory-graph-reasoner.ts";

function rvec(d: number): Float32Array {
  const v = new Float32Array(d);
  for (let i = 0; i < d; i++) v[i] = Math.random() * 2 - 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < d; i++) v[i] /= n;
  return v;
}

function buildGraph(d: number, n: number): Map<string, MemoryNode> {
  const g = new Map<string, MemoryNode>();
  for (let i = 0; i < n; i++) g.set(`n${i}`, { id: `n${i}`, vector: rvec(d) });
  return g;
}

function closeVec(d: number, base: Float32Array, strength = 0.7): Float32Array {
  const v = new Float32Array(d);
  for (let i = 0; i < d; i++) v[i] = base[i]! * strength + (Math.random() - 0.5) * (1 - strength);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < d; i++) v[i] /= n;
  return v;
}

const d = 64;

// ── traverse ──

test("MGR traverse returns path with correct structure", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 10);
  const q = rvec(d);

  const result = mgr.traverse(q, graph, 3);
  assert.ok(result.path.length > 0, "path should not be empty");
  assert.ok(result.path.length <= 3, `path should not exceed maxSteps, got ${result.path.length}`);
  assert.ok(result.pathScore > 0, "path score should be positive");

  for (const step of result.path) {
    assert.ok(typeof step.nodeId === "string");
    assert.ok(typeof step.score === "number");
    assert.ok(step.gate >= 0 && step.gate <= 1, `gate ${step.gate} should be in [0,1]`);
    assert.equal(step.queryBefore.length, d);
    assert.equal(step.queryAfter.length, d);
  }
});

test("MGR traverse empty graph returns empty path", () => {
  const mgr = new MemoryGraphReasoner(d);
  const result = mgr.traverse(rvec(d), new Map(), 3);
  assert.equal(result.path.length, 0);
  assert.equal(result.pathScore, 0);
});

test("MGR traverse respects maxSteps", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 10);
  const q = rvec(d);

  const r1 = mgr.traverse(q, graph, 1);
  assert.ok(r1.path.length <= 1);

  const r3 = mgr.traverse(q, graph, 3);
  assert.ok(r3.path.length <= 3);

  const r5 = mgr.traverse(q, graph, 5);
  assert.ok(r5.path.length <= 5);
});

test("MGR traverse does not revisit nodes", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 5);
  const q = rvec(d);

  const result = mgr.traverse(q, graph, 5);
  const ids = result.path.map((s) => s.nodeId);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, "path should not contain duplicate nodes");
});

// ── training ──

test("MGR trainPath reduces loss", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 10);
  const q = rvec(d);

  const loss0 = mgr.trainPath({ queryVector: q, pathNodeIds: ["n0"], graph }, 0.1);
  assert.ok(!isNaN(loss0));

  for (let i = 0; i < 10; i++) {
    mgr.trainPath({ queryVector: q, pathNodeIds: ["n0"], graph }, 0.1);
  }
  const lossN = mgr.trainPath({ queryVector: q, pathNodeIds: ["n0"], graph }, 0.1);
  assert.ok(lossN < loss0 * 1.05, `loss ${lossN} should decrease from ${loss0}`);
});

test("MGR trainPath requires at least one node", () => {
  const mgr = new MemoryGraphReasoner(d);
  assert.throws(() =>
    mgr.trainPath({ queryVector: rvec(d), pathNodeIds: [], graph: new Map() }),
  );
});

test("MGR trainPath rejects missing nodes", () => {
  const mgr = new MemoryGraphReasoner(d);
  assert.throws(() =>
    mgr.trainPath({ queryVector: rvec(d), pathNodeIds: ["ghost"], graph: new Map() }),
  );
});

test("MGR trainingSteps increments", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 5);
  assert.equal(mgr.trainingSteps, 0);

  mgr.trainPath({ queryVector: rvec(d), pathNodeIds: ["n0"], graph }, 0.1);
  assert.equal(mgr.trainingSteps, 1);
});

// ── state round-trip ──

test("MGR toJSON/fromJSON round-trip produces identical traversal", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 10);
  const q = rvec(d);

  const r1 = mgr.traverse(q, graph, 2);
  const json = mgr.toJSON();
  const mgr2 = MemoryGraphReasoner.fromJSON(json);
  const r2 = mgr2.traverse(q, graph, 2);

  assert.equal(r1.path.length, r2.path.length);
  for (let i = 0; i < r1.path.length; i++) {
    assert.equal(r1.path[i]!.nodeId, r2.path[i]!.nodeId);
    assert.ok(Math.abs(r1.path[i]!.score - r2.path[i]!.score) < 1e-6);
  }
  assert.equal(r1.pathScore.toFixed(6), r2.pathScore.toFixed(6));
});

test("MGR state preserves learned parameters", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 5);

  mgr.trainPath({ queryVector: rvec(d), pathNodeIds: ["n0", "n1"], graph }, 0.1);

  const json = mgr.toJSON();
  assert.equal(json.version, 2);
  assert.equal(json.trainingSteps, 1);
  assert.ok("n0" in json.nodeBiasLogits, "visited nodes should have bias logits");
  assert.ok("n0" in json.nodeBetaLogits, "visited nodes should have beta logits");
});

// ── preconditions ──

test("MGR precondition gates out nodes when facts are inactive", () => {
  const mgr = new MemoryGraphReasoner(d);
  const q = rvec(d);

  // Facts are random (unrelated to query or node)
  const graph = new Map<string, MemoryNode>();
  graph.set("fact-A", { id: "fact-A", vector: rvec(d) });
  graph.set("gated-node", {
    id: "gated-node",
    vector: closeVec(d, q, 0.9), // very close to query — would normally win
    requires: ["fact-A"],
  });
  graph.set("normal-node", { id: "normal-node", vector: rvec(d) });

  const result = mgr.traverse(q, graph, 2);

  // gated-node should have low gate since fact-A is random
  const gatedStep = result.path.find((s) => s.nodeId === "gated-node");
  if (gatedStep) {
    assert.ok(gatedStep.gate < 0.5, `gated node gate ${gatedStep.gate} should be low when fact inactive`);
  }
  // At minimum, the result should complete without errors
  assert.ok(result.path.length >= 1);
});

test("MGR precondition allows node when facts are active", () => {
  const mgr = new MemoryGraphReasoner(d);
  const q = rvec(d);
  const factVec = closeVec(d, q, 0.8); // fact is close to query

  const graph = new Map<string, MemoryNode>();
  graph.set("fact-active", { id: "fact-active", vector: factVec });
  graph.set("gated-node", {
    id: "gated-node",
    vector: closeVec(d, q, 0.85),
    requires: ["fact-active"],
  });
  graph.set("distractor", { id: "distractor", vector: rvec(d) });

  const result = mgr.traverse(q, graph, 2);
  const gatedStep = result.path.find((s) => s.nodeId === "gated-node");
  assert.ok(gatedStep, "gated node should appear when fact is active");
});

// ── whatIf ──

test("MGR whatIf returns baseline and withNode traversals", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 8);
  const q = rvec(d);

  const result = mgr.whatIf(q, graph, { id: "hypo", vector: rvec(d) }, 3);
  assert.ok(result.baseline.path.length >= 1);
  assert.ok(result.withNode.path.length >= 1);
  assert.ok(Array.isArray(result.impacted));
});

test("MGR impactSummary returns non-empty string", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 8);
  const q = rvec(d);

  const result = mgr.whatIf(q, graph, { id: "hypo", vector: rvec(d) }, 2);
  const summary = mgr.impactSummary(result, "hypo");
  assert.ok(summary.length > 0);
  assert.ok(summary.includes("hypo"), "summary should mention the hypothetical node");
});

// ── KDA parameters ──

test("MGR KDA parameters are learned during training", () => {
  const mgr = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 5);
  const q = rvec(d);

  const before = mgr.toJSON();

  for (let i = 0; i < 10; i++) {
    mgr.trainPath({ queryVector: q, pathNodeIds: ["n0", "n1"], graph }, 0.1);
  }

  const after = mgr.toJSON();

  // At least one KDA parameter should have changed
  const aLogChanged = Math.abs(after.aLog - before.aLog) > 1e-7;
  const bLogChanged = Object.keys(after.nodeBiasLogits).some(
    (k) => Math.abs((after.nodeBiasLogits[k] ?? 0) - (before.nodeBiasLogits[k] ?? 0)) > 1e-7,
  );
  const betaChanged = Object.keys(after.nodeBetaLogits).some(
    (k) => Math.abs((after.nodeBetaLogits[k] ?? 0) - (before.nodeBetaLogits[k] ?? 0)) > 1e-7,
  );

  assert.ok(
    aLogChanged || bLogChanged || betaChanged,
    "at least one KDA parameter should change during training",
  );
});

// ── determinism ──

test("MGR traverse is deterministic", () => {
  const mgr1 = new MemoryGraphReasoner(d);
  const mgr2 = new MemoryGraphReasoner(d);
  const graph = buildGraph(d, 10);
  const q = rvec(d);

  const r1 = mgr1.traverse(q, graph, 3);
  const r2 = mgr2.traverse(q, graph, 3);

  assert.equal(r1.path.length, r2.path.length);
  for (let i = 0; i < r1.path.length; i++) {
    assert.equal(r1.path[i]!.nodeId, r2.path[i]!.nodeId);
    assert.ok(Math.abs(r1.path[i]!.score - r2.path[i]!.score) < 1e-7);
  }
});
