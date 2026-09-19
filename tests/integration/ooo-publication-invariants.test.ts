/**
 * The design's last offline acceptance, in two directions.
 *
 * The clean direction: over every legal interleaving of the design's script sets, no publication the
 * derived view allows is unsupported by the facts the interleaving recorded - no completion whose
 * verdict judged other bytes, no completion resting on a missing, drifted, cancelled or unverified
 * input, no dispatch whose inputs are not closed.
 *
 * The other direction is the one that makes the first mean anything: each condition is deleted from
 * the checker by a mutant in `tools/mutation-teeth.ts`, and the case below that names it must fail.
 * A checker whose conditions cannot be broken is a description, not a check.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DESIGN_PLAN,
  DESIGN_SCRIPT_SETS,
  MAX_INTERLEAVING_EVENTS,
  MAX_INTERLEAVING_UNITS,
  checkBudget,
  checkPublications,
  enumerateInterleavings,
  enumerateTable,
  type InterleavingEventKind,
  type UnitScript,
} from "../../src/integration/task-semantics-interleavings.ts";
import {
  compileTaskUnits,
  deriveStatus,
  type RecordedFacts,
} from "../../src/integration/task-semantics.ts";
import { nextTask, type DispatchTask } from "../../src/integration/ooo-execution.ts";
import type { PatchTaskSpec } from "../../src/integration/ooo-board.ts";

const spec = (): PatchTaskSpec => ({
  instruction: "Rename byId to planIndex in nextTask only.",
  files: { "src/integration/ooo-execution.ts": "export const planIndex = 1;\n" },
  editable: ["src/integration/ooo-execution.ts"],
  verify: async () => "accept",
});

const compiled = compileTaskUnits({ plan: DESIGN_PLAN, specs: { P: spec() } });
const factsWith = (overrides: Partial<RecordedFacts>): RecordedFacts => ({
  artifacts: {},
  verdicts: {},
  revisions: {},
  sourceRevisions: {},
  cancellations: [],
  ...overrides,
});

test("no publication over the design's interleavings is unsupported by its own facts", () => {
  const report = enumerateTable({
    plan: DESIGN_PLAN,
    specs: { P: spec() },
    sets: DESIGN_SCRIPT_SETS,
  });
  assert.equal(report.refused, undefined);
  // The enumeration is non-vacuous: it really walked the merges, and the sets really publish things.
  assert.equal(report.sets, DESIGN_SCRIPT_SETS.length);
  assert.ok(report.interleavings > 20, `expected many interleavings, got ${report.interleavings}`);
  assert.ok(report.completions > 0, "some interleaving publishes a completed unit");
  assert.ok(report.dispatches > 0, "some interleaving dispatches the dependent");
  assert.deepEqual(
    report.findings.map(
      (finding) => `${finding.publication}:${finding.unit}:${finding.obligation}`,
    ),
    [],
    "every publication is supported by the recorded facts",
  );
  assert.deepEqual(
    report.budgetFindings.map(
      (finding) => `${finding.property}:${finding.budget}:${finding.unit}`,
    ),
    [],
    "every declared budget published a view its own budget allows",
  );
  assert.deepEqual(report.budgets, [1, 2], "the design's shapes are walked at one slot and at two");
});

test("a declared budget publishes more than one slot can, and never a claimed task", () => {
  // Two independent units plus a dependent: the second slot is what a one-slot run cannot offer.
  const wide: CompileInput["plan"] = [
    ["P", "rev-1", [], "isolated-artifact", null, null],
    ["Q", "rev-1", [], "isolated-artifact", null, null],
    ["D", "rev-1", ["P"], "read-only", null, null],
  ];
  const scripts: readonly UnitScript[] = [
    { unit: "P", events: ["claim"] },
    { unit: "Q", events: ["deliver", "judge-accept"] },
  ];
  const report = enumerateInterleavings({ plan: wide, specs: { P: spec() }, scripts });
  assert.equal(report.refused, undefined);
  assert.deepEqual(report.budgetFindings, [], "no budget offered a claimed task or dropped a candidate");
  assert.ok(
    report.widened > 0,
    "the two-slot view published a task the one-slot view did not, which is what the budget buys",
  );
  assert.deepEqual(
    report.findings.map((finding) => `${finding.unit}:${finding.obligation}`),
    [],
    "and what it published is still supported by the recorded facts",
  );
  // The claimed unit is never one of them: at the prefix where P is claimed, only Q is on offer.
  const oneSlot = enumerateInterleavings({
    plan: wide,
    specs: { P: spec() },
    scripts,
    budgets: [1],
  });
  assert.equal(oneSlot.widened, 0, "a single budget has nothing to widen against");
  assert.ok(report.dispatches > oneSlot.dispatches, "the second budget really published something");
});

test("the budget properties fire on a hand-built view, so deleting them cannot pass quietly", () => {
  const claimed = checkBudget({ budget: 2, ready: ["P", "Q"], claimed: ["P"], atStep: 3 });
  assert.deepEqual(
    claimed.map((finding) => `${finding.property}:${finding.unit}:${finding.atStep}`),
    ["claimed-task-is-not-startable:P:3"],
    "a claimed task in the startable set is the property a second worker would break",
  );
  const dropped = checkBudget({ budget: 2, ready: [], claimed: [], smallerReady: ["Q"] });
  assert.deepEqual(
    dropped.map((finding) => `${finding.property}:${finding.unit}`),
    ["a-bigger-budget-keeps-the-smaller-candidates:Q"],
    "a bigger budget adds candidates, it does not replace them",
  );
  assert.deepEqual(checkBudget({ budget: 2, ready: ["Q"], claimed: ["P"], smallerReady: [] }), []);
  const refused = enumerateInterleavings({ plan: DESIGN_PLAN, specs: { P: spec() }, scripts: [], budgets: [0] });
  assert.match(refused.refused!, /budget 0 is not a positive integer/);
});

test("the merge enumerates every legal order, not one of them", () => {
  // P has three events in this order and D two: the merges are the multinomial 5!/(3!2!) = 10.
  const report = enumerateInterleavings({
    plan: DESIGN_PLAN,
    specs: { P: spec() },
    scripts: [
      { unit: "P", events: ["deliver", "judge-accept", "redeliver"] },
      { unit: "D", events: ["deliver", "judge-accept"] },
    ],
  });
  assert.equal(report.refused, undefined);
  assert.equal(report.interleavings, 10);
  assert.equal(report.steps, 10 * 5, "every prefix of every interleaving is checked");
});

test("the enumeration refuses what it cannot bound, rather than growing", () => {
  const many = [
    ["P", "rev-1", [], "isolated-artifact", null, null],
    ["Q", "rev-1", [], "isolated-artifact", null, null],
    ["R", "rev-1", [], "isolated-artifact", null, null],
    ["S", "rev-1", [], "isolated-artifact", null, null],
    ["T", "rev-1", [], "isolated-artifact", null, null],
  ] as const;
  const over = enumerateInterleavings({
    plan: [...many],
    specs: { P: spec() },
    scripts: [{ unit: "P", events: ["deliver"] }],
  });
  assert.match(over.refused!, new RegExp(`cap of ${MAX_INTERLEAVING_UNITS}`));

  const tooManyEvents = enumerateInterleavings({
    plan: DESIGN_PLAN,
    specs: { P: spec() },
    scripts: [
      { unit: "P", events: ["deliver", "judge-accept", "redeliver", "revision-drift"] },
      { unit: "D", events: ["deliver", "judge-accept", "redeliver"] },
    ],
  });
  assert.match(tooManyEvents.refused!, new RegExp(`cap of ${MAX_INTERLEAVING_EVENTS}`));

  const twoScripts = enumerateInterleavings({
    plan: DESIGN_PLAN,
    specs: { P: spec() },
    scripts: [
      { unit: "P", events: ["deliver"] },
      { unit: "P", events: ["judge-accept"] },
    ],
  });
  assert.match(twoScripts.refused!, /two scripts/);

  const unknown = enumerateInterleavings({
    plan: DESIGN_PLAN,
    specs: { P: spec() },
    scripts: [{ unit: "Z", events: ["deliver"] }],
  });
  assert.match(unknown.refused!, /names a unit the plan does not have/);
});

/**
 * One case per condition in the checker. Each is a fact set a run can really record, and what the
 * checker has to say about publishing it.
 */
const violationCases: ReadonlyArray<{
  name: string;
  facts: RecordedFacts;
  publications: { dispatches?: readonly string[]; completions?: readonly string[] };
  obligation: string;
  publication: "dispatch" | "completion";
}> = [
  {
    name: "a completion with no verdict",
    facts: factsWith({ artifacts: { P: "P-artifact-v0" } }),
    publications: { completions: ["P"] },
    obligation: "explicit-acceptance",
    publication: "completion",
  },
  {
    name: "a completion whose verdict judged other bytes",
    facts: factsWith({
      artifacts: { P: "P-artifact-v0" },
      verdicts: { P: { digest: "P-artifact-v1", verdict: "accepted" } },
    }),
    publications: { completions: ["P"] },
    obligation: "explicit-acceptance",
    publication: "completion",
  },
  {
    name: "a completion with no bytes",
    facts: factsWith({ verdicts: { P: { digest: "P-artifact-v0", verdict: "accepted" } } }),
    publications: { completions: ["P"] },
    obligation: "artifact-handoff",
    publication: "completion",
  },
  {
    name: "a completion of a cancelled unit",
    facts: factsWith({
      artifacts: { P: "P-artifact-v0" },
      verdicts: { P: { digest: "P-artifact-v0", verdict: "accepted" } },
      cancellations: ["P"],
    }),
    publications: { completions: ["P"] },
    obligation: "stoppable-voidable",
    publication: "completion",
  },
  {
    name: "a completion resting on a cancelled input",
    facts: factsWith({
      artifacts: { P: "P-artifact-v0", D: "D-artifact-v0" },
      verdicts: {
        P: { digest: "P-artifact-v0", verdict: "accepted" },
        D: { digest: "D-artifact-v0", verdict: "accepted" },
      },
      cancellations: ["P"],
    }),
    publications: { completions: ["D"] },
    obligation: "stoppable-voidable",
    publication: "completion",
  },
  {
    name: "a completion resting on an input that has no bytes",
    facts: factsWith({
      artifacts: { D: "D-artifact-v0" },
      verdicts: { D: { digest: "D-artifact-v0", verdict: "accepted" } },
    }),
    publications: { completions: ["D"] },
    obligation: "input-closure",
    publication: "completion",
  },
  {
    name: "a completion resting on an input that drifted",
    facts: factsWith({
      artifacts: { P: "P-artifact-v0", D: "D-artifact-v0" },
      verdicts: {
        P: { digest: "P-artifact-v0", verdict: "accepted" },
        D: { digest: "D-artifact-v0", verdict: "accepted" },
      },
      revisions: { P: "rev-1" },
      sourceRevisions: { P: "rev-2" },
    }),
    publications: { completions: ["D"] },
    obligation: "input-closure",
    publication: "completion",
  },
  {
    name: "a completion resting on an input whose verdict is stale",
    facts: factsWith({
      artifacts: { P: "P-artifact-v1", D: "D-artifact-v0" },
      verdicts: {
        P: { digest: "P-artifact-v0", verdict: "accepted" },
        D: { digest: "D-artifact-v0", verdict: "accepted" },
      },
    }),
    publications: { completions: ["D"] },
    obligation: "input-closure",
    publication: "completion",
  },
  {
    name: "a dispatch whose input is not accepted",
    facts: factsWith({
      artifacts: { P: "P-artifact-v0" },
      verdicts: { P: { digest: "P-artifact-v0", verdict: "rejected" } },
    }),
    publications: { dispatches: ["D"] },
    obligation: "input-closure",
    publication: "dispatch",
  },
  {
    name: "a dispatch whose input has no bytes",
    facts: factsWith({}),
    publications: { dispatches: ["D"] },
    obligation: "input-closure",
    publication: "dispatch",
  },
  {
    name: "a dispatch of a cancelled unit",
    facts: factsWith({ cancellations: ["D"] }),
    publications: { dispatches: ["D"] },
    obligation: "stoppable-voidable",
    publication: "dispatch",
  },
];

for (const testCase of violationCases) {
  test(`the checker reports ${testCase.name}`, () => {
    const violations = checkPublications(compiled.units, testCase.facts, testCase.publications, 3);
    const match = violations.find(
      (violation) =>
        violation.obligation === testCase.obligation &&
        violation.publication === testCase.publication,
    );
    assert.ok(
      match,
      `expected ${testCase.obligation} on a ${testCase.publication}; got ${JSON.stringify(violations)}`,
    );
    assert.equal(match.atStep, 3, "the finding says which prefix it was published at");
  });
}

test("the checker accepts what the interleavings actually record", () => {
  // The mirror of the cases above: the same shapes, recorded in an order that supports them.
  const facts = factsWith({
    artifacts: { P: "P-artifact-v0", D: "D-artifact-v0" },
    verdicts: {
      P: { digest: "P-artifact-v0", verdict: "accepted" },
      D: { digest: "D-artifact-v0", verdict: "accepted" },
    },
    revisions: { P: "rev-1", D: "rev-1" },
    sourceRevisions: { P: "rev-1", D: "rev-1" },
    externalReady: [],
    claimed: ["D"],
  });
  assert.deepEqual(
    checkPublications(compiled.units, facts, { dispatches: ["D"], completions: ["P", "D"] }),
    [],
    "a cancelled-free, current, verdict-bound record publishes cleanly",
  );
});

test("a cancelled task is not dispatched, and nothing reads one as a closed input", () => {
  // The enumerator above found this: acceptance already refused a cancelled task, while the
  // eligibility rule could not see the cancellation at all, so a cancelled task stayed selectable.
  const cancelledDependency = factsWith({ cancellations: ["P"] });
  assert.deepEqual(
    deriveStatus(compiled.units, cancelledDependency).ready,
    [],
    "a cancelled unit is not handed out",
  );
  const dependencyAccepted = factsWith({
    artifacts: { P: "P-artifact-v0" },
    verdicts: { P: { digest: "P-artifact-v0", verdict: "accepted" } },
    revisions: { P: "rev-1" },
    sourceRevisions: { P: "rev-1" },
    cancellations: ["P"],
  });
  assert.deepEqual(
    deriveStatus(compiled.units, dependencyAccepted).ready,
    [],
    "a cancelled input is not a closed input, even when its bytes carry a verdict",
  );
  const live = factsWith({
    artifacts: { P: "P-artifact-v0" },
    verdicts: { P: { digest: "P-artifact-v0", verdict: "accepted" } },
    revisions: { P: "rev-1" },
    sourceRevisions: { P: "rev-1" },
  });
  assert.deepEqual(deriveStatus(compiled.units, live).ready, ["D"], "the same facts without it do");
});

test("nextTask refuses a task marked cancelled, whatever else the caller set", () => {
  // `dispatchTasks` fills both fields from the same recorded fact, so these states do not arise from
  // it - but eligibility is the public contract of this function, and a caller that builds the
  // dispatch view itself must not get a cancelled task handed out either.
  const task = (id: string, extra: Partial<DispatchTask> = {}): DispatchTask => ({
    id,
    effect: "read-only",
    sourceVersion: "rev-1",
    observedVersion: "rev-1",
    dependencies: [],
    accepted: false,
    claimed: false,
    externalReady: false,
    ...extra,
  });
  assert.equal(
    nextTask([task("A", { cancelled: true })]),
    null,
    "a cancelled task is not selected",
  );
  assert.equal(
    nextTask([task("A", { accepted: true, cancelled: true })]),
    null,
    "not even when the caller also marked it accepted",
  );
  assert.equal(
    nextTask([task("P", { accepted: true, cancelled: true }), task("D", { dependencies: ["P"] })]),
    null,
    "and a cancelled task is not a closed input for a dependent",
  );
  assert.equal(nextTask([task("A")]), "A", "an otherwise identical uncancelled task is selected");
});

test("every event kind the scripts use is one the recorder knows", () => {
  const used = new Set<InterleavingEventKind>(
    DESIGN_SCRIPT_SETS.flatMap((set) => set.flatMap((script) => [...script.events])),
  );
  // A silently ignored kind would make an interleaving cheaper than it is.
  assert.deepEqual([...used].sort(), [
    "cancel",
    "claim",
    "deliver",
    "external-ready",
    "judge-accept",
    "judge-reject",
    "judge-stale-digest",
    "judge-undecidable",
    "redeliver",
    "revision-drift",
  ]);
});
