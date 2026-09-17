// The plan is data, with one home - and this file also records the boundary that is still real.
//
// Three things are checked, each because something could go wrong silently:
//
//  1. A round's log names the plan it was *given*. The log used to name `["A","B","C"]` as a literal,
//     so any other plan would still have been reported as the default one: the report would have
//     disagreed with the run, which is worse than no report.
//  2. The store and the round get the same plan. Another process cancels and queries a round through
//     the store, so a store built from a different plan would let an operator fence a round whose
//     plan is not the one it is running. The research runner carried a byte-identical copy of the
//     default plan until this change, which is exactly how those two could drift apart.
//  3. **The driver is still not a general one**, and the test proves it rather than promising it: a
//     plan without the A and B roles fails, because the round installs its two patch tasks by those
//     names. Generalising it is a separate slice; the design says not to build a general scheduler
//     before the semantics are settled, so the arms get their own research-side driver instead.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbePlan } from "../../src/integration/ooo-board.ts";
import { DEFAULT_ROUND_PLAN, openRoundStore, runCycle } from "../../src/integration/ooo-cycle.ts";
import { cycleOptionsFor, planFor } from "./round-runner.ts";
import { parseRoundSpec } from "./round-spec.ts";

const IMPL = "src/plan.ts";
const baseline = { [IMPL]: "export const a = 1;\n" };
const checks = [{ label: "fixed", command: process.execPath, args: ["-e", "process.exit(0)"] }];

/** The same three roles in another order. The driver finds A, B and C by name, so this runs, and the
 *  log has to name the order it was given: a literal list in the log would still say A/B/C. */
const reordered: ProbePlan = [
  ["B", "", [], "isolated-artifact", null, null],
  ["A", "", [], "isolated-artifact", "protocol-regression", null],
  ["C", "", ["B", "A"], "isolated-artifact", null, null],
];

/** Three units that depend on nothing but the frozen interface plus a summary: the shape the
 *  granularity arms need, and one the round's own A/B roles cannot drive. */
const finePlan: ProbePlan = [
  ["first", "", [], "isolated-artifact", null, null],
  ["second", "", [], "isolated-artifact", null, null],
  ["summary", "", ["first", "second"], "isolated-artifact", null, null],
];

function options(plan: ProbePlan, storePlan: ProbePlan = plan) {
  return {
    operations: openRoundStore(":memory:", storePlan),
    repository: process.cwd(),
    revision: "0".repeat(40),
    baseline,
    checks,
    plan,
    runChecks: async () => ({ verdict: "accept" as const, outcomes: [] }),
    worker: async () => ({
      artifact: JSON.stringify({ digest: "", files: [] }),
      metrics: { tokens: 1, turns: 1, checks: 0 },
    }),
    aInstruction: "A works.",
    bInstruction: "B works.",
    aEditable: [IMPL],
    bEditable: [IMPL],
    budget: { perFile: 20_000, output: 40_000 },
    limits: { turns: 2, reads: 2, timeoutMs: 30_000 },
  };
}

test("the round's log names the plan it was given, not the default one", async () => {
  const result = await runCycle(options(reordered));
  const planned = result.log.find((event) => event.kind === "plan") as { tasks: string[] };
  assert.ok(planned, "the round records its plan");
  assert.deepEqual(
    planned.tasks,
    ["B", "A", "C"],
    "the log has to name the plan that ran; a literal list would keep claiming A/B/C",
  );
  assert.notDeepEqual(
    planned.tasks,
    DEFAULT_ROUND_PLAN.map((row) => row[0]),
  );
});

test("a plan without the round's own roles fails, because the driver is not general", async () => {
  await assert.rejects(
    () => runCycle(options(finePlan)),
    /unknown task/,
    "a four-unit plan cannot be driven by this round: the driver issues A's check and installs the " +
      "A/B patch tasks by name, which is why the arms need their own driver",
  );
});

test("one plan value reaches both the store and the round", () => {
  // The runner opens the store for an operator's  and hands the round its options. If those
  // two call sites ever stopped sharing one value, the two plans could differ - which is the drift the
  // research runner used to be able to introduce with its own copy of the default.
  const spec = parseRoundSpec({
    baseline: [IMPL],
    checks: [{ label: "fixed", command: process.execPath, args: ["-e", "process.exit(0)"] }],
    a: { instruction: "A works.", editable: [IMPL] },
    b: { instruction: "B works.", editable: [IMPL] },
    worker: { kind: "replay", log: "recorded.jsonl" },
  });
  const shared = planFor(spec);
  const runDirectory = mkdtempSync(join(tmpdir(), "ooo-plan-"));
  try {
    assert.equal(
      cycleOptionsFor({
        spec,
        repository: process.cwd(),
        revision: "0".repeat(40),
        baseline,
        worker: async () => ({ artifact: "", metrics: {} }),
        runDirectory,
      }).plan,
      shared,
      "the round reads the same plan value the store is opened with, not an equal copy",
    );
    assert.equal(shared, DEFAULT_ROUND_PLAN, "and with no plan declared that value is the default");
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("the runner takes the spec's plan, and the default is the round's own", () => {
  const parsed = parseRoundSpec({
    baseline: [IMPL],
    checks: [{ label: "fixed", command: process.execPath, args: ["-e", "process.exit(0)"] }],
    a: { instruction: "A works.", editable: [IMPL] },
    b: { instruction: "B works.", editable: [IMPL] },
    worker: { kind: "replay", log: "recorded.jsonl" },
    plan: [
      { id: "one", effect: "isolated-artifact" },
      { id: "two", effect: "isolated-artifact", dependencies: ["one"], revision: "v1" },
    ],
  });
  assert.deepEqual(
    planFor(parsed).map((row) => [String(row[0]), [...(row[2] as string[])], String(row[1])]),
    [
      ["one", [], ""],
      ["two", ["one"], "v1"],
    ],
    "the spec's plan is mapped row by row, with the fields it left out defaulted",
  );
  assert.equal(
    planFor({ ...parsed, plan: undefined }),
    DEFAULT_ROUND_PLAN,
    "with no plan declared the runner uses the round's own default, not a copy of it",
  );
});

test("a plan the shared compiler owns is not re-validated here", () => {
  // Shape only in the parser: a self-dependency parses, and the compiler is what names it. Keeping
  // what a plan may contain in one home is why this case asserts acceptance before the refusal.
  const parsed = parseRoundSpec({
    baseline: [IMPL],
    checks: [{ label: "fixed", command: process.execPath, args: ["-e", "process.exit(0)"] }],
    a: { instruction: "A works.", editable: [IMPL] },
    b: { instruction: "B works.", editable: [IMPL] },
    worker: { kind: "replay", log: "recorded.jsonl" },
    plan: [{ id: "self", effect: "isolated-artifact", dependencies: ["self"] }],
  });
  assert.equal(planFor(parsed).length, 1);
  assert.throws(
    () => openRoundStore(":memory:", planFor(parsed)),
    /dependency|depend on itself|cycle/i,
    "the shared compiler owns what a plan may contain, and the store refuses a plan it refuses",
  );
});

test("a malformed plan is refused by the parser rather than defaulted", () => {
  const spec = (plan: unknown) => ({
    baseline: [IMPL],
    checks: [{ label: "fixed", command: process.execPath, args: ["-e", "process.exit(0)"] }],
    a: { instruction: "A works.", editable: [IMPL] },
    b: { instruction: "B works.", editable: [IMPL] },
    worker: { kind: "replay", log: "recorded.jsonl" },
    plan,
  });
  assert.throws(() => parseRoundSpec(spec([])), /plan must be a non-empty array/);
  assert.throws(() => parseRoundSpec(spec({ id: "one" })), /plan must be a non-empty array/);
  assert.throws(() => parseRoundSpec(spec([{ effect: "isolated-artifact" }])), /plan\[0\]\.id/);
  assert.throws(
    () => parseRoundSpec(spec([{ id: "one" }])),
    /plan\[0\]\.effect/,
    "an effect is what the unit is allowed to do; it cannot be omitted into a default",
  );
  assert.throws(
    () => parseRoundSpec(spec([{ id: "one", effect: "x", unknown: 1 }])),
    /plan\[0\] has an unknown key: unknown/,
  );
});
