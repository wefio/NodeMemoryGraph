import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildContextDataset,
  contextGroupSplit,
} from "../../evals/controller-shadow/context-dataset.ts";
import type { ContextTrialEvent } from "../../src/lab/context-trial.ts";

function event(): ContextTrialEvent {
  return {
    phase: "outcome",
    sample: {
      schemaVersion: 1,
      decisionId: "d1",
      taskId: "t1",
      sessionId: "s",
      taskFrameId: "f",
      acceptanceVersion: "a",
      featureVersion: "v",
      policyVersion: "p",
      origin: "benchmark",
      mode: "executed",
      decidedAt: 0,
      features: Array(32).fill(0),
      allowed: ["none"],
      selected: "none",
      probability: 1,
      execution: { action: "none", startedAt: 1, endedAt: 2, status: "completed" },
      outcome: {
        taskId: "t1",
        acceptanceVersion: "a",
        windowStart: 1,
        windowEnd: 3,
        recordedAt: 4,
        status: "observed",
        reward: 0,
        evidenceRefs: ["score:1"],
        costs: { tokens: 0, toolCalls: 0, latencyMs: 2 },
      },
    },
  };
}
const build = (events: ContextTrialEvent[]) =>
  buildContextDataset({
    events,
    featureVersion: "v",
    acceptanceVersion: "a",
    origin: "benchmark",
    groupForTask: () => "one-source-conversation",
    verifyEvidence: () => true,
  });

test("research: repeated event delivery is deduplicated and reopening retracts labels", () => {
  const original = event();
  assert.equal(build([original, original]).rows.length, 1);
  const reopened = structuredClone(original);
  reopened.sample.outcome!.status = "reopened";
  assert.equal(build([original, reopened]).rows.length, 0);
  assert.equal(build([original, { ...original, phase: "error" }]).rows.length, 0);
});

test("research: feature, acceptance and origin mismatches do not mix datasets", () => {
  for (const key of ["featureVersion", "acceptanceVersion", "origin"] as const) {
    const input = event();
    if (key === "origin") input.sample.origin = "synthetic";
    else input.sample[key] = "different";
    assert.equal(build([input]).rows.length, 0);
  }
});

test("research: reused decision identity cannot silently change policy or scope", () => {
  const first = event();
  const second = structuredClone(first);
  second.sample.policyVersion = "another";
  assert.throws(() => build([first, second]), /collision/);
});

test("research: different tasks from one conversation never cross splits", () => {
  const first = event();
  const second = structuredClone(first);
  second.sample.decisionId = "d2";
  second.sample.taskId = "t2";
  second.sample.outcome!.taskId = "t2";
  const rows = build([first, second]).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.split, rows[1]!.split);
  assert.equal(rows[0]!.split, contextGroupSplit("one-source-conversation"));
});
