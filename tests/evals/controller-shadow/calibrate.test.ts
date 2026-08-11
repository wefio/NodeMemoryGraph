import assert from "node:assert/strict";
import test from "node:test";

import {
  calibrateShadowController,
  summarizeShadowCalibration,
} from "../../../evals/controller-shadow/calibrate.ts";
import { buildShadowDataset } from "../../../evals/controller-shadow/dataset.ts";
import { CONTROLLER_FEATURE_COUNT } from "../../../src/lab/controller-protocol.ts";
import type {
  ShadowEvaluationEvent,
  ShadowRetrievalEvent,
} from "../../../src/lab/shadow-evaluation.ts";

test("shadow calibration trains a replayable candidate without activating it", () => {
  const events = [
    ...eventsFor("graph-a", "task-a", "2026-08-01T00:00:00.000Z"),
    ...eventsFor("graph-b", "task-b", "2026-08-02T00:00:00.000Z"),
    ...eventsFor("graph-c", "task-c", "2026-08-03T00:00:00.000Z"),
    ...eventsFor("graph-d", "task-d", "2026-08-04T00:00:00.000Z"),
    ...eventsFor("graph-e", "task-e", "2026-08-05T00:00:00.000Z"),
  ];
  const dataset = buildShadowDataset(events, 0.2);
  assert.equal(dataset.blockers.length, 0);
  const result = calibrateShadowController(dataset.rows, { epochs: 4, topNodes: 1 });
  assert.equal(result.featureProtocolVersion, 2);
  assert.ok(result.training.steps > 0);
  assert.equal(result.rows.validation, 1);
  assert.equal(result.eligibleForActivation, false);
  assert.equal(result.validation.candidateRecall, 1);
  assert.ok(Number.isFinite(result.validation.meanInferenceMs));
  assert.ok(result.validation.costs.injectedTokens > 0);
  assert.deepEqual(result.evidenceDiversity, {
    primaryTrainingTargets: 1,
    primaryValidationTargets: 1,
    exactTrainingTargets: 2,
    exactValidationTargets: 2,
    overlappingExactTargets: 2,
  });
  assert.equal(result.gate.controllerGate.enoughEvidenceDiversity, false);
  assert.equal(result.gate.controllerGate.evidenceTargetsHeldOut, false);
  const summary = summarizeShadowCalibration(result);
  assert.deepEqual(summary.evidenceDiversity, result.evidenceDiversity);
  assert.deepEqual(summary.gate, result.gate);
  assert.equal("controller" in summary, false);
});

test("shadow calibration catches leakage through non-primary exact evidence", () => {
  const events = [
    ...eventsFor("graph-a", "task-a", "2026-08-01T00:00:00.000Z", "primary-a"),
    ...eventsFor("graph-b", "task-b", "2026-08-02T00:00:00.000Z", "primary-b"),
    ...eventsFor("graph-c", "task-c", "2026-08-03T00:00:00.000Z", "primary-c"),
    ...eventsFor("graph-d", "task-d", "2026-08-04T00:00:00.000Z", "primary-d"),
    ...eventsFor("graph-e", "task-e", "2026-08-05T00:00:00.000Z", "primary-e"),
  ];
  const dataset = buildShadowDataset(events, 0.2);
  const result = calibrateShadowController(dataset.rows, { epochs: 1, topNodes: 1 });

  assert.deepEqual(result.evidenceDiversity, {
    primaryTrainingTargets: 4,
    primaryValidationTargets: 1,
    exactTrainingTargets: 5,
    exactValidationTargets: 2,
    overlappingExactTargets: 1,
  });
  assert.equal(result.gate.controllerGate.evidenceTargetsHeldOut, false);
});

function eventsFor(
  graphId: string,
  semanticTaskId: string,
  recordedAt: string,
  primaryMemoryId = "memory-useful",
): ShadowEvaluationEvent[] {
  const vector = (signal: number) => {
    const values = Array<number>(CONTROLLER_FEATURE_COUNT).fill(0);
    values[0] = signal;
    return values;
  };
  const retrieval: ShadowRetrievalEvent = {
    version: 1,
    type: "retrieval",
    graphId,
    sessionId: `session-${graphId}`,
    recordedAt,
    origin: "tool",
    query: `query ${semanticTaskId}`,
    queryTaskId: `query:${semanticTaskId}`,
    candidateMemoryIds: [primaryMemoryId, "memory-shared", "memory-noise"],
    candidateNodeIds: ["node-useful", "node-noise"],
    selections: [
      selection(primaryMemoryId, "node-useful", 1, 0.9),
      selection("memory-shared", "node-useful", 2, 0.8),
      selection("memory-noise", "node-noise", 3, 0.2),
    ],
    qpp: null,
    baselineNodeIds: ["node-useful", "node-noise"],
    learnedNodeIds: ["node-useful", "node-noise"],
    changed: false,
    controllerTrainingSteps: 0,
    controllerFeatures: {
      protocolVersion: 2,
      global: vector(0.5),
      memories: {
        [primaryMemoryId]: vector(1),
        "memory-shared": vector(0.8),
        "memory-noise": vector(0),
      },
      nodes: { "node-useful": vector(1), "node-noise": vector(0) },
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
      retrievalLatencyMs: 2,
      controllerLatencyMs: 0.1,
      injectedCharacters: 80,
      injectedEstimatedTokens: 20,
      recordsRead: 2,
      estimatedTokens: 40,
      nodesRead: 2,
      edgesRead: 0,
      graphHops: 0,
      deepestTier: 0,
    },
  };
  return [
    retrieval,
    {
      version: 1,
      type: "use",
      graphId,
      sessionId: retrieval.sessionId,
      recordedAt,
      requestedMemoryIds: [primaryMemoryId, "memory-shared"],
      usedMemoryIds: [primaryMemoryId, "memory-shared"],
    },
    {
      version: 1,
      type: "outcome",
      graphId,
      sessionId: retrieval.sessionId,
      recordedAt,
      runCompleted: true,
      messageCount: 2,
      toolRounds: 1,
      inputTokens: 100,
      outputTokens: 20,
      endToEndLatencyMs: 25,
    },
    {
      version: 1,
      type: "feedback",
      graphId,
      sessionId: retrieval.sessionId,
      recordedAt,
      semanticTaskId,
      taskSuccess: true,
      userCorrection: false,
      evidenceSufficient: true,
      expansionUseful: false,
      excessiveNoise: true,
      noMemoryNeeded: false,
    },
  ];
}

function selection(memoryId: string, nodeId: string, rank: number, usefulness: number) {
  return {
    memoryId,
    nodeId,
    source: "direct" as const,
    reason: "lexical_match",
    rank,
    tier: 0 as const,
    estimatedTokens: 20,
    scores: { lexical: usefulness, vector: 0, route: 0, combined: usefulness, usefulness },
  };
}
