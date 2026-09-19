/**
 * The advice seam: what a suggestion may change, and what it may not.
 *
 * An optional HA or MGR source may rank inside the legal candidate set. It may not widen that set,
 * unlock a dependency, cross a session or branch, replay a score whose inputs are gone, or start a
 * speculative execution. Each case below is one of those refusals, and each is offline: a fixture
 * source plays the adviser, so this proves the seam's rules rather than a model's behaviour.
 *
 * The two cases at the end are the wiring rather than the rules: an admission with no source answers
 * exactly as the rule does, and one with a source can only reorder what the shared rules already
 * made legal.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BoardAdmission,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";
import { nextTask, selectableTasks } from "../../src/integration/ooo-execution.ts";
import {
  orderCandidates,
  revalidateSuggestion,
  type AdviceProjection,
  type Suggestion,
  type SuggestionProvenance,
  type SuggestionSource,
} from "../../src/integration/task-advisers.ts";
import { compileTaskUnits, dispatchTasks } from "../../src/integration/task-semantics.ts";

const SCOPE = {
  sessionId: "session-1",
  branchId: "branch-1",
  parametersVersion: "params-1",
  projectionVersion: "projection-1",
  observationOrder: ["projection-1"],
  initialState: "initial-1",
} as const;

/** What the projection says when the set holds two selectable tasks. */
const projection = (legal: readonly string[]): Omit<AdviceProjection, "legal"> => ({
  ...SCOPE,
  legal: [],
  ready: [...legal],
  accepted: [],
  blocked: {},
});

const provenance = (overrides: Partial<SuggestionProvenance> = {}): SuggestionProvenance => ({
  sourceId: "fixture-adviser",
  kind: "ha",
  ...SCOPE,
  ...overrides,
});

const suggest = (
  taskId: string,
  score: number,
  overrides: Partial<Suggestion> = {},
): Suggestion => ({
  action: "next",
  taskId,
  score,
  provenance: provenance(),
  ...overrides,
});

/** A source that answers with whatever the test hands it. */
const source = (
  id: string,
  suggestions: readonly Suggestion[],
  overrides: Partial<SuggestionSource> = {},
): SuggestionSource => ({
  id,
  kind: "ha",
  suggest: () => suggestions,
  ...overrides,
});

test("a suggestion outside the legal set is refused, however high it scores", () => {
  const outcome = orderCandidates(["A", "B"], projection(["A", "B"]), [
    source("fixture-ha", [suggest("C", 1e9), suggest("B", 0.2)]),
  ]);
  assert.equal(outcome.refusals.length, 1);
  assert.equal(outcome.refusals[0]!.task, "C");
  assert.match(outcome.refusals[0]!.reason, /outside the legal candidate set/u);
  // The set is the input set: a high score buys a different order inside it, never a new member.
  assert.deepEqual([...outcome.order].sort(), ["A", "B"]);
  assert.equal(outcome.order[0], "B");
  assert.deepEqual(
    outcome.adopted.map((entry) => entry.taskId),
    ["B"],
  );
});

test("a soft premise cannot unlock a dependency the shared rules refused", () => {
  const REV = "input-v1";
  const plan: ProbePlan = [
    ["B", REV, [], "isolated-artifact", null, null],
    ["A", REV, ["B"], "isolated-artifact", null, null],
  ];
  const units = compileTaskUnits({ plan, specs: {} });
  assert.ok(units.legal, "the fixture plan is legal");
  const dispatch = dispatchTasks(units.units, {});
  // A depends on B and no artifact has been accepted, so A is not a candidate at all.
  assert.deepEqual(selectableTasks(dispatch), ["B"]);

  const outcome = orderCandidates(["B"], projection(["B"]), [
    source("fixture-mgr", [
      // The premise is the MGR shape the design warns about: a soft gate or a hypothesis that reads
      // as "the dependency is satisfied". Legality was decided before this source was asked.
      suggest("A", 1e9, { assumptions: ["requires: B", "hypothesis: B is satisfied"] }),
    ]),
  ]);
  assert.equal(outcome.refusals.length, 1);
  assert.equal(outcome.refusals[0]!.task, "A");
  assert.match(outcome.refusals[0]!.reason, /outside the legal candidate set/u);
  assert.deepEqual(outcome.order, ["B"]);
  assert.deepEqual(outcome.adopted, []);

  // Control: the same suggestion is adopted once B really is accepted, so the refusal above is
  // about legality and not about the fixture being unable to score anything.
  const accepted = dispatchTasks(units.units, {
    artifacts: { B: "artifact-b" },
    verdicts: { B: { digest: "artifact-b", verdict: "accepted" } },
  });
  assert.deepEqual(selectableTasks(accepted), ["A"]);
});

test("an unmodelled action is refused rather than scored", () => {
  // `fuse` and `prepare` are named in the shared vocabulary and not modelled: a suggestion cannot
  // start speculative execution or merge units into one acceptance by ranking them.
  for (const action of ["fuse", "prepare"]) {
    const outcome = orderCandidates(["A", "B"], projection(["A", "B"]), [
      source("fixture-mgr", [suggest("B", 9, { action })]),
    ]);
    assert.equal(outcome.refusals.length, 1, `${action} is refused`);
    assert.equal(outcome.refusals[0]!.field, "action");
    assert.match(outcome.refusals[0]!.reason, /not a modelled action/u);
    assert.deepEqual(outcome.order, ["A", "B"]);
  }
});

test("a disabled or failing source falls back to the rule policy, and says why", () => {
  const failing: SuggestionSource = {
    id: "fixture-failing",
    kind: "mgr",
    suggest: () => {
      throw new Error("no trained state is available");
    },
  };
  const outcome = orderCandidates(["A", "B"], projection(["A", "B"]), [
    source("fixture-disabled", [suggest("B", 5)], { enabled: false }),
    failing,
    source("fixture-silent", []),
  ]);
  assert.deepEqual(outcome.order, ["A", "B"]); // the rule order, unchanged
  assert.deepEqual(outcome.adopted, []);
  assert.deepEqual(
    outcome.fallbacks.map((entry) => entry.sourceId),
    ["fixture-disabled", "fixture-failing"],
  );
  assert.match(outcome.fallbacks[0]!.reason, /disabled/u);
  assert.match(outcome.fallbacks[1]!.reason, /failed: no trained state is available/u);
});

test("a score from another session or branch is not reused", () => {
  const otherSession = orderCandidates(["A", "B"], projection(["A", "B"]), [
    source("fixture-ha", [suggest("B", 9, { provenance: provenance({ sessionId: "session-2" }) })]),
  ]);
  assert.equal(otherSession.refusals.length, 1);
  assert.match(otherSession.refusals[0]!.reason, /not reused in session-1\/branch-1/u);
  const otherBranch = orderCandidates(["A", "B"], projection(["A", "B"]), [
    source("fixture-ha", [suggest("B", 9, { provenance: provenance({ branchId: "branch-2" }) })]),
  ]);
  assert.match(otherBranch.refusals[0]!.reason, /session-1\/branch-1/u);
});

test("a changed parameter or projection version makes an old score a new one", () => {
  const changedParameters = orderCandidates(["A", "B"], projection(["A", "B"]), [
    source("fixture-ha", [
      suggest("B", 9, { provenance: provenance({ parametersVersion: "params-2" }) }),
    ]),
  ]);
  assert.deepEqual(changedParameters.rescored, [
    { sourceId: "fixture-ha", taskId: "B", missing: ["parametersVersion=params-2"] },
  ]);
  // Not adopted: a score about different parameters cannot order the current set.
  assert.deepEqual(changedParameters.order, ["A", "B"]);
  const changedProjection = orderCandidates(["A", "B"], projection(["A", "B"]), [
    source("fixture-ha", [
      suggest("B", 9, { provenance: provenance({ projectionVersion: "projection-2" }) }),
    ]),
  ]);
  assert.deepEqual(changedProjection.rescored[0]!.missing, ["projectionVersion=projection-2"]);
});

test("a score that cannot name its own history is re-scored, never reported as a reproduction", () => {
  const outcome = orderCandidates(["A", "B"], projection(["A", "B"]), [
    source("fixture-ha", [
      suggest("B", 9, {
        provenance: provenance({ observationOrder: undefined, initialState: undefined }),
      }),
    ]),
  ]);
  assert.deepEqual(outcome.rescored, [
    { sourceId: "fixture-ha", taskId: "B", missing: ["observationOrder", "initialState"] },
  ]);
  assert.deepEqual(outcome.adopted, []);
  assert.deepEqual(outcome.order, ["A", "B"]);
  // A different observation order is the same kind of answer: the old reading was taken elsewhere.
  const reordered = orderCandidates(["A", "B"], projection(["A", "B"]), [
    source("fixture-ha", [
      suggest("B", 9, { provenance: provenance({ observationOrder: ["projection-0"] }) }),
    ]),
  ]);
  assert.deepEqual(reordered.rescored[0]!.missing, ["observationOrder=projection-0"]);
});

test("the ordering is a permutation of the legal set, and the rule order is the default", () => {
  assert.deepEqual(orderCandidates(["A", "B", "C"], projection(["A", "B", "C"])).order, [
    "A",
    "B",
    "C",
  ]);
  const tied = orderCandidates(["A", "B", "C"], projection(["A", "B", "C"]), [
    source("fixture-ha", [suggest("C", 1), suggest("B", 1)]),
  ]);
  // Equal scores keep the rule order, so a source cannot shuffle by enumeration.
  assert.deepEqual(tied.order, ["B", "C", "A"]);
  assert.deepEqual([...tied.order].sort(), ["A", "B", "C"]);
});

test("an adopted ranking is re-checked where the write happens", () => {
  assert.equal(revalidateSuggestion({ sourceId: "fixture-ha", taskId: "A" }, ["A", "B"]), null);
  const refused = revalidateSuggestion({ sourceId: "fixture-ha", taskId: "A" }, ["B"]);
  assert.equal(refused?.task, "A");
  assert.match(refused!.reason, /no longer a legal candidate/u);
  assert.match(refused!.reason, /not a write licence/u);
});

const REV = "input-v1";
/** Two independent tasks: both are legal candidates at once, and the rule policy picks the first. */
const parallelPlan: ProbePlan = [
  ["A", REV, [], "isolated-artifact", null, null],
  ["B", REV, [], "isolated-artifact", null, null],
];

const spec = (instruction: string, path: string): PatchTaskSpec => ({
  instruction,
  files: { [path]: "export const a = 1;\n" },
  editable: [path],
  verify: async () => "accept" as const,
});

const SPECS: Readonly<Record<string, PatchTaskSpec>> = {
  A: spec("A works.", "src/a.ts"),
  B: spec("B works.", "src/b.ts"),
};

const open = (advisers?: readonly SuggestionSource[]) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-advisers-"));
  return new BoardAdmission(
    join(directory, "round.sqlite"),
    parallelPlan,
    SPECS,
    advisers
      ? { runId: "run-advised", advisers, adviceScope: { ...SCOPE } }
      : { runId: "run-plain" },
  );
};

/** Ranks `taskId` first when the shared rules made it legal, and says nothing otherwise. */
const prefer = (taskId: string, score = 1): SuggestionSource => ({
  id: "fixture-adviser",
  kind: "ha",
  suggest: (view) =>
    view.legal.includes(taskId)
      ? [{ action: "next", taskId, score, provenance: provenance() }]
      : [],
});

test("the round's own answer is the shared rule's answer, not an ordering's", () => {
  const units = compileTaskUnits({ plan: parallelPlan, specs: SPECS });
  assert.ok(units.legal, "the fixture plan is legal");
  const dispatch = dispatchTasks(units.units, {});
  assert.equal(nextTask(dispatch), "A", "the rule policy picks the head");
  assert.equal(selectableTasks(dispatch)[0], nextTask(dispatch));
  assert.equal(open().next(), nextTask(dispatch), "the round asks the shared rule");

  // The head rule is a legality condition, and an ordering must not skip it: A's input has drifted,
  // which is not an external wait, so nothing is selectable even though B alone would be.
  const stale = dispatchTasks(units.units, {
    revisions: { A: "other" },
    sourceRevisions: { A: REV },
  });
  assert.deepEqual(selectableTasks(stale), [], "a head blocked by a stale input is not skipped");
  assert.equal(nextTask(stale), null);
});

test("an admission with no source answers exactly as the rule does, and a source only reorders", () => {
  const plain = open();
  assert.equal(plain.next(), "A", "the rule policy picks the first legal candidate");
  assert.equal(plain.lastAdviceOutcome(), null, "no source means no advice to record");

  const advised = open([prefer("B")]);
  assert.equal(advised.next(), "B", "a source reorders inside the legal set");
  assert.deepEqual(advised.lastAdviceOutcome()?.adopted, [
    { sourceId: "fixture-adviser", taskId: "B", score: 1 },
  ]);
  assert.deepEqual(advised.lastAdviceOutcome()?.refusals, []);

  // The same admission with a source that ranks a task nobody made legal: the rule answer stands.
  const refused = open([prefer("Z")]);
  assert.equal(refused.next(), "A");
  assert.equal(refused.lastAdviceOutcome()?.adopted.length, 0);
  assert.deepEqual(refused.lastAdviceOutcome()?.refusals, []);
  assert.deepEqual(refused.lastAdviceOutcome()?.order, ["A", "B"]);

  // The claim-side check the design names: the ranking is not a write licence.
  assert.equal(advised.refuseStaleRanking("B", ["A", "B"]), null);
  assert.match(advised.refuseStaleRanking("B", ["A"])!.reason, /no longer a legal candidate/u);
});
