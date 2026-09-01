import assert from "node:assert/strict";
import test from "node:test";

import { SessionActiveGraphRuntime } from "../../src/core/session-active-graph.ts";
import type { ActiveGraph } from "../../src/core/types.ts";

test("session Active Graph keeps one mutable identity and immutable projection revisions", () => {
  let now = Date.parse("2026-08-29T00:00:00.000Z");
  const runtime = new SessionActiveGraphRuntime<string>({ now: () => now });
  const first = runtime.registerProjection(graph("trace-a", "session-a", "task-a", "memory-a"), [
    { traceId: "trace-a", memoryIds: new Set(["memory-a"]), value: "store-a" },
  ]);
  now += 1_000;
  const second = runtime.registerProjection(graph("trace-b", "session-a", "task-a", "memory-b"), [
    { traceId: "trace-b", memoryIds: new Set(["memory-b"]), value: "store-a" },
  ]);

  assert.equal(first.agId, second.agId);
  assert.notEqual(first.projectionId, second.projectionId);
  assert.equal(second.parentProjectionId, first.projectionId);
  assert.equal(second.sequence, 2);
  assert.equal(second.graph.id, second.projectionId);
  assert.deepEqual(second.graph.traceIds, ["trace-b"]);
  assert.throws(() => second.graph.memoryIds.push("mutated"), TypeError);
  assert.equal(runtime.projection(first.projectionId, "session-a")?.parts[0]?.value, "store-a");
  assert.equal(runtime.projection(first.projectionId, "session-b"), null);
});

test("temporary observations stay hidden until projected and disappear on session release", () => {
  const runtime = new SessionActiveGraphRuntime({
    maxItemsPerSession: 2,
    maxCharactersPerSession: 80,
  });
  assert.equal(
    runtime.observe({ sessionId: "session-a", sourceId: "bash", statement: "Built the project." })
      .added,
    true,
  );
  assert.equal(
    runtime.observe({ sessionId: "session-a", sourceId: "bash", statement: "Built the project." })
      .added,
    false,
  );
  assert.deepEqual(runtime.snapshot("session-a")?.items, []);

  const projected = runtime.activateTemporaryProjection("session-a");
  assert.equal(projected.items.length, 1);
  assert.equal(projected.items[0]?.kind, "tool_observation");
  assert.equal(runtime.release("session-a"), true);
  assert.equal(runtime.snapshot("session-a"), null);
});

test("task frames: switching frames keeps a bounded cooling set and task return restores it", () => {
  let now = Date.parse("2026-08-29T00:00:00.000Z");
  const runtime = new SessionActiveGraphRuntime<string>({
    now: () => now,
    maxItemsPerSession: 8,
    maxCharactersPerSession: 1_000,
    maxTaskFramesPerSession: 3,
  });
  // Frame A: project two memories under task-alpha.
  const alpha1 = runtime.registerProjection(
    graph("trace-a1", "session-a", "task-alpha", "memory-a1"),
    [{ traceId: "trace-a1", memoryIds: new Set(["memory-a1"]), value: "v1" }],
  );
  const alpha2 = runtime.registerProjection(
    graph("trace-a2", "session-a", "task-alpha", "memory-a2"),
    [{ traceId: "trace-a2", memoryIds: new Set(["memory-a2"]), value: "v2" }],
  );
  assert.equal(alpha2.parentProjectionId, alpha1.projectionId, "same-frame parent chain");

  // Switch to frame B: the task-alpha frame must cool, not disappear.
  now += 1_000;
  const beta = runtime.registerProjection(
    graph("trace-b", "session-a", "task-beta", "memory-b"),
    [{ traceId: "trace-b", memoryIds: new Set(["memory-b"]), value: "vb" }],
  );
  assert.equal(beta.parentProjectionId, null, "cross-frame projection has no same-frame parent");
  // Alpha items remain reachable via the cooled frame (not evicted).
  assert.ok(runtime.taskFrame("session-a", "task-alpha"), "cooled frame is still retrievable");

  // Return to frame A: the parent chain resumes from alpha2, not beta.
  now += 1_000;
  const alpha3 = runtime.registerProjection(
    graph("trace-a3", "session-a", "task-alpha", "memory-a3"),
    [{ traceId: "trace-a3", memoryIds: new Set(["memory-a3"]), value: "v3" }],
  );
  assert.equal(
    alpha3.parentProjectionId,
    alpha2.projectionId,
    "returning to a frame resumes its own parent chain",
  );
});

test("task frames: bounded cooling set evicts the oldest frame beyond the cap", () => {
  let now = Date.parse("2026-08-29T00:00:00.000Z");
  const runtime = new SessionActiveGraphRuntime<string>({
    now: () => now,
    maxItemsPerSession: 8,
    maxCharactersPerSession: 1_000,
    maxTaskFramesPerSession: 2,
  });
  for (const task of ["frame-1", "frame-2", "frame-3"]) {
    now += 1_000;
    runtime.registerProjection(graph(`t-${task}`, "session-a", task, `m-${task}`), [
      { traceId: `t-${task}`, memoryIds: new Set([`m-${task}`]), value: task },
    ]);
  }
  // The oldest frame (frame-1) must have been evicted by the cap; frame-2
  // and frame-3 remain.
  assert.equal(runtime.taskFrame("session-a", "frame-1"), null, "oldest frame evicted");
  assert.ok(runtime.taskFrame("session-a", "frame-2"), "second frame kept");
  assert.ok(runtime.taskFrame("session-a", "frame-3"), "newest frame kept");
});

test("task frames: branch isolation — items projected under one frame stay out of another", () => {
  let now = Date.parse("2026-08-29T00:00:00.000Z");
  const runtime = new SessionActiveGraphRuntime<string>({
    now: () => now,
    maxItemsPerSession: 8,
    maxCharactersPerSession: 1_000,
    maxTaskFramesPerSession: 3,
  });
  runtime.registerProjection(graph("t-a", "session-a", "task-alpha", "memory-a"), [
    { traceId: "t-a", memoryIds: new Set(["memory-a"]), value: "a" },
  ]);
  runtime.registerProjection(graph("t-b", "session-a", "task-beta", "memory-b"), [
    { traceId: "t-b", memoryIds: new Set(["memory-b"]), value: "b" },
  ]);
  const alphaFrame = runtime.taskFrame("session-a", "task-alpha");
  const betaFrame = runtime.taskFrame("session-a", "task-beta");
  assert.ok(alphaFrame && betaFrame, "both frames exist");
  assert.equal(alphaFrame.agId, betaFrame.agId, "frames share the session agId");
  assert.notEqual(
    alphaFrame.latestProjectionId,
    betaFrame.latestProjectionId,
    "frames have independent projection chains",
  );
  assert.deepEqual(
    alphaFrame.items.map((item) => item.statement),
    ["memory:memory-a"],
    "alpha frame keeps only its own items",
  );
  assert.deepEqual(
    betaFrame.items.map((item) => item.statement),
    ["memory:memory-b"],
    "beta frame keeps only its own items",
  );
});

test("task frames: shared constraints persist across frame switches", () => {
  let now = Date.parse("2026-08-29T00:00:00.000Z");
  const runtime = new SessionActiveGraphRuntime<string>({
    now: () => now,
    maxItemsPerSession: 8,
    maxCharactersPerSession: 1_000,
    maxTaskFramesPerSession: 3,
  });
  runtime.observe({
    sessionId: "session-a",
    statement: "Never touch the prod database.",
    kind: "tool_observation",
    taskFrameId: "task-alpha",
  });
  // Switch frames; the observation stays bound to alpha.
  runtime.registerProjection(graph("t-b", "session-a", "task-beta", "memory-b"), [
    { traceId: "t-b", memoryIds: new Set(["memory-b"]), value: "b" },
  ]);
  // The observation is temporary (hidden until the temporary projection is
  // active); activate it so the cooled alpha frame surfaces its items.
  runtime.activateTemporaryProjection("session-a");
  const alpha = runtime.taskFrame("session-a", "task-alpha");
  assert.ok(alpha, "alpha frame still present");
  assert.ok(
    alpha.items.some((item) => item.statement === "Never touch the prod database."),
    "constraint observation survives the switch",
  );
});

function graph(id: string, sessionId: string, taskId: string, memoryId: string): ActiveGraph {
  return {
    id,
    sessionId,
    query: "query",
    taskId,
    nodeIds: ["node-a"],
    memoryIds: [memoryId],
    edges: [],
    selections: [
      {
        memoryId,
        nodeId: "node-a",
        source: "direct",
        reason: "lexical_match",
        rank: 1,
        tier: 0,
        estimatedTokens: 4,
        scores: { lexical: 1, vector: 0, route: 0, combined: 1, usefulness: 1 },
      },
    ],
    expansions: [],
    budgetLedger: [],
    budget: {
      maxNodes: 4,
      maxEdges: 4,
      maxEvidence: 4,
      maxTokens: 100,
      maxGraphHops: 1,
      maxLocalTier: 1,
      maxTierBudget: 2,
      maxLatencyMs: 100,
    },
    usage: {
      nodes: 1,
      edges: 0,
      evidence: 1,
      estimatedTokens: 4,
      graphHops: 0,
      deepestTier: 0,
      tiersOpened: 1,
      deepEvidence: 0,
      latencyMs: 1,
      exhausted: [],
    },
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}
