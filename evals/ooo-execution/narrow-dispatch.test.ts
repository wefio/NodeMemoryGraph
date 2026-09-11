import assert from "node:assert/strict";
import test from "node:test";
import {
  nextTask,
  snapshotAnswer,
  snapshotPrompt,
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
