import assert from "node:assert/strict";
import test from "node:test";
import {
  nextTask,
  selectableTasks,
  snapshotAnswer,
  snapshotPrompt,
  startableTasks,
  type DispatchTask,
} from "../../src/integration/ooo-execution.ts";

test("shared snapshot contract bounds inputs and verifies exact outputs without Pi", () => {
  const heading = {
    operation: "heading" as const,
    input: "# First\r\n\n# Second",
    dependencies: {},
  };
  assert.equal(snapshotAnswer(heading), "First");
  assert.match(snapshotPrompt(heading), /read_snapshot/);
  assert.equal(
    snapshotAnswer({ operation: "join", input: "", dependencies: { B: "second", A: "first" } }),
    "first\nsecond",
  );
  assert.throws(() => snapshotPrompt({ ...heading, input: "x".repeat(32_001) }), /budget/);
  assert.throws(() => snapshotAnswer({ ...heading, input: "no heading" }), /heading/);
});

const task = (id: string, extra: Partial<DispatchTask> = {}): DispatchTask => ({
  id,
  effect: "read-only",
  sourceVersion: "v1",
  observedVersion: "v1",
  dependencies: [],
  accepted: false,
  claimed: false,
  externalReady: true,
  ...extra,
});
const waiting = () => task("A", { externalEvent: "interface-response", externalReady: false });

test("fixed order: bypass only explicit external wait, choosing first safe ready task", () => {
  assert.equal(nextTask([task("A"), task("B")]), "A");
  assert.equal(nextTask([waiting(), task("B"), task("C")]), "B");
  assert.equal(nextTask([task("A", { dependencies: ["missing"] }), task("B")]), null);
  assert.equal(nextTask([task("A", { sourceVersion: "" }), task("B")]), null);
  assert.equal(nextTask([waiting(), task("B", { dependencies: ["A"] }), task("C")]), "C");
});

test("one waiter plus one runner; no preemption when the external event arrives", () => {
  assert.equal(nextTask([waiting(), task("B", { claimed: true }), task("C")]), null);
  assert.equal(nextTask([task("A"), task("B", { claimed: true })]), null);
  assert.equal(nextTask([task("A"), task("B", { accepted: true })]), "A");
  assert.equal(
    nextTask([
      waiting(),
      task("B", { externalEvent: "approval", externalReady: false }),
      task("C"),
    ]),
    null,
  );
});

test("unknown/shared effects and stale inputs are ineligible; changes invalidate dependents", () => {
  for (const effect of ["shared-write", "deploy", "unknown"]) {
    assert.equal(nextTask([waiting(), task("B", { effect })]), null);
  }
  assert.equal(nextTask([waiting(), task("B", { effect: "isolated-artifact" })]), "B");
  assert.equal(nextTask([waiting(), task("B", { observedVersion: "v2" })]), null);
  assert.equal(
    nextTask([
      task("A", { accepted: true, observedVersion: "v2" }),
      task("B", { accepted: true, dependencies: ["A"] }),
      task("C", { dependencies: ["B"] }),
    ]),
    null,
  );
  assert.throws(() => nextTask([task("A"), task("A")]), /duplicate/);
});

test("a declared budget is spent by claims in flight, not by the next task's rank", () => {
  const plan = [task("A"), task("B"), task("C")];
  // One claim in flight: a two-slot run still has room, and the claimed task itself is not on offer.
  assert.deepEqual(
    startableTasks([task("A", { claimed: true }), task("B"), task("C")], 2),
    ["B"],
    "a claimed task is not a candidate, and it spends exactly one slot",
  );
  assert.deepEqual(
    selectableTasks([task("A", { claimed: true }), task("B"), task("C")], 2),
    ["B", "C"],
    "the legal set is what a source may rank; the budget cuts the start, not the set",
  );
  // Budget spent: nothing is startable, however ready the rest of the plan is.
  assert.deepEqual(
    startableTasks([task("A", { claimed: true }), task("B", { claimed: true }), task("C")], 2),
    [],
    "two claims in flight spend a two-slot budget",
  );
  assert.deepEqual(
    selectableTasks([task("A", { claimed: true }), task("B", { claimed: true }), task("C")], 2),
    [],
    "a spent budget is the rule's own answer, not the caller's subtraction",
  );
  // The cut happens after ordering: the plan's third task is startable only when the budget pays for it.
  assert.deepEqual(startableTasks(plan, 2), ["A", "B"]);
  assert.deepEqual(startableTasks(plan, 1), ["A"], "one slot is the default and the history");
  assert.deepEqual(selectableTasks(plan, 2), ["A", "B", "C"], "the ordered legal set is unchanged");
  assert.equal(nextTask(plan, 2), "A", "the head is the head whatever the budget");
});

test("a claim in flight does not release a dependent, and half a slot is not a budget", () => {
  const dependent = [task("A", { claimed: true }), task("B", { dependencies: ["A"] })];
  assert.deepEqual(
    selectableTasks(dependent, 4),
    [],
    "B's dependency is unaccepted while A is in flight, so no budget makes B selectable",
  );
  // An external wait ahead of it still licenses the tasks after it - at any budget.
  const behindWait = [waiting(), task("B", { claimed: true }), task("C")];
  assert.deepEqual(startableTasks(behindWait, 2), ["C"]);
  assert.deepEqual(
    startableTasks(behindWait, 3),
    ["C"],
    "B is claimed, not startable, at any budget",
  );
  for (const slots of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => selectableTasks([task("A")], slots), /slots/, `slots=${slots}`);
    assert.throws(() => startableTasks([task("A")], slots), /slots/, `slots=${slots}`);
    assert.throws(() => nextTask([task("A")], slots), /slots/, `slots=${slots}`);
  }
});
