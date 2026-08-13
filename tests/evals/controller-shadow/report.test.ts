import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  resolveShadowEventPath,
  summarizeShadowEvents,
} from "../../../evals/controller-shadow/report.ts";
import type { ShadowEvaluationEvent } from "../../../src/lab/shadow-evaluation.ts";

test("shadow coverage keeps missing labels unknown and reports calibration blockers", () => {
  const base = {
    version: 1 as const,
    graphId: "graph-1",
    sessionId: "session-1",
    recordedAt: "2026-08-09T00:00:00.000Z",
  };
  const events: ShadowEvaluationEvent[] = [
    {
      ...base,
      type: "retrieval",
      origin: "automatic",
      query: "prior decision",
      queryTaskId: "query:prior-decision",
      candidateMemoryIds: ["memory-1"],
      candidateNodeIds: ["node-1"],
      selections: [],
      qpp: null,
      baselineNodeIds: ["node-1"],
      learnedNodeIds: ["node-1"],
      changed: false,
      controllerTrainingSteps: 0,
      costs: {
        retrievalLatencyMs: 2,
        controllerLatencyMs: 0.1,
        injectedCharacters: 80,
        injectedEstimatedTokens: 20,
        recordsRead: 1,
        estimatedTokens: 30,
        nodesRead: 1,
        edgesRead: 0,
        deepestTier: 0,
      },
    },
    {
      ...base,
      type: "feedback",
      collectionOrigin: "natural",
      semanticTaskId: "task-1",
      taskSuccess: null,
      userCorrection: true,
      evidenceSufficient: false,
      expansionUseful: true,
      excessiveNoise: false,
      noMemoryNeeded: false,
    },
    {
      ...base,
      type: "tool_flow",
      action: "search_suppressed",
      reason: "evidence_progression_required",
      query: "same query again",
    },
    {
      ...base,
      type: "tool_flow",
      action: "feedback_nudge_shown",
      reason: "next_user_turn_review",
    },
  ];
  const report = summarizeShadowEvents(events);
  assert.equal(report.retrievals, 1);
  assert.equal(report.semanticTasks, 1);
  assert.equal(report.queryTasks, 1);
  assert.equal(report.injection.characters, 80);
  assert.equal(report.labels.taskSuccess, 0);
  assert.equal(report.labels.userCorrection, 1);
  assert.equal(report.fullyLabelledGraphs, 1);
  assert.deepEqual(report.fullyLabelledGraphsByOrigin, {
    natural: 1,
    controlled: 0,
    legacy: 0,
  });
  assert.equal(report.toolFlow, 2);
  assert.equal(report.searchSuppressed, 1);
  assert.equal(report.feedbackNudgesShown, 1);
  assert.equal(report.calibrationReady, false);
  assert.match(report.blockers.at(-1)!, /held-out/u);
});

test("shadow coverage excludes controlled and legacy feedback from the natural headline", () => {
  const feedbackBase = {
    version: 1 as const,
    sessionId: "session-1",
    recordedAt: "2026-08-09T00:00:00.000Z",
    type: "feedback" as const,
    semanticTaskId: "task-1",
    taskSuccess: null,
    userCorrection: null,
    evidenceSufficient: true,
    expansionUseful: false,
    excessiveNoise: false,
    noMemoryNeeded: false,
  };
  const events = [
    { ...feedbackBase, graphId: "natural", collectionOrigin: "natural" },
    { ...feedbackBase, graphId: "controlled", collectionOrigin: "controlled" },
    { ...feedbackBase, graphId: "legacy" },
  ] as unknown as ShadowEvaluationEvent[];

  const report = summarizeShadowEvents(events);
  assert.equal(report.fullyLabelledGraphs, 1);
  assert.deepEqual(report.fullyLabelledGraphsByOrigin, {
    natural: 1,
    controlled: 1,
    legacy: 1,
  });
});

test("shadow report uses the shared user-level data directory contract", () => {
  assert.equal(
    resolveShadowEventPath(undefined, {}),
    resolve(homedir(), ".nmg/controller-shadow-events.jsonl"),
  );
  assert.equal(
    resolveShadowEventPath(undefined, { NMG_DATA_DIR: "C:/state/nmg" }),
    resolve("C:/state/nmg/controller-shadow-events.jsonl"),
  );
});
