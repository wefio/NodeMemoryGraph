// The granularity driver's own properties, offline and deterministic.
//
// The arms compare two slot counts on the same plan, so the driver has exactly two jobs: start only
// what the rules allow, and start as many of those as the slot count says at once. The second job
// measured something this repository did not know: the shared admission layer publishes a handoff
// only for the task it has selected, so a run can hold exactly one claim. These cases pin that
// measurement, so the day the layer changes, the case that fails is the one that says what changed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ProbePlan } from "../../src/integration/ooo-board.ts";
import { comparePlanSlots, runPlan, type PlanDriverSpec, type PlanWorker } from "./plan-driver.ts";

const baseline = { "src/unit.ts": "export const value = 1;\n" };
const ok = [{ label: "unit check", command: process.execPath, args: ["-e", "process.exit(0)"] }];
/** Four units that share a frozen interface, and a summary over three of them: the shape the arms
 *  use, and one whose independence is real rather than a relabelling of test groups. */
const plan: ProbePlan = [
  ["first", "", [], "isolated-artifact", null, null],
  ["second", "", [], "isolated-artifact", null, null],
  ["third", "", [], "isolated-artifact", null, null],
  ["summary", "", ["first", "second", "third"], "isolated-artifact", null, null],
];

function spec(overrides: Partial<PlanDriverSpec> = {}): PlanDriverSpec {
  const units = Object.fromEntries(
    plan.map((row) => [
      String(row[0]),
      { instruction: `work on ${String(row[0])}`, editable: ["src/unit.ts"], checks: ok },
    ]),
  );
  return {
    plan,
    units,
    worker: recordingWorker(),
    repository: process.cwd(),
    revision: "HEAD",
    baseline,
    parentChecks: ok,
    join: "summary",
    slots: 4,
    ...overrides,
  };
}

/** A worker that takes a fixed time and records when it ran, so overlap is visible in the data and
 *  not only in a wall clock. It answers in the protocol's own patch shape: a list of whole-file
 *  replacements that must actually differ from the frozen input, which is what the store checks. */
function recordingWorker(latencyMs = 60, log: string[] = []): PlanWorker {
  return async (taskId, frozen) => {
    log.push(`start:${taskId}`);
    await new Promise((done) => setTimeout(done, latencyMs));
    return {
      artifact: JSON.stringify({
        digest: frozen.digest,
        files: frozen.work.editable.map((path) => ({
          path,
          content: `${frozen.work.files[path] ?? ""}// ${taskId}\n`,
        })),
      }),
      metrics: { tokens: 7, turns: 1, checks: 0 },
    };
  };
}

test("one slot runs the units in plan order, each to acceptance", async () => {
  const run = await runPlan(spec({ slots: 1, worker: recordingWorker(20) }));
  assert.deepEqual(run.order, ["first", "second", "third", "summary"]);
  assert.deepEqual(
    run.units.map((unit) => unit.verdict),
    Array(4).fill("accepted"),
  );
  assert.equal(run.slotsUsed, 1);
  assert.equal(run.slotRefusal, undefined);
  assert.equal(run.parent?.verdict, "accept", "the fixed parent check runs over the composition");
  assert.deepEqual(run.parent?.files, ["summary"], "the join unit stands for the parent's result");
  assert.equal(run.hostChecks, 4, "the host checks every candidate, in both arms");
  assert.deepEqual(run.incomplete, []);
});

test("the requested slot count is not reached, and the run says so instead of faking it", async () => {
  const run = await runPlan(spec({ slots: 4, worker: recordingWorker(20) }));
  assert.equal(run.slotsRequested, 4);
  assert.equal(run.slotsUsed, 1, `attempted a second claim and got: ${String(run.slotRefusal)}`);
  assert.match(String(run.slotRefusal), /no published handoff|not selected by narrow dispatch/);
  // Same plan, same units, same verdicts: the missing slot is the only difference, which is why the
  // comparison below may not report a time.
  assert.deepEqual(
    run.units.map((unit) => unit.verdict),
    Array(4).fill("accepted"),
  );
  assert.deepEqual(run.incomplete, []);
});

test("a dependent unit waits for its dependencies and is never dispatched early", async () => {
  const log: string[] = [];
  const run = await runPlan(spec({ slots: 1, worker: recordingWorker(10, log) }));
  assert.equal(run.order.at(-1), "summary", `dispatch order: ${run.order.join(",")}`);
  assert.deepEqual(run.units.at(-1)?.taskId, "summary");
  assert.equal(run.failures, 0);
});

test("a failed worker is recorded as incomplete rather than silently skipped", async () => {
  const worker: PlanWorker = async (taskId, frozen) => {
    if (taskId === "second") return { failure: "stub: the model returned nothing" };
    return {
      artifact: JSON.stringify({
        digest: frozen.digest,
        files: [{ path: "src/unit.ts", content: `${frozen.work.files["src/unit.ts"]}// x\n` }],
      }),
    };
  };
  const run = await runPlan(spec({ slots: 1, worker }));
  assert.equal(run.failures, 1);
  assert.ok(
    run.incomplete.some((entry) => entry.includes("second")),
    `incomplete: ${JSON.stringify(run.incomplete)}`,
  );
  assert.equal(run.accepted["summary"], undefined, "the summary cannot be accepted on a failure");
});

test("the parent check is the composed acceptance, and a failing check is reported as such", async () => {
  const failing = [
    { label: "parent check", command: process.execPath, args: ["-e", "process.exit(1)"] },
  ];
  const run = await runPlan(spec({ slots: 1, worker: recordingWorker(10), parentChecks: failing }));
  assert.equal(run.parent?.verdict, "reject");
  assert.deepEqual(
    run.units.map((unit) => unit.verdict),
    Array(4).fill("accepted"),
    "the units are still accepted; only the composed result fails",
  );
});

test("a comparison refuses a time verdict when the slot count or the quality differs", async () => {
  const oneSlot = await comparePlanSlots(spec({ slots: 4, worker: recordingWorker(10) }), {
    runs: 2,
  });
  assert.deepEqual(
    oneSlot.arms.map((arm) => arm.slots),
    [1, 4],
  );
  assert.equal(oneSlot.qualityParity, true, JSON.stringify(oneSlot.differences));
  assert.equal(oneSlot.slotShortfalls.length, 2, "both four-slot runs fell back to one");
  assert.equal(
    oneSlot.comparable,
    false,
    "a fallback slot count makes the two arms one experiment",
  );

  const twoArms = await comparePlanSlots(spec({ slots: 1, worker: recordingWorker(10) }), {
    runs: 1,
    arms: [1],
  });
  assert.equal(twoArms.comparable, true);
  assert.deepEqual(twoArms.slotShortfalls, []);

  let calls = 0;
  const flaky: PlanWorker = async (taskId, frozen) => {
    calls += 1;
    if (calls === 1) return { failure: "stub: the first call fails" };
    return {
      artifact: JSON.stringify({
        digest: frozen.digest,
        files: [{ path: "src/unit.ts", content: `${frozen.work.files["src/unit.ts"]}// y\n` }],
      }),
    };
  };
  const unfair = await comparePlanSlots(spec({ slots: 1, worker: flaky }), {
    runs: 1,
    arms: [1, 2],
  });
  assert.equal(unfair.qualityParity, false, "a lost unit has to show up as different verdicts");
  assert.equal(unfair.comparable, false);
  assert.ok(unfair.differences.length > 0);
});

test("the driver never names a task: the same plan under other names is the same run", async () => {
  // The product round's A/B/C roles are the coupling F2b exists to avoid, so the driver has to be
  // name-blind in two ways that can be checked. First behaviourally: the plan's ids follow the plan's
  // declared positions, not alphabetical order and not a role, so a renamed plan runs identically.
  const renamed: ProbePlan = [
    ["gamma", "", [], "isolated-artifact", null, null],
    ["alpha-2", "", [], "isolated-artifact", null, null],
    ["zz", "", [], "isolated-artifact", null, null],
    ["join", "", ["gamma", "alpha-2", "zz"], "isolated-artifact", null, null],
  ];
  const renamedUnits = Object.fromEntries(
    renamed.map((row) => [
      String(row[0]),
      { instruction: `work on ${String(row[0])}`, editable: ["src/unit.ts"], checks: ok },
    ]),
  );
  const run = await runPlan({
    ...spec(),
    plan: renamed,
    units: renamedUnits,
    join: "join",
    slots: 1,
    worker: recordingWorker(10),
  });
  assert.deepEqual(run.order, ["gamma", "alpha-2", "zz", "join"], "declared order, not sorted ids");
  assert.deepEqual(
    run.units.map((unit) => unit.verdict),
    Array(4).fill("accepted"),
  );
  assert.equal(run.parent?.verdict, "accept");
  // Second, in the source: a role name is how the coupling would come back, so the driver must not
  // contain one. Reading its own text is the check; the driver's ids come from the spec or nowhere.
  const source = readFileSync(fileURLToPath(new URL("./plan-driver.ts", import.meta.url)), "utf8");
  for (const role of ['"A"', '"B"', '"C"'])
    assert.equal(source.includes(role), false, `the driver names the task ${role}: a plan is data`);
});

test("impossible input is refused rather than defaulted", async () => {
  await assert.rejects(() => runPlan(spec({ slots: 0 })), /slots must be a positive integer/);
  await assert.rejects(
    () => runPlan(spec({ units: { ghost: { instruction: "x", editable: [], checks: ok } } })),
    /not in the plan; the plan is the authority/,
  );
  await assert.rejects(
    () => comparePlanSlots(spec(), { runs: 0 }),
    /runs must be a positive integer/,
  );
});
