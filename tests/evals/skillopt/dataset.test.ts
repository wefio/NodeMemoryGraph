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

test("SkillOpt default readiness split reserves twelve train and six held-out tasks per arm", () => {
  const events = Array.from({ length: 24 }, (_, index) =>
    eventsFor(
      `ready-${index}`,
      `task-${String(index).padStart(2, "0")}`,
      `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      index % 3 === 0,
      index % 3 === 1,
      index % 2 === 0,
      index % 3 === 2,
    ),
  ).flat();

  const dataset = buildSkillOptPolicyDataset(events);
  assert.equal(dataset.ready, true);
  assert.deepEqual(
    {
      train: dataset.counts.train,
      val: dataset.counts.val,
      test: dataset.counts.test,
      tasks: dataset.counts.tasks,
    },
    { train: 12, val: 6, test: 6, tasks: 24 },
  );
});

test("SkillOpt keeps every task from one reused session in one split", () => {
  const events = [
    ...eventsFor("shared-a", "task-a", "2026-08-01T00:00:00Z", true, false, false, false),
    ...eventsFor("shared-b", "task-b", "2026-08-02T00:00:00Z", false, true, false, false),
    ...eventsFor("other", "task-c", "2026-08-03T00:00:00Z", false, false, true, true),
  ];
  for (const event of events) {
    if (event.graphId === "graph-shared-a" || event.graphId === "graph-shared-b") {
      event.sessionId = "reused-pi-session";
    }
  }

  const dataset = buildSkillOptPolicyDataset(events, {
    minimumTasks: 2,
    minimumTrainTasks: 1,
    minimumValidationTasks: 1,
    minimumTestTasks: 0,
    minimumActionClasses: 1,
    minimumNoiseLabels: 1,
  });
  assert.equal(dataset.counts.tasks, 2);
  assert.equal(
    new Set(
      dataset.items
        .filter((item) => item.semantic_task_id === "task-a" || item.semantic_task_id === "task-b")
        .map((item) => item.split),
    ).size,
    1,
  );
});

test("SkillOpt policy dataset excludes controlled and legacy-unclassified feedback", () => {
  const controlled = eventsFor(
    "controlled",
    "task-controlled",
    "2026-08-01T00:00:00Z",
    true,
    false,
    false,
    false,
  );
  const controlledFeedback = controlled.find(
    (event): event is ShadowFeedbackEvent => event.type === "feedback",
  )!;
  controlledFeedback.collectionOrigin = "controlled";
  const legacy = eventsFor(
    "legacy",
    "task-legacy",
    "2026-08-02T00:00:00Z",
    true,
    false,
    false,
    false,
  );
  delete (legacy.find((event) => event.type === "feedback") as Partial<ShadowFeedbackEvent>)
    .collectionOrigin;
  const dataset = buildSkillOptPolicyDataset([...controlled, ...legacy]);
  assert.equal(dataset.items.length, 0);
  assert.equal(dataset.counts.tasks, 0);
  assert.equal(dataset.excluded_graphs, 2);
});

test("SkillOpt policy dataset aggregates labels submitted incrementally", () => {
  const events = eventsFor(
    "incremental",
    "task-incremental",
    "2026-08-01T00:00:00Z",
    false,
    false,
    true,
    true,
  );
  const complete = events.pop();
  if (complete?.type !== "feedback") throw new Error("fixture feedback missing");
  for (const label of [
    "evidenceSufficient",
    "expansionUseful",
    "excessiveNoise",
    "noMemoryNeeded",
  ] as const) {
    events.push({
      ...complete,
      evidenceSufficient: null,
      expansionUseful: null,
      excessiveNoise: null,
      noMemoryNeeded: null,
      [label]: complete[label],
    });
  }

  const dataset = buildSkillOptPolicyDataset(events, {
    minimumTasks: 1,
    minimumTrainTasks: 0,
    minimumValidationTasks: 0,
    minimumTestTasks: 0,
    minimumActionClasses: 1,
    minimumNoiseLabels: 1,
  });
  assert.equal(dataset.items.length, 1);
  assert.deepEqual(dataset.items[0]?.expected, { recall_action: "stop", fold_noise: true });
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
    collectionOrigin: "natural",
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
