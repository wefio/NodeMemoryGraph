import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeContextFeatures, withoutContextHistory } from "../../src/lab/context-features.ts";
import { CONTEXT_CUE, executeContextAction } from "../../src/lab/context-executor.ts";
import { runContextTrial, type ContextTrialEvent } from "../../src/lab/context-trial.ts";
import type { ContextIntervention } from "../../src/lab/context-intervention.ts";

const executor = () => ({
  authorized: true,
  maxChars: 100,
  remainingToolCalls: 1,
  evidence: [{ id: "e1", text: "known evidence" }],
  signal: new AbortController().signal,
  retrieve: async () => [{ id: "e2", text: "new evidence" }],
});
const decision = (): ContextIntervention => ({
  schemaVersion: 1,
  decisionId: "d",
  taskId: "t",
  sessionId: "s",
  taskFrameId: "f",
  acceptanceVersion: "a",
  featureVersion: "context-features-v1",
  policyVersion: "fixed-v1",
  origin: "synthetic",
  mode: "executed",
  decidedAt: 0,
  features: encodeContextFeatures({}),
  allowed: ["none", "cue", "resurface", "retrieve"],
  selected: "retrieve",
  probability: 0.25,
});

test("contract: feature v1 distinguishes missing from zero and ablates all history", () => {
  const features = encodeContextFeatures({
    contextOccupancy: 0,
    candidateCount: 64,
    previousReward: -1,
  });
  assert.equal(features.length, 32);
  assert.equal(features[16], 0);
  assert.equal(features[17], 1);
  assert.equal(features[5], 1);
  assert.equal(features[15], -1);
  const ablated = withoutContextHistory(features);
  assert.equal(ablated[15], 0);
  assert.equal(ablated[31], 1);
  assert.equal(features[15], -1);
  assert.throws(() => encodeContextFeatures({ contextOccupancy: NaN }));
  assert.throws(() => encodeContextFeatures({ remainingToolRatio: -1 }));
});

test("safety: four fixed actions enforce authority, whole evidence and hard budgets", async () => {
  const base = executor();
  assert.equal(
    (await executeContextAction({ ...base, action: "none", authorized: false })).text,
    "",
  );
  assert.equal((await executeContextAction({ ...base, action: "cue" })).text, CONTEXT_CUE);
  assert.equal(
    (await executeContextAction({ ...base, action: "resurface" })).text,
    "known evidence",
  );
  assert.equal((await executeContextAction({ ...base, action: "retrieve" })).text, "new evidence");
  assert.equal(
    (await executeContextAction({ ...base, action: "resurface", maxChars: 1 })).text,
    "",
  );
  await assert.rejects(
    executeContextAction({ ...base, action: "retrieve", remainingToolCalls: 0 }),
  );
  await assert.rejects(executeContextAction({ ...base, action: "cue", authorized: false }));
  await assert.rejects(executeContextAction({ ...base, action: "cue", maxChars: 1 }));
  await assert.rejects(
    executeContextAction({ ...base, action: "retrieve", signal: AbortSignal.abort() }),
  );
});

test("contract: trial records decision before retrieval, then execution and independently admitted outcome", async () => {
  const events: ContextTrialEvent[] = [];
  let time = 1;
  const result = await runContextTrial({
    decision: decision(),
    executor: {
      ...executor(),
      retrieve: async () => {
        assert.equal(events[0]?.phase, "decision");
        return [{ id: "e2", text: "new evidence" }];
      },
    },
    sink: (event) => {
      events.push(event);
    },
    clock: () => time++,
    evaluate: async (output, startedAt) => ({
      taskId: "t",
      acceptanceVersion: "a",
      windowStart: startedAt,
      windowEnd: time++,
      recordedAt: time++,
      status: "observed",
      reward: 1,
      evidenceRefs: output.evidenceIds,
      costs: { tokens: 0, toolCalls: output.toolCalls, latencyMs: 1 },
    }),
    verifyEvidence: (sample) => sample.outcome?.evidenceRefs[0] === "e2",
  });
  assert.equal(result.reason, "admitted");
  assert.deepEqual(
    events.map((event) => event.phase),
    ["decision", "execution", "outcome"],
  );
  assert.equal(events[0]?.sample.execution, undefined);
  assert.equal(events[1]?.sample.outcome, undefined);
});

test("safety: journal failure and malformed decisions prevent side effects", async () => {
  let called = false;
  const options = {
    decision: decision(),
    executor: {
      ...executor(),
      retrieve: async () => {
        called = true;
        return [];
      },
    },
    sink: () => {
      throw new Error("disk full");
    },
    evaluate: async (): Promise<never> => {
      throw new Error("unexpected");
    },
    verifyEvidence: () => true,
  };
  await assert.rejects(runContextTrial(options), /disk full/);
  assert.equal(called, false);
  options.decision.probability = 0;
  await assert.rejects(runContextTrial(options), /invalid trial decision/);
  assert.equal(called, false);
});

test("safety: cancellation during evaluation prevents admission", async () => {
  const controller = new AbortController();
  const events: ContextTrialEvent[] = [];
  let verified = false;
  await assert.rejects(
    runContextTrial({
      decision: decision(),
      executor: { ...executor(), signal: controller.signal },
      sink: (event) => {
        events.push(event);
      },
      evaluate: async (_output, startedAt) => {
        controller.abort(new Error("task cancelled"));
        return {
          taskId: "t",
          acceptanceVersion: "a",
          windowStart: startedAt,
          windowEnd: Date.now(),
          recordedAt: Date.now(),
          status: "observed",
          reward: 1,
          evidenceRefs: ["score:1"],
          costs: { tokens: 0, toolCalls: 1, latencyMs: 1 },
        };
      },
      verifyEvidence: () => {
        verified = true;
        return true;
      },
    }),
    /task cancelled/,
  );
  assert.equal(verified, false);
  assert.equal(events.at(-1)?.phase, "error");
});

test("safety: evaluator failure preserves execution but creates no reward", async () => {
  const events: ContextTrialEvent[] = [];
  await assert.rejects(
    runContextTrial({
      decision: decision(),
      executor: executor(),
      sink: (event) => {
        events.push(event);
      },
      evaluate: async () => {
        throw new Error("judge unavailable");
      },
      verifyEvidence: () => true,
    }),
    /judge unavailable/,
  );
  assert.equal(events.at(-1)?.phase, "error");
  assert.equal(events.at(-1)?.sample.execution?.status, "completed");
  assert.equal(events.at(-1)?.sample.outcome, undefined);
});
