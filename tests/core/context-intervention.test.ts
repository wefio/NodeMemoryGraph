import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitContextIntervention,
  type ContextIntervention,
} from "../../src/lab/context-intervention.ts";

function sample(): ContextIntervention {
  return {
    schemaVersion: 1,
    decisionId: "decision-1",
    taskId: "task-1",
    sessionId: "session-1",
    taskFrameId: "frame-1",
    acceptanceVersion: "acceptance-1",
    featureVersion: "fixture-32-v1",
    policyVersion: "linear-zero-v1",
    origin: "benchmark",
    mode: "executed",
    decidedAt: 10,
    features: Array(32).fill(0),
    allowed: ["none", "retrieve"],
    selected: "retrieve",
    probability: 0.5,
    execution: { action: "retrieve", startedAt: 11, endedAt: 12, status: "completed" },
    outcome: {
      taskId: "task-1",
      acceptanceVersion: "acceptance-1",
      windowStart: 11,
      windowEnd: 20,
      recordedAt: 21,
      status: "observed",
      reward: 1,
      evidenceRefs: ["fixture:verified-answer"],
      costs: { tokens: 100, toolCalls: 1, latencyMs: 50 },
    },
  };
}

test("contract: executed benchmark sample requires independent admission", () => {
  const input = sample();
  assert.equal(admitContextIntervention(input, () => false).reason, "unverified-evidence");
  const result = admitContextIntervention(input, () => true);
  assert.equal(result.reason, "admitted");
  assert.equal(result.sample?.origin, "benchmark");
  input.features[0] = 1;
  assert.equal(result.sample?.features[0], 0);
});

test("safety: shadow and unexecuted selections cannot become training labels", () => {
  for (const mutation of [
    (x: ContextIntervention) => {
      x.mode = "shadow";
    },
    (x: ContextIntervention) => {
      delete x.execution;
    },
    (x: ContextIntervention) => {
      x.execution!.action = "none";
    },
    (x: ContextIntervention) => {
      x.execution!.status = "cancelled";
    },
    (x: ContextIntervention) => {
      x.execution!.status = "timeout";
    },
  ]) {
    const input = sample();
    mutation(input);
    assert.equal(admitContextIntervention(input, () => true).sample, undefined);
  }
});

test("safety: scope drift, reopening, missing evidence and invalid windows fail closed", () => {
  for (const mutation of [
    (x: ContextIntervention) => {
      x.outcome!.taskId = "another-task";
    },
    (x: ContextIntervention) => {
      x.outcome!.acceptanceVersion = "another-version";
    },
    (x: ContextIntervention) => {
      x.outcome!.status = "reopened";
    },
    (x: ContextIntervention) => {
      x.outcome!.evidenceRefs = [];
    },
    (x: ContextIntervention) => {
      x.outcome!.windowEnd = 10;
    },
    (x: ContextIntervention) => {
      x.outcome!.recordedAt = 19;
    },
    (x: ContextIntervention) => {
      x.outcome!.costs.tokens = -1;
    },
    (x: ContextIntervention) => {
      x.probability = 0;
    },
    (x: ContextIntervention) => {
      x.features[0] = NaN;
    },
  ]) {
    const input = sample();
    mutation(input);
    assert.equal(admitContextIntervention(input, () => true).sample, undefined);
  }
});

test("contract: verifier errors remain missing evidence, not negative rewards", () => {
  assert.equal(
    admitContextIntervention(sample(), () => {
      throw new Error("offline");
    }).reason,
    "unverified-evidence",
  );
});
