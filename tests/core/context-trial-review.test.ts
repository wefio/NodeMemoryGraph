import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { encodeContextFeatures } from "../../src/lab/context-features.ts";
import {
  executeContextAction,
  type ContextExecutionResult,
} from "../../src/lab/context-executor.ts";
import { runContextTrial, type ContextTrialEvent } from "../../src/lab/context-trial.ts";
import type { ContextIntervention } from "../../src/lab/context-intervention.ts";

function decision(selected: ContextIntervention["selected"] = "retrieve"): ContextIntervention {
  return {
    schemaVersion: 1,
    decisionId: `review-${selected}`,
    taskId: "review-task",
    sessionId: "review-session",
    taskFrameId: "review-frame",
    acceptanceVersion: "review-acceptance-v1",
    featureVersion: "context-features-v1",
    policyVersion: "review-policy-v1",
    origin: "synthetic",
    mode: "executed",
    decidedAt: 0,
    features: encodeContextFeatures({}),
    allowed: ["none", "cue", "resurface", "retrieve"],
    selected,
    probability: 0.25,
  };
}

function executor() {
  return {
    authorized: true,
    maxChars: 100,
    remainingToolCalls: 1,
    evidence: [{ id: "existing", text: "existing evidence" }],
    signal: new AbortController().signal,
    retrieve: async () => [{ id: "fresh", text: "fresh evidence" }],
  };
}

function evaluateResult(
  result: ContextExecutionResult,
  startedAt: number,
): NonNullable<ContextIntervention["outcome"]> {
  return {
    taskId: "review-task",
    acceptanceVersion: "review-acceptance-v1",
    windowStart: startedAt,
    windowEnd: startedAt + 2,
    recordedAt: startedAt + 3,
    status: "observed",
    reward: 0.5,
    evidenceRefs: result.evidenceIds,
    costs: { tokens: result.text.length, toolCalls: result.toolCalls, latencyMs: 1 },
  };
}

test("safety: resurface requires authorization like every other non-none action", async () => {
  await assert.rejects(
    executeContextAction({
      ...executor(),
      action: "resurface",
      authorized: false,
    }),
    /not authorized/,
  );
});

test("contract: an async decision journal settles before retrieval can start", async () => {
  let releaseDecision!: () => void;
  const decisionFlushed = new Promise<void>((resolve) => {
    releaseDecision = resolve;
  });
  let retrieved = false;
  const events: ContextTrialEvent[] = [];
  const trial = runContextTrial({
    decision: decision(),
    executor: {
      ...executor(),
      retrieve: async () => {
        retrieved = true;
        return [{ id: "fresh", text: "fresh evidence" }];
      },
    },
    sink: async (event) => {
      events.push(event);
      if (event.phase === "decision") await decisionFlushed;
    },
    evaluate: async (result, startedAt) => evaluateResult(result, startedAt),
    verifyEvidence: (sample, result) => sample.outcome?.evidenceRefs[0] === result.evidenceIds[0],
    clock: () => 1,
  });

  assert.equal(retrieved, false);
  releaseDecision();
  assert.equal((await trial).reason, "admitted");
  assert.deepEqual(
    events.map((event) => event.phase),
    ["decision", "execution", "outcome"],
  );
});

test("safety: an async decision-journal rejection prevents side effects", async () => {
  let retrieved = false;
  await assert.rejects(
    runContextTrial({
      decision: decision(),
      executor: {
        ...executor(),
        retrieve: async () => {
          retrieved = true;
          return [];
        },
      },
      sink: async () => {
        await Promise.resolve();
        throw new Error("journal unavailable");
      },
      evaluate: async (result, startedAt) => evaluateResult(result, startedAt),
      verifyEvidence: () => true,
    }),
    /journal unavailable/,
  );
  assert.equal(retrieved, false);
});

test("safety: execution-journal rejection prevents evaluation", async () => {
  let evaluated = false;
  const phases: string[] = [];
  await assert.rejects(
    runContextTrial({
      decision: decision(),
      executor: executor(),
      sink: async (event) => {
        phases.push(event.phase);
        if (event.phase === "execution") throw new Error("execution journal unavailable");
      },
      evaluate: async (result, startedAt) => {
        evaluated = true;
        return evaluateResult(result, startedAt);
      },
      verifyEvidence: () => true,
    }),
    /execution journal unavailable/,
  );
  assert.equal(evaluated, false);
  assert.deepEqual(phases, ["decision", "execution"]);
});

test("contract: execution receipt binds the admitted sample to the actual result", async () => {
  const events: ContextTrialEvent[] = [];
  let verifiedResult: Readonly<ContextExecutionResult> | undefined;
  const result = await runContextTrial({
    decision: decision(),
    executor: executor(),
    sink: (event) => {
      events.push(event);
    },
    evaluate: async (output, startedAt) => evaluateResult(output, startedAt),
    verifyEvidence: (sample, actual) => {
      verifiedResult = actual;
      return sample.outcome?.evidenceRefs[0] === "fresh";
    },
    clock: () => 1,
  });
  assert.equal(result.reason, "admitted");
  assert.deepEqual(verifiedResult, {
    action: "retrieve",
    text: "fresh evidence",
    evidenceIds: ["fresh"],
    toolCalls: 1,
  });
  assert.deepEqual(events[1]?.sample.execution?.result, {
    contentHash: createHash("sha256").update("fresh evidence").digest("hex"),
    evidenceIds: ["fresh"],
    characters: "fresh evidence".length,
    toolCalls: 1,
  });
});

test("safety: evaluator result mutation cannot forge verification or the execution receipt", async () => {
  const expected: ContextExecutionResult = {
    action: "retrieve",
    text: "fresh evidence",
    evidenceIds: ["fresh"],
    toolCalls: 1,
  };
  const events: ContextTrialEvent[] = [];
  let evaluatorResult: ContextExecutionResult | undefined;
  const result = await runContextTrial({
    decision: decision(),
    executor: executor(),
    sink: (event) => {
      events.push(event);
    },
    evaluate: async (received, startedAt) => {
      evaluatorResult = received;
      received.text = "tampered";
      received.evidenceIds.splice(0, received.evidenceIds.length, "forged");
      received.toolCalls = 99;
      return evaluateResult(received, startedAt);
    },
    verifyEvidence: (sample, actual) => {
      assert.deepEqual(actual, expected);
      assert.deepEqual(sample.execution?.result, {
        contentHash: createHash("sha256").update(expected.text).digest("hex"),
        evidenceIds: expected.evidenceIds,
        characters: expected.text.length,
        toolCalls: expected.toolCalls,
      });
      return sample.outcome?.evidenceRefs[0] === "forged";
    },
    clock: () => 1,
  });
  assert.equal(result.reason, "admitted");
  assert.deepEqual(evaluatorResult, {
    action: "retrieve",
    text: "tampered",
    evidenceIds: ["forged"],
    toolCalls: 99,
  });
  assert.deepEqual(events[1]?.sample.execution?.result, {
    contentHash: createHash("sha256").update(expected.text).digest("hex"),
    evidenceIds: expected.evidenceIds,
    characters: expected.text.length,
    toolCalls: expected.toolCalls,
  });
});

test("safety: an outcome claiming fewer tool calls than execution is not admitted", async () => {
  const result = await runContextTrial({
    decision: decision(),
    executor: executor(),
    sink: () => undefined,
    evaluate: async (output, startedAt) => ({
      ...evaluateResult(output, startedAt),
      costs: { tokens: 0, toolCalls: 0, latencyMs: 1 },
    }),
    verifyEvidence: () => true,
    clock: () => 1,
  });
  assert.equal(result.reason, "invalid-outcome");
  assert.equal(result.sample, undefined);
});

test("contract: timeout execution is recorded as timeout and cannot become a label", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("deadline", "TimeoutError"));
  const events: ContextTrialEvent[] = [];
  await assert.rejects(
    runContextTrial({
      decision: decision(),
      executor: { ...executor(), signal: controller.signal },
      sink: (event) => {
        events.push(event);
      },
      evaluate: async (result, startedAt) => evaluateResult(result, startedAt),
      verifyEvidence: () => true,
      clock: () => 1,
    }),
  );
  assert.equal(events.at(-1)?.phase, "error");
  assert.equal(events.at(-1)?.sample.execution?.status, "timeout");
  assert.equal(events.at(-1)?.sample.outcome, undefined);
});
