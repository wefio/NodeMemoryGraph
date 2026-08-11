import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillOptPolicyDataset } from "../../../evals/skillopt/dataset.ts";
import type {
  ShadowEvaluationEvent,
  ShadowFeedbackEvent,
  ShadowRetrievalEvent,
} from "../../../src/lab/shadow-evaluation.ts";

test("SkillOpt policy dataset keeps whole tasks split and excludes memory contents", () => {
  const events = [
    ...eventsFor("a1", "task-a", "2026-08-01T00:00:00Z", true, false, false, false),
    ...eventsFor("a2", "task-a", "2026-08-02T00:00:00Z", true, false, true, false),
    ...eventsFor("b", "task-b", "2026-08-03T00:00:00Z", false, true, false, false),
    ...eventsFor("c", "task-c", "2026-08-04T00:00:00Z", false, false, false, true),
  ];
  const dataset = buildSkillOptPolicyDataset(events, {
    minimumTasks: 3,
    minimumTrainTasks: 1,
    minimumValidationTasks: 1,
    minimumTestTasks: 1,
    minimumActionClasses: 2,
    minimumNoiseLabels: 2,
  });
  assert.equal(dataset.ready, true);
  assert.deepEqual(dataset.counts, {
    train: 1,
    val: 1,
    test: 1,
    tasks: 3,
    action_classes: 3,
    noise_labels: 2,
  });
  assert.deepEqual(
    new Set(dataset.items.filter((item) => item.semantic_task_id === "task-a").map((item) => item.split)),
    new Set(["train"]),
  );
  assert.deepEqual(
    dataset.items.map((item) => item.expected.recall_action),
    ["answer", "answer", "expand", "stop"],
  );
  const serialized = JSON.stringify(dataset);
  assert.doesNotMatch(serialized, /private memory statement|source evidence/u);
  assert.doesNotMatch(serialized, /session-a1/u);
});

test("SkillOpt policy dataset fails readiness on sparse natural labels", () => {
  const dataset = buildSkillOptPolicyDataset(
    eventsFor("a", "task-a", "2026-08-01T00:00:00Z", true, false, false, false),
  );
  assert.equal(dataset.ready, false);
  assert.match(dataset.blockers.join("\n"), /tasks requires 24|val requires 6|test requires 6/u);
});

function eventsFor(
  suffix: string,
  task: string,
  recordedAt: string,
  evidenceSufficient: boolean,
  expansionUseful: boolean,
  excessiveNoise: boolean,
  noMemoryNeeded: boolean,
): ShadowEvaluationEvent[] {
  const graphId = `graph-${suffix}`;
  const retrieval: ShadowRetrievalEvent = {
    version: 1,
    type: "retrieval",
    graphId,
    sessionId: `session-${suffix}`,
    recordedAt,
    origin: "tool",
    query: `query ${task}`,
    queryTaskId: `query:${task}`,
    candidateMemoryIds: ["memory-id-only"],
    candidateNodeIds: ["node-id-only"],
    selections: [],
    qpp: null,
    baselineNodeIds: ["node-id-only"],
    learnedNodeIds: ["node-id-only"],
    changed: false,
    controllerTrainingSteps: 0,
    costs: {
      retrievalLatencyMs: 2,
      controllerLatencyMs: 0,
      injectedCharacters: 20,
      injectedEstimatedTokens: 5,
      recordsRead: 1,
      estimatedTokens: 10,
      nodesRead: 1,
      edgesRead: 0,
      graphHops: 0,
      deepestTier: 0,
    },
  };
  const feedback: ShadowFeedbackEvent = {
    version: 1,
    type: "feedback",
    graphId,
    sessionId: retrieval.sessionId,
    recordedAt,
    semanticTaskId: task,
    taskSuccess: null,
    userCorrection: null,
    evidenceSufficient,
    expansionUseful,
    excessiveNoise,
    noMemoryNeeded,
  };
  return [retrieval, feedback];
}
