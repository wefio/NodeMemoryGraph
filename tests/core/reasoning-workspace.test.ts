import assert from "node:assert/strict";
import test from "node:test";

import { ReasoningWorkspace } from "../../src/lab/reasoning-workspace.ts";

test("reasoning checkpoints preserve an explicit inference chain", () => {
  const workspace = new ReasoningWorkspace("session-chain");
  const goal = workspace.addNode({
    kind: "goal",
    content: "Find why the build fails",
    importance: 1,
  });
  const evidence = workspace.addNode({
    kind: "evidence",
    content: "The compiler reports a missing generated file",
    importance: 0.8,
    evidenceRefs: ["tool:compiler-output"],
  });
  const conclusion = workspace.addNode({
    kind: "conclusion",
    content: "Code generation did not run",
    importance: 0.9,
  });
  workspace.link(goal.id, evidence.id, "next_step");
  workspace.link(evidence.id, conclusion.id, "supports");
  workspace.updateNode(conclusion.id, { status: "supported" });

  const checkpoint = workspace.checkpoint();

  assert.equal(checkpoint.nodes.length, 3);
  assert.equal(checkpoint.edges.length, 2);
  assert.match(checkpoint.text, /Code generation did not run/);
  assert.match(checkpoint.text, /-\[supports\]->/);
});

test("rejected hypotheses and the evidence rejecting them survive compaction", () => {
  const workspace = new ReasoningWorkspace("session-rejection");
  const evidence = workspace.addNode({
    kind: "evidence",
    content: "The network probe succeeds",
    importance: 0.9,
    evidenceRefs: ["tool:network-probe"],
  });
  const hypothesis = workspace.addNode({
    kind: "hypothesis",
    content: "The network is unavailable",
    status: "rejected",
    importance: 0.9,
  });
  workspace.link(evidence.id, hypothesis.id, "rejects");

  const checkpoint = workspace.checkpoint();

  assert.ok(checkpoint.nodes.some((node) => node.id === hypothesis.id));
  assert.ok(checkpoint.nodes.some((node) => node.id === evidence.id));
  assert.ok(checkpoint.edges.some((edge) => edge.type === "rejects"));
});

test("checkpoint output obeys hard node and character budgets", () => {
  const workspace = new ReasoningWorkspace("session-budget");
  for (let index = 0; index < 20; index += 1) {
    workspace.addNode({
      kind: "observation",
      content: `Observation ${index} ${"x".repeat(200)}`,
      importance: index / 20,
    });
  }

  const checkpoint = workspace.checkpoint({ maxNodes: 4, maxChars: 700 });

  assert.ok(checkpoint.nodes.length <= 4);
  assert.ok(checkpoint.text.length <= 700);
  assert.equal(checkpoint.omittedNodes, 20 - checkpoint.nodes.length);
});

test("reasoning workspace state round-trips without changing graph identity", () => {
  const workspace = new ReasoningWorkspace("session-roundtrip");
  const observation = workspace.addNode({
    kind: "observation",
    content: "A test failed",
  });
  const action = workspace.addNode({
    kind: "next_action",
    content: "Inspect the failing assertion",
  });
  workspace.link(observation.id, action.id, "next_step");

  const restored = ReasoningWorkspace.fromJSON(workspace.toJSON());

  assert.deepEqual(restored.toJSON(), workspace.toJSON());
});

test("only supported, attributable conclusions and decisions consolidate", () => {
  const workspace = new ReasoningWorkspace("session-consolidation");
  const evidence = workspace.addNode({
    kind: "evidence",
    content: "Three runs produce the same result",
    evidenceRefs: ["tool:test-run-3"],
  });
  const conclusion = workspace.addNode({
    kind: "conclusion",
    content: "The result is reproducible",
    importance: 0.9,
  });
  workspace.addNode({
    kind: "conclusion",
    content: "An unsupported guess",
    importance: 0.9,
  });
  workspace.addNode({
    kind: "decision",
    content: "A low-priority decision",
    status: "supported",
    importance: 0.2,
    evidenceRefs: ["history-1"],
  });
  workspace.link(evidence.id, conclusion.id, "supports");
  workspace.updateNode(conclusion.id, { status: "supported" });

  assert.deepEqual(
    workspace.consolidationCandidates().map((node) => node.id),
    [conclusion.id],
  );
});

test("supported state requires an externally anchored support path", () => {
  const workspace = new ReasoningWorkspace("session-support-boundary");
  const hypothesis = workspace.addNode({
    kind: "hypothesis",
    content: "The cache is stale",
  });
  assert.throws(
    () => workspace.updateNode(hypothesis.id, { status: "supported" }),
    /requires a stable evidence reference or an anchored/u,
  );
  assert.match(workspace.checkpoint().text, /hypothesis\/active\/support=unsupported/u);

  const observation = workspace.addNode({
    kind: "observation",
    content: "The cache key differs from the stored key",
    evidenceRefs: ["file:cache-report.json"],
  });
  workspace.link(observation.id, hypothesis.id, "supports");
  assert.equal(workspace.updateNode(hypothesis.id, { status: "supported" }).status, "supported");
  assert.equal(workspace.supportState(hypothesis.id), "linked");
});

test("evidence nodes require references and support cycles cannot manufacture evidence", () => {
  const workspace = new ReasoningWorkspace("session-no-self-support");
  assert.throws(
    () => workspace.addNode({ kind: "evidence", content: "An unattributed claim" }),
    /require at least one stable evidence reference/u,
  );
  const first = workspace.addNode({ kind: "hypothesis", content: "First guess" });
  const second = workspace.addNode({ kind: "conclusion", content: "Second guess" });
  workspace.link(first.id, second.id, "supports");
  workspace.link(second.id, first.id, "supports");
  assert.equal(workspace.supportState(first.id), "unsupported");
  assert.equal(workspace.supportState(second.id), "unsupported");
  assert.throws(
    () => workspace.updateNode(second.id, { status: "supported" }),
    /requires a stable evidence reference or an anchored/u,
  );
});

test("removing a reference cannot orphan an already supported downstream conclusion", () => {
  const workspace = new ReasoningWorkspace("session-support-removal");
  const observation = workspace.addNode({
    kind: "observation",
    content: "Observed result",
    evidenceRefs: ["tool:result"],
  });
  const conclusion = workspace.addNode({ kind: "conclusion", content: "Supported result" });
  workspace.link(observation.id, conclusion.id, "supports");
  workspace.updateNode(conclusion.id, { status: "supported" });

  assert.throws(
    () => workspace.updateNode(observation.id, { evidenceRefs: [] }),
    /would remove support/u,
  );
  assert.deepEqual(workspace.toJSON().nodes.find((node) => node.id === observation.id)?.evidenceRefs, [
    "tool:result",
  ]);
});
