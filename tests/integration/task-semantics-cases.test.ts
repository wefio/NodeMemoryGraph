/**
 * The design's own acceptance cases, executable (docs/design/task-unit-semantics.md,
 * "最小鉴别用例" and the checks that follow it). Each test names the bullet it encodes, so a
 * reader can check the claim instead of trusting a summary.
 *
 * What this file does NOT do is claim coverage of the cases that belong to the round: lease
 * expiry, concurrent claims and crash-window results are asserted in evals/ooo-execution/*.test.ts
 * and tests/core/*, and the experiment record maps every bullet to where it is checked.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  acceptedFact,
  checkRefinement,
  compileTaskUnits,
  deriveStatus,
  isAccepted,
  type CompileInput,
} from "../../src/integration/task-semantics.ts";
import { UNMODELLED_BY_MODEL, compareModes } from "../../src/integration/task-semantics-model.ts";
import type { PatchTaskSpec, ProbePlan } from "../../src/integration/ooo-board.ts";

const verify = async () => "accept" as const;
const file = (path: string) => ({ [path]: `export const x = 1;\n` });
const spec = (path: string, overrides: Partial<PatchTaskSpec> = {}): PatchTaskSpec => ({
  instruction: `Edit ${path}.`,
  files: file(path),
  editable: [path],
  verify,
  ...overrides,
});

/** P and T are independent; J joins both. The shape the first case is about. */
const join: ProbePlan = [
  ["P", "1", [], "isolated-artifact", null, null],
  ["T", "1", [], "isolated-artifact", null, null],
  ["J", "1", ["P", "T"], "read-only", null, null],
];
const joinInput = (overrides: Partial<CompileInput> = {}): CompileInput => ({
  plan: join,
  specs: { P: spec("a.ts"), T: spec("b.ts") },
  ...overrides,
});

test("case 1: a join waits for every dependency, and concurrent candidates never merge themselves", () => {
  const facts = (outcomes: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(outcomes).map(([id, verdict]) => [
        id,
        { digest: `digest-${id}`, verdict: verdict as "accepted" | "undecidable" },
      ]),
    );
  const artifacts = { P: "digest-P", T: "digest-T" };
  const partial = deriveStatus(compileTaskUnits(joinInput()).units, {
    artifacts,
    verdicts: facts({ P: "accepted" }),
  });
  assert.deepEqual(partial.accepted, ["P"], "one acceptance is not both");
  assert.ok(
    partial.blocked.some((entry) => entry.id === "J" && entry.waitingFor.includes("T")),
    "J waits for the dependency that has no verdict yet",
  );

  const both = deriveStatus(compileTaskUnits(joinInput()).units, {
    artifacts,
    verdicts: facts({ P: "accepted", T: "accepted" }),
  });
  assert.deepEqual(both.accepted.sort(), ["P", "T"]);
  assert.equal(both.ready[0], "J", "only acceptance of both makes the join next");

  // Preparation and mergeability are the two halves of this case the finite model does not
  // cover; naming them is what keeps "P and T can be prepared" from being assumed.
  assert.ok(UNMODELLED_BY_MODEL.includes("preparation"));
  assert.ok(UNMODELLED_BY_MODEL.includes("mergeability"));

  // Two units editing the same file stay two units: no order in the model produces a shorter
  // plan, so nothing has merged them on the strength of writing the same path.
  const shared: ProbePlan = [
    ["X", "1", [], "isolated-artifact", null, null],
    ["Y", "1", [], "isolated-artifact", null, null],
  ];
  const report = compareModes({
    plan: shared,
    specs: { X: spec("same.ts"), Y: spec("same.ts") },
    outcomes: { X: "accepted", Y: "accepted" },
  });
  for (const plan of report.plans)
    assert.deepEqual([...plan.order].sort(), ["X", "Y"], "a plan is a permutation, never a fusion");
});

test("case 2: a lost obligation or a widened permission is refused, and an assumption cannot stand in for a dependency", () => {
  const compiled = compileTaskUnits(joinInput());
  const refusals = checkRefinement(compiled, {
    parent: "P",
    parts: ["J"],
    join: "J",
    obligations: { "input-closure": ["J"] }, // deliberately drops artifact-handoff and the rest
  });
  assert.ok(
    refusals.some((refusal) => refusal.field === "obligations.artifact-handoff"),
    "every parent obligation must map to a part output",
  );

  // Widening is checked against a parent that actually has a frozen envelope: two units in
  // the same plan, the second writing a file the first does not own.
  const siblings: ProbePlan = [
    ["P", "1", [], "isolated-artifact", null, null],
    ["C", "1", [], "isolated-artifact", null, null],
  ];
  const sib = compileTaskUnits({ plan: siblings, specs: { P: spec("a.ts"), C: spec("b.ts") } });
  const sibParent = sib.units.find((unit) => unit.id === "P")!;
  const widened = checkRefinement(sib, {
    parent: "P",
    parts: ["C"],
    join: "C",
    obligations: Object.fromEntries(sibParent.obligations.map((obligation) => [obligation, ["C"]])),
  });
  assert.ok(
    widened.some((refusal) => refusal.obligation === "permission-closure"),
    "a part may not write outside the parent's write set",
  );

  // A Requirement is a precondition on a *dependency's* accepted artifact. One that names a
  // task this unit does not depend on would let a soft assumption carry a real dependency.
  const assumed = compileTaskUnits(
    joinInput({ requires: { P: [{ kind: "verified", task: "T" }] } }),
  );
  const located = assumed.refusals.find((refusal) => refusal.field === "requires")!;
  assert.equal(located.task, "P");
  assert.equal(located.obligation, "input-closure");
  assert.match(located.reason, /not a declared dependency/u);
  assert.equal(assumed.legal, false);
});

test("case 3: a failed fusion keeps only the accepted prefix, and a successor never runs ahead", () => {
  const report = compareModes({
    plan: join,
    specs: { P: spec("a.ts"), T: spec("b.ts") },
    outcomes: { P: "accepted", T: "rejected", J: "accepted" },
  });
  for (const plan of report.plans)
    assert.deepEqual(
      plan.accepted,
      ["P"],
      "the prefix is preserved and nothing downstream of a rejection is accepted",
    );
  const speculative = report.plans.filter((plan) => plan.mode === "fused" && plan.rollbacks > 0);
  assert.ok(speculative.length > 0, "the speculative order pays for the rejection");
  assert.ok(speculative.every((plan) => plan.retries === plan.rollbacks));
});

test("case 4: a drifted revision or a cancelled unit is not accepted", () => {
  const unit = { id: "P", revision: "1" };
  const accepted = {
    artifacts: { P: "digest-P" },
    verdicts: { P: { digest: "digest-P", verdict: "accepted" as const } },
  };
  assert.equal(isAccepted(unit, accepted), true);
  assert.equal(isAccepted(unit, { ...accepted, revisions: { P: "2" } }), false, "input drifted");
  assert.equal(isAccepted(unit, { ...accepted, cancellations: ["P"] }), false, "cancelled");
});

test("case 5: speculation's three outcomes are publish, void-and-redo, and stay unaccepted", () => {
  const base = {
    artifact: "commit",
    digest: "d".repeat(64),
    judgedDigest: "d".repeat(64),
    currentRevision: true,
  };
  assert.equal(acceptedFact({ ...base, verdict: "accepted" }), true, "true publishes");
  assert.equal(acceptedFact({ ...base, verdict: "rejected" }), false, "false is voided");
  assert.equal(
    acceptedFact({ ...base, verdict: "undecidable" }),
    false,
    "unknown stays unaccepted rather than becoming a success",
  );

  const undecided = compareModes({
    plan: join,
    specs: { P: spec("a.ts"), T: spec("b.ts") },
    outcomes: { P: "accepted", T: "undecidable", J: "accepted" },
  });
  for (const plan of undecided.plans)
    assert.equal(
      plan.accepted.includes("J"),
      false,
      "an undecided dependency blocks its dependent",
    );
});

test("case 6: the baseline is always available, and no wait is manufactured to pass", async () => {
  const report = compareModes({
    plan: join,
    specs: { P: spec("a.ts"), T: spec("b.ts") },
    outcomes: { P: "accepted", T: "accepted", J: "accepted" },
  });
  const ordered = report.comparison.find((entry) => entry.mode === "ordered")!;
  assert.equal(ordered.orders, 1, "the baseline is the declared plan order");
  assert.deepEqual([ordered.minRollbacks, ordered.maxRollbacks], [0, 0], "and it never rolls back");

  // "Do not manufacture a wait": the semantic layer has no clock and no timer, so it cannot
  // pay a wait to make a number look better — and it cannot sleep to fake concurrency either.
  for (const path of [
    "src/integration/task-semantics.ts",
    "src/integration/task-semantics-model.ts",
  ]) {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    for (const forbidden of [
      "setTimeout",
      "setInterval",
      "Date.now",
      "new Date",
      "Math.random",
      "process.hrtime",
    ])
      assert.equal(source.includes(forbidden), false, `${path} must not consult ${forbidden}`);
  }
});

test("field mapping: budget units, requires-versus-deps, and unknown fields are caught by name", () => {
  const budget = compileTaskUnits(
    joinInput({
      specs: { P: spec("a.ts", { maxBytes: 10 } as unknown as Partial<PatchTaskSpec>) },
    }),
  );
  assert.ok(budget.refusals.some((refusal) => refusal.field === "maxBytes"));

  const confused = compileTaskUnits(
    joinInput({
      requires: { P: [{ kind: "depends-on", task: "T" }] } as unknown as CompileInput["requires"],
    }),
  );
  assert.ok(
    confused.refusals.some((refusal) => /is a dependency, not a requirement/u.test(refusal.reason)),
  );

  const dropped = compileTaskUnits(
    joinInput({ specs: { P: spec("a.ts", { intent: "x" } as unknown as Partial<PatchTaskSpec>) } }),
  );
  assert.ok(dropped.refusals.some((refusal) => refusal.field === "intent"));
});

test("recomputation: the same facts give the same view, and an unknown result is never guessed", () => {
  const first = compileTaskUnits(joinInput());
  const second = compileTaskUnits(joinInput());
  assert.equal(first.digest, second.digest, "no derived cache changes the view");

  const facts = {
    artifacts: { P: "digest-P" },
    verdicts: { P: { digest: "digest-P", verdict: "accepted" as const } },
  };
  assert.deepEqual(
    deriveStatus(first.units, facts),
    deriveStatus(compileTaskUnits(joinInput()).units, facts),
    "recomputing from the same facts is idempotent",
  );

  const unknown = deriveStatus(first.units, facts);
  assert.equal(unknown.ready.includes("J"), false, "an unknown dependency result is not progress");
  assert.ok(unknown.blocked.some((entry) => entry.id === "J"));
});
