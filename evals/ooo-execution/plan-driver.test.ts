// The granularity driver's own properties, offline and deterministic.
//
// The arms compare two slot counts on the same plan, so the driver has exactly two jobs: start only
// what the rules allow, and start as many of those as the slot count says at once. The second job was
// once unreachable - the shared admission layer published a handoff only for the task it had selected,
// so a run could hold exactly one claim - and these cases pin the mechanism that made it reachable (a
// declared slot budget, with each handoff directed at its own claimant) from the driver's side.
import assert from "node:assert/strict";
import test from "node:test";
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

test("a declared slot count is reached, and the claims overlap in time", async () => {
  const log: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const inner = recordingWorker(60, log);
  const worker: PlanWorker = async (taskId, frozen, dependencies) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      return await inner(taskId, frozen, dependencies);
    } finally {
      inFlight -= 1;
    }
  };
  const run = await runPlan(spec({ slots: 4, worker }));
  assert.equal(run.slotsRequested, 4);
  assert.equal(
    run.slotsUsed,
    3,
    "three units are independent, and the summary waits for all three",
  );
  assert.equal(run.slotRefusal, undefined, "the board allowed every claim it was asked for");
  assert.equal(peak, 3, `the worker saw the claims overlap: ${log.join(",")}`);
  assert.deepEqual(
    run.units.map((unit) => unit.verdict),
    Array(4).fill("accepted"),
    "the same verdicts as the one-slot run, which is what makes the two arms one experiment",
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
  assert.equal(
    oneSlot.slotShortfalls.length,
    2,
    "both four-slot runs reached three of four: the plan has three independent units",
  );
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
  const flaky: PlanWorker = async (_taskId, frozen) => {
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
