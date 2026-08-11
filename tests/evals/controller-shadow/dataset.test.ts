import assert from "node:assert/strict";
import test from "node:test";

import { buildShadowDataset } from "../../../evals/controller-shadow/dataset.ts";
import type {
  ShadowEvaluationEvent,
  ShadowRetrievalEvent,
} from "../../../src/lab/shadow-evaluation.ts";
import { CONTROLLER_FEATURE_COUNT } from "../../../src/lab/controller-protocol.ts";

test("shadow dataset joins labels and keeps semantic tasks in one chronological split", () => {
  const events: ShadowEvaluationEvent[] = [
    ...taskEvents("graph-a1", "task-a", "2026-08-01T00:00:00.000Z"),
    ...taskEvents("graph-a2", "task-a", "2026-08-02T00:00:00.000Z"),
    ...taskEvents("graph-b", "task-b", "2026-08-03T00:00:00.000Z"),
    ...taskEvents("graph-c", "task-c", "2026-08-04T00:00:00.000Z"),
  ];
  const dataset = buildShadowDataset(events, 0.34);
  assert.deepEqual(dataset.tasks, { total: 3, train: 1, validation: 2 });
  assert.deepEqual(
    new Set(dataset.rows.filter((row) => row.semanticTaskId === "task-a").map((row) => row.split)),
    new Set(["train"]),
  );
  assert.deepEqual(
    new Set(dataset.rows.filter((row) => row.semanticTaskId === "task-b").map((row) => row.split)),
    new Set(["validation"]),
  );
  assert.equal(dataset.blockers.length, 0);
});

test("shadow dataset excludes incomplete labels and reports sparse-data blockers", () => {
  const events = taskEvents("graph-a", "task-a", "2026-08-01T00:00:00.000Z");
  const feedback = events.at(-1)!;
  if (feedback.type !== "feedback") throw new Error("fixture feedback missing");
  feedback.expansionUseful = null;
  const dataset = buildShadowDataset(events);
  assert.equal(dataset.rows.length, 0);
  assert.equal(dataset.excludedGraphs, 1);
  assert.match(dataset.blockers.join("\n"), /fully labelled|two independent|training|validation/u);
});

function taskEvents(
  graphId: string,
  semanticTaskId: string,
  recordedAt: string,
): ShadowEvaluationEvent[] {
  const retrieval: ShadowRetrievalEvent = {
    version: 1,
    type: "retrieval",
    graphId,
    sessionId: `session-${graphId}`,
    recordedAt,
    origin: "tool",
    query: `query ${semanticTaskId}`,
    queryTaskId: `query:${semanticTaskId}`,
    candidateMemoryIds: ["memory-1"],
    candidateNodeIds: ["node-1"],
    selections: [],
    qpp: null,
    baselineNodeIds: ["node-1"],
    learnedNodeIds: ["node-1"],
    changed: false,
    controllerTrainingSteps: 0,
    controllerFeatures: {
      protocolVersion: 2,
      global: Array<number>(CONTROLLER_FEATURE_COUNT).fill(0),
      memories: { "memory-1": Array<number>(CONTROLLER_FEATURE_COUNT).fill(0) },
      nodes: { "node-1": Array<number>(CONTROLLER_FEATURE_COUNT).fill(0) },
      edges: {},
    },
    budget: {
      maxNodes: 8,
      maxEdges: 12,
      maxEvidence: 13,
      maxTokens: 4_000,
      maxGraphHops: 1,
      maxLocalTier: 1,
      maxTierBudget: 1,
      maxLatencyMs: 500,
    },
    costs: {
      retrievalLatencyMs: 1,
      controllerLatencyMs: 0.1,
      injectedCharacters: 40,
      injectedEstimatedTokens: 10,
      recordsRead: 1,
      estimatedTokens: 20,
      nodesRead: 1,
      edgesRead: 0,
      graphHops: 0,
      deepestTier: 0,
    },
  };
  return [
    retrieval,
    {
      version: 1,
      type: "feedback",
      collectionOrigin: "natural",
      graphId,
      sessionId: retrieval.sessionId,
      recordedAt,
      semanticTaskId,
      taskSuccess: true,
      userCorrection: false,
      evidenceSufficient: true,
      expansionUseful: false,
      excessiveNoise: false,
      noMemoryNeeded: false,
    },
  ];
}

test("shadow dataset rejects labelled legacy rows that cannot replay controller inputs", () => {
  const events = taskEvents("graph-legacy", "task-legacy", "2026-08-01T00:00:00.000Z");
  const retrieval = events[0];
  if (retrieval?.type !== "retrieval") throw new Error("fixture retrieval missing");
  delete retrieval.controllerFeatures;
  const dataset = buildShadowDataset(events);
  assert.equal(dataset.rows.length, 0);
  assert.equal(dataset.legacyGraphsWithoutReplayInputs, 1);
  assert.match(dataset.blockers.join("\n"), /replayable controller inputs/u);
});
