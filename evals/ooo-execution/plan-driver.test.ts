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
import {
  comparePlanSlots,
  piWorker,
  runPlan,
  specFrom,
  type PlanDriverSpec,
  type PlanWorker,
} from "./plan-driver.ts";

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

/** The session a fused run must actually reuse: this worker echoes the session it was handed, so a
 *  chain that only *looked* fused - a fresh session per unit - would show up as distinct ids. */
function sessionWorker(latencyMs = 20): PlanWorker {
  return async (taskId, frozen, dependencies, session) => {
    const produced = await recordingWorker(latencyMs)(taskId, frozen, dependencies);
    if (typeof produced === "string" || !session) return produced;
    return { ...produced, metrics: { ...produced.metrics, sessionId: session.id } };
  };
}

test("a fused run runs several units in one session, each with its own ticket and verdict", async () => {
  const run = await runPlan(
    spec({ slots: 1, fusion: { unitsPerSession: 2 }, worker: sessionWorker(10) }),
  );
  // One session of two units, then a yield boundary and a second session: `summary` becomes a
  // candidate only once `third` is accepted, so the chain continues into it.
  assert.deepEqual(run.sessions, [
    ["first", "second"],
    ["third", "summary"],
  ]);
  for (const unit of run.units)
    assert.equal(
      unit.sessionId,
      `session:${["first", "second"].includes(unit.taskId) ? "first" : "third"}`,
      `${unit.taskId} must name the session it really ran in`,
    );
  // Fusion changes the execution resource, never the acceptance facts: each unit keeps its own
  // claim, verdict, attempt and token count.
  assert.equal(run.units.length, 4);
  assert.deepEqual(
    run.units.map((unit) => unit.verdict),
    Array(4).fill("accepted"),
  );
  assert.equal(run.hostChecks, 4, "every fused unit still crosses the host boundary on its own");
  assert.deepEqual(
    run.units.map((unit) => unit.attempt),
    [1, 1, 1, 1],
  );
});

test("a fused session ends where the next unit needs another capability", async () => {
  const run = await runPlan(
    spec({
      slots: 1,
      fusion: { unitsPerSession: 4, declarations: { third: { capability: "other" } } },
      worker: sessionWorker(10),
    }),
  );
  // `third` is not a legal successor of `second`, and `summary` is not one of `third`: the run keeps
  // each of them in its own session rather than widening what one session may do.
  assert.deepEqual(run.sessions, [["first", "second"], ["third"], ["summary"]]);
});

test("a fused chain stops at the declared bound and does not swallow the plan", async () => {
  const run = await runPlan(
    spec({ slots: 1, fusion: { unitsPerSession: 1 }, worker: sessionWorker(10) }),
  );
  // A bound of one is the control arm: fusion is on, and every session is one unit.
  assert.deepEqual(run.sessions, [["first"], ["second"], ["third"], ["summary"]]);
});

test("a unit with no verdict ends the session it was running in", async () => {
  const worker: PlanWorker = async (taskId, frozen, dependencies, session) => {
    if (taskId === "second") return { failure: "gave up on the second unit" };
    const produced = await sessionWorker(10)(taskId, frozen, dependencies, session);
    return produced;
  };
  const run = await runPlan(spec({ slots: 1, fusion: { unitsPerSession: 4 }, worker }));
  assert.equal(run.failures, 1);
  assert.ok(run.incomplete.some((entry) => entry.includes("second")));
  assert.deepEqual(run.sessions, [["first"]], "the session ended at the unit with no verdict");
  assert.equal(run.accepted["summary"], undefined, "the summary cannot be accepted on a failure");
});

test("a fused session does not continue from a unit the host rejected", async () => {
  // A verdict is not a failure: the unit ran, the host looked at it and refused. The session must end
  // there all the same, because the next unit would be working on top of an unverified answer.
  const bad = [{ label: "unit check", command: process.execPath, args: ["-e", "process.exit(1)"] }];
  const base = spec({ slots: 1, fusion: { unitsPerSession: 4 }, worker: sessionWorker(10) });
  const run = await runPlan({
    ...base,
    units: { ...base.units, second: { ...base.units["second"]!, checks: bad } },
  });
  assert.equal(run.units.find((unit) => unit.taskId === "second")?.verdict, "rejected");
  assert.deepEqual(
    run.sessions.find((chain) => chain.includes("second")),
    ["first", "second"],
    "the session ended at the rejected unit, not after it",
  );
  assert.ok(
    !run.units.some(
      (unit) =>
        unit.taskId === "third" &&
        unit.sessionId === run.units.find((x) => x.taskId === "second")?.sessionId,
    ),
    `no unit may run on top of a rejected answer: ${JSON.stringify(run.sessions)}`,
  );
});

test("a worker that starts its own session is not reported as fusion", async () => {
  // `recordingWorker` never echoes a session, which is what a worker that opens a fresh session per
  // unit looks like from the driver's side. The run must report boundaries, not fusion.
  const run = await runPlan(
    spec({ slots: 1, fusion: { unitsPerSession: 4 }, worker: recordingWorker(10) }),
  );
  assert.deepEqual(run.sessions, [["first"], ["second"], ["third"], ["summary"]]);
  assert.ok(
    run.units.every((unit) => unit.sessionId === undefined),
    "no unit claims a session the worker never reported",
  );
});

test("the live worker refuses to continue a session it cannot hold, and spends nothing", async () => {
  const worker = piWorker({ provider: "deepseek", model: "deepseek-v4-flash" }, true);
  const result = await worker("second", {} as never, {}, { id: "session:first", units: ["first"] });
  assert.ok(typeof result !== "string");
  assert.match(
    String(result.failure),
    /cannot continue session session:first \(it has run first\)/,
    "a continuation the harness cannot hold is refused by name, not answered with a new session",
  );
});

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

/** The out-of-order property the design is about, carried by this driver and not by roles: an
 *  independent unit's worker runs while another unit's check is still outstanding. The retired round
 *  (`docs/decisions/implemented/2026-09-18-retire-the-round-instrument.md`) was the only end-to-end
 *  carrier of it before this case; if the batch loop ever stops overlapping units, this fails. */
test("a unit's check is outstanding while an independent unit's worker runs", async () => {
  const slowCheckMs = 1500;
  const windows: Record<string, { start: number; end: number }> = {};
  const worker: PlanWorker = async (taskId, frozen) => {
    const window = { start: Date.now(), end: 0 };
    windows[taskId] = window;
    // The second unit's work is shorter than the first unit's check, so "inside it" is a fact about
    // the dispatch policy rather than about the two durations.
    if (taskId === "second") await new Promise((done) => setTimeout(done, 700));
    window.end = Date.now();
    return {
      artifact: JSON.stringify({
        digest: frozen.digest,
        files: frozen.work.editable.map((path) => ({
          path,
          content: `${frozen.work.files[path] ?? ""}// ${taskId}\n`,
        })),
      }),
      metrics: { tokens: 1, turns: 1, checks: 0 },
    };
  };
  const slow = [
    {
      label: "slow",
      command: process.execPath,
      args: ["-e", `setTimeout(() => {}, ${slowCheckMs})`],
    },
  ];
  const twoUnits: ProbePlan = [
    ["first", "", [], "isolated-artifact", null, null],
    ["second", "", [], "isolated-artifact", null, null],
  ];
  const run = await runPlan({
    plan: twoUnits,
    units: {
      first: { instruction: "work on first", editable: ["src/unit.ts"], checks: slow },
      second: { instruction: "work on second", editable: ["src/unit.ts"], checks: ok },
    },
    worker,
    repository: process.cwd(),
    revision: "HEAD",
    baseline,
    slots: 2,
  });
  const first = run.units.find((unit) => unit.taskId === "first");
  assert.ok(first, "the first unit ran");
  assert.equal(run.slotsUsed, 2, `two slots were declared and used: ${run.slotRefusal ?? ""}`);
  assert.ok(
    first.hostMs >= slowCheckMs,
    `the first unit's check is the slow one; measured ${first.hostMs} ms`,
  );
  const firstWindow = windows.first!;
  const secondWindow = windows.second!;
  assert.ok(
    secondWindow.start >= firstWindow.end && secondWindow.end <= firstWindow.end + first.hostMs,
    "the second unit's worker must run entirely inside the first unit's check window: " +
      `first=${firstWindow.start}-${firstWindow.end}, check=${first.hostMs}ms, second=${secondWindow.start}-${secondWindow.end}`,
  );
  assert.equal(run.failures, 0, "both units are accepted, so the overlap is not a failure path");
});

test("a spec file's fusion block reaches the run it describes", () => {
  const target = "evals/ooo-execution/fixtures/report/alpha.ts";
  const file = {
    baseline: [target],
    plan: [{ id: "first", effect: "isolated-artifact" }],
    units: {
      first: {
        instruction: "work on first",
        editable: [target],
        checks: [{ label: "ok", command: "node", args: ["-e", "process.exit(0)"] }],
      },
    },
    worker: { kind: "stub" as const, latencyMs: 1 },
    fusion: { unitsPerSession: 2 },
  };
  const declared = specFrom(file, recordingWorker(), 1);
  assert.deepEqual(
    declared.fusion,
    { unitsPerSession: 2 },
    "a spec that asked for fusion must not be run as the control arm",
  );
  const without: Record<string, unknown> = { ...file };
  delete without.fusion;
  assert.equal(
    specFrom(without, recordingWorker(), 1).fusion,
    undefined,
    "a spec that declared none has none: the two readings must not be the same run",
  );
});
