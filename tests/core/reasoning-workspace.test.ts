import assert from "node:assert/strict";
import test from "node:test";

import { ReasoningWorkspace } from "../../src/core/reasoning-workspace.ts";

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
  });
  const conclusion = workspace.addNode({
    kind: "conclusion",
    content: "Code generation did not run",
    status: "supported",
    importance: 0.9,
  });
  workspace.link(goal.id, evidence.id, "next_step");
  workspace.link(evidence.id, conclusion.id, "supports");

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
  });
  const conclusion = workspace.addNode({
    kind: "conclusion",
    content: "The result is reproducible",
    status: "supported",
    importance: 0.9,
  });
  workspace.addNode({
    kind: "conclusion",
    content: "An unsupported guess",
    status: "supported",
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

  assert.deepEqual(
    workspace.consolidationCandidates().map((node) => node.id),
    [conclusion.id],
  );
});
