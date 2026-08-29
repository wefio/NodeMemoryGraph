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
