import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextOutcomeFromFeedback,
  contextUseReward,
  INJECTION_ACTIONS,
  type ContextRecallOutcome,
} from "../../src/lab/context-reward.ts";
import { CONTEXT_ACTIONS } from "../../src/lab/context-router.ts";

const ABSTAIN_ACTIONS = CONTEXT_ACTIONS.filter((a) => !INJECTION_ACTIONS.has(a));
const OUTCOMES: readonly ContextRecallOutcome[] = [
  "verified",
  "correctAbstain",
  "insufficient",
  "rejected",
  "falsePositive",
];

test("every (outcome, action) reward stays inside the [-1, 1] envelope", () => {
  for (const outcome of OUTCOMES) {
    const action = outcome === "correctAbstain" ? "none" : "retrieve";
    const reward = contextUseReward(outcome, action as "none" | "retrieve");
    assert.ok(reward >= -1 && reward <= 1, `${outcome}/${action} -> ${reward}`);
  }
});

test("RSCB invariant: false positive is the worst outcome", () => {
  const fp = contextUseReward("falsePositive", "retrieve");
  for (const outcome of OUTCOMES) {
    if (outcome === "falsePositive") continue;
    const action =
      outcome === "correctAbstain" ? "none" : ("retrieve" as const);
    assert.ok(
      fp < contextUseReward(outcome, action),
      `falsePositive (${fp}) should beat ${outcome} (${contextUseReward(outcome, action)})`,
    );
  }
});

test("beneficial reuse beats a correct abstention (alpha > kappa > 0)", () => {
  const verified = contextUseReward("verified", "retrieve");
  const abstain = contextUseReward("correctAbstain", "none");
  assert.ok(verified > abstain && abstain > 0);
});

test("harmful > insufficient > rejected in penalty (gamma > iota > delta)", () => {
  const fp = contextUseReward("falsePositive", "retrieve");
  const insufficient = contextUseReward("insufficient", "retrieve");
  const rejected = contextUseReward("rejected", "retrieve");
  assert.ok(fp < insufficient && insufficient < rejected && rejected < 0);
});

test("injection-only outcomes reject abstain actions", () => {
  for (const outcome of ["verified", "rejected", "falsePositive"] as const) {
    for (const action of ABSTAIN_ACTIONS) {
      assert.throws(() => contextUseReward(outcome, action), /injection action/);
    }
  }
});

test("correctAbstain rejects injection actions", () => {
  for (const action of [...INJECTION_ACTIONS]) {
    assert.throws(() => contextUseReward("correctAbstain", action), /abstain action/);
  }
});

test("insufficient is allowed for any action (memory was needed regardless)", () => {
  for (const action of CONTEXT_ACTIONS) {
    const reward = contextUseReward("insufficient", action);
    assert.ok(reward < 0 && reward >= -1);
  }
});

test("feedback labels map to RSCB outcomes with a stable priority", () => {
  assert.equal(
    contextOutcomeFromFeedback({ memoryMisleading: true, evidenceSufficient: true }),
    "falsePositive",
  );
  assert.equal(
    contextOutcomeFromFeedback({ noMemoryNeeded: true, evidenceSufficient: true }),
    "rejected",
  );
  assert.equal(contextOutcomeFromFeedback({ evidenceSufficient: false }), "insufficient");
  assert.equal(
    contextOutcomeFromFeedback({ evidenceSufficient: true, expansionUseful: true }),
    "verified",
  );
  assert.equal(
    contextOutcomeFromFeedback({ evidenceSufficient: true, taskSuccess: true }),
    "verified",
  );
  assert.equal(contextOutcomeFromFeedback({ excessiveNoise: true }), "rejected");
});

test("feedback labels with no usable signal map to null, never a silent vote", () => {
  assert.equal(contextOutcomeFromFeedback({}), null);
  assert.equal(contextOutcomeFromFeedback({ taskSuccess: false }), null);
  assert.equal(contextOutcomeFromFeedback({ evidenceSufficient: true }), null);
  assert.equal(contextOutcomeFromFeedback({ taskSuccess: false, expansionUseful: false }), null);
});

test("feedback-mapped outcome feeds the RSCB reward for the executed action", () => {
  const outcome = contextOutcomeFromFeedback({ evidenceSufficient: true, taskSuccess: true });
  assert.equal(outcome, "verified");
  assert.equal(contextUseReward(outcome!, "retrieve"), 0.6);
  const fp = contextOutcomeFromFeedback({ memoryMisleading: true });
  assert.equal(fp, "falsePositive");
  assert.equal(contextUseReward(fp!, "resurface"), -1);
});
