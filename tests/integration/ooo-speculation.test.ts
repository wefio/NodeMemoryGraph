/**
 * F5: the speculation lifecycle - one declared, finite-valued fact guessed ahead of its evidence, and
 * the three outcomes the design names (true publishes, false discards the candidate and closes its
 * branch session, unknown waits).
 *
 * The rules live in `src/integration/ooo-execution.ts` beside the fusion conditions, because a guessed
 * branch and a fused session answer the same kind of question: what the host may hand out, and what it
 * may keep. Each case below breaks exactly one thing, and the last one pins the rule that joins the two
 * halves - an invalidated branch is not reusable for the real path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isBoundedSpeculation,
  sharedSessionLegal,
  speculationOutcome,
  type DispatchTask,
  type ResolvedPredicate,
  type SessionDeclaration,
  type SessionPlan,
  type SpeculationCandidate,
} from "../../src/integration/ooo-execution.ts";

function candidate(over: Partial<SpeculationCandidate> = {}): SpeculationCandidate {
  return {
    taskId: "prepare",
    assumptions: [{ predicateId: "gate", version: "v1", expected: "true" }],
    speculativeSuccessors: [],
    irreversibleOperations: [],
    ...over,
  };
}

function predicate(over: Partial<ResolvedPredicate> = {}): ResolvedPredicate {
  return { predicateId: "gate", version: "v1", value: "true", authoritative: true, ...over };
}

test("a guess the evidence confirms publishes, and its session stays reusable", () => {
  const decision = speculationOutcome(candidate(), [predicate()]);
  assert.equal(decision.outcome, "publish");
  assert.equal(decision.sessionReusable, true);
  assert.match(decision.reason, /gate/);
});

test("a guess the evidence contradicts is discarded, and its branch session is closed", () => {
  const decision = speculationOutcome(candidate(), [predicate({ value: "false" })]);
  assert.equal(decision.outcome, "discard");
  assert.equal(
    decision.sessionReusable,
    false,
    "the model has already seen the guess: an answer taken from that session is not the real answer",
  );
});

test("no evidence waits: an unknown fact never becomes a silent publish", () => {
  const decision = speculationOutcome(candidate(), []);
  assert.equal(decision.outcome, "wait");
  assert.equal(decision.sessionReusable, true, "waiting ends nothing");
});

test("a reading nobody attested is not evidence", () => {
  const decision = speculationOutcome(candidate(), [predicate({ authoritative: false })]);
  assert.equal(decision.outcome, "wait");
  assert.match(decision.reason, /not authoritative/);
});

test("evidence about another version is not evidence about this fact", () => {
  const decision = speculationOutcome(candidate(), [predicate({ version: "v2" })]);
  assert.equal(decision.outcome, "wait");
  assert.match(decision.reason, /v2/);
});

test("the first experiment allows one pending fact, and a second is refused by name", () => {
  const two = candidate({
    assumptions: [
      { predicateId: "gate", version: "v1", expected: "true" },
      { predicateId: "other", version: "v1", expected: "1" },
    ],
  });
  assert.equal(isBoundedSpeculation(two), false);
  assert.throws(() => speculationOutcome(two, []), /not a bounded speculation candidate/);
});

test("nothing is prepared from the guess: a speculative successor or an irreversible write is refused", () => {
  assert.equal(isBoundedSpeculation(candidate({ speculativeSuccessors: ["after"] })), false);
  assert.equal(isBoundedSpeculation(candidate({ irreversibleOperations: ["publish"] })), false);
});

test("a candidate that guesses nothing is not a speculative candidate at all", () => {
  assert.equal(isBoundedSpeculation(candidate({ assumptions: [] })), false);
});

test("an invalidated branch is not reusable for the real path: fusion refuses the pair", () => {
  const tasks: DispatchTask[] = [
    { ...base("prepare"), accepted: true },
    base("real", { dependencies: ["prepare"] }),
  ];
  const declarations: Record<string, SessionDeclaration> = {
    prepare: { capability: "patch", authority: "host", visible: ["src/a.ts"] },
    real: { capability: "patch", authority: "host", visible: ["src/a.ts"] },
  };
  const plan: SessionPlan = { tasks, declarations };
  assert.equal(
    sharedSessionLegal("prepare", "real", plan),
    true,
    "the pair is legal while the branch is undecided",
  );
  assert.equal(
    sharedSessionLegal("prepare", "real", { ...plan, pendingBranches: ["prepare"] }),
    false,
    "a discarded branch's history may not carry the real path",
  );
});

function base(id: string, over: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id,
    effect: "isolated-artifact",
    sourceVersion: "v1",
    observedVersion: "v1",
    dependencies: [],
    accepted: false,
    claimed: false,
    externalReady: true,
    ...over,
  };
}
