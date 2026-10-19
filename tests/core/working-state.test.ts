import assert from "node:assert/strict";
import test from "node:test";

import { SessionActiveGraphRuntime } from "../../src/core/session-active-graph.ts";
import { prepareSessionActiveGraphSurface } from "../../src/integration/agent-surface.ts";

function state(runtime: SessionActiveGraphRuntime, sessionId = "owner") {
  return runtime.snapshot(sessionId)?.items.filter((item) => item.kind === "working_state") ?? [];
}

test("working state replaces one frame-local item, keeps exact text and does not disclose", () => {
  const runtime = new SessionActiveGraphRuntime();
  const binding = runtime.bindWorkingState("owner");
  assert.equal(runtime.replaceWorkingState(binding, "First state."), "updated");
  const first = state(runtime)[0]!;
  assert.equal(runtime.replaceWorkingState(binding, "First state."), "unchanged");
  assert.deepEqual(state(runtime)[0], first);
  const text = ` ${"Observe constraints. ".repeat(40)}Public API must not change. `;
  assert.equal(runtime.replaceWorkingState(binding, text), "updated");
  assert.equal(state(runtime).length, 1);
  assert.equal(state(runtime)[0]?.id, first.id);
  assert.equal(state(runtime)[0]?.statement, text);
  assert.notEqual(state(runtime)[0]?.contentHash, first.contentHash);
  assert.equal(state(runtime)[0]?.temporary, true);
  assert.match(
    prepareSessionActiveGraphSurface(runtime.snapshot("owner")).text,
    /Public API must not change\./u,
  );
  assert.deepEqual(runtime.snapshot("owner")?.disclosures, []);
  assert.equal(runtime.clearWorkingState(binding), "cleared");
  assert.equal(runtime.clearWorkingState(binding), "cleared");
  assert.deepEqual(state(runtime), []);
});

test("invalid, secret and oversized replacements preserve the old item and other observations", () => {
  const runtime = new SessionActiveGraphRuntime({
    maxWorkingStateCharacters: 80,
  });
  const binding = runtime.bindWorkingState("owner");
  runtime.replaceWorkingState(binding, "Temporary instruction for this task only.");
  runtime.observe({
    sessionId: "owner",
    statement: "Independent observation.",
  });
  const before = state(runtime)[0];
  for (const text of [" ", "password=not-a-real-credential", "x".repeat(81)]) {
    assert.throws(() => runtime.replaceWorkingState(binding, text));
    assert.deepEqual(state(runtime)[0], before);
  }
  assert.throws(
    () =>
      runtime.observe({
        sessionId: "owner",
        statement: "Bypass dedicated writer.",
        kind: "working_state" as never,
      }),
    /dedicated/u,
  );
  assert.equal(runtime.activateTemporaryProjection("owner").items.length, 2);
});

test("resident budget insufficiency refuses the state write instead of evicting existing content", () => {
  const runtime = new SessionActiveGraphRuntime({
    maxCharactersPerSession: 256,
  });
  const binding = runtime.bindWorkingState("owner");
  runtime.replaceWorkingState(binding, "x".repeat(100));
  runtime.observe({ sessionId: "owner", statement: "y".repeat(100) });
  const before = runtime.activateTemporaryProjection("owner");
  assert.throws(() => runtime.replaceWorkingState(binding, "z".repeat(157)), /budget/u);
  assert.deepEqual(runtime.snapshot("owner")?.items, before.items);
});

test("a captured writer binding cannot cross sessions, frame switches, rebinding or release", () => {
  const runtime = new SessionActiveGraphRuntime();
  const binding = runtime.bindWorkingState("owner", "task-a");
  runtime.replaceWorkingState(binding, "A state.");
  assert.throws(
    () => runtime.replaceWorkingState({ ...binding, sessionId: "other" }, "Wrong owner."),
    /binding/u,
  );
  runtime.observe({
    sessionId: "owner",
    taskFrameId: "task-b",
    statement: "B observation.",
  });
  assert.throws(() => runtime.replaceWorkingState(binding, "Late A write."), /binding/u);
  const resumed = runtime.bindWorkingState("owner", "task-a");
  assert.equal(state(runtime)[0]?.statement, "A state.");
  assert.throws(() => runtime.clearWorkingState(binding), /binding/u);
  runtime.replaceWorkingState(resumed, "Resumed state.");
  runtime.release("owner");
  runtime.bindWorkingState("owner", "task-a");
  assert.throws(() => runtime.replaceWorkingState(resumed, "Write after recreation."), /binding/u);
});

test("ordinary observation eviction preserves maintained state inside the shared resident cap", () => {
  const runtime = new SessionActiveGraphRuntime({
    maxItemsPerSession: 1,
    maxCharactersPerSession: 256,
  });
  const binding = runtime.bindWorkingState("owner");
  runtime.replaceWorkingState(binding, "Keep current state.");
  runtime.observe({
    sessionId: "owner",
    statement: "High activation competing observation.",
    activation: 1,
  });
  const snapshot = runtime.activateTemporaryProjection("owner");
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0]?.statement, "Keep current state.");
});

test("session LRU eviction fences its former writer and state limits reject invalid configuration", () => {
  const runtime = new SessionActiveGraphRuntime({ maxSessions: 1 });
  const binding = runtime.bindWorkingState("owner");
  runtime.replaceWorkingState(binding, "Former state.");
  runtime.bindWorkingState("other");
  assert.throws(() => runtime.replaceWorkingState(binding, "Evicted owner."), /binding/u);
  for (const maxWorkingStateCharacters of [NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => new SessionActiveGraphRuntime({ maxWorkingStateCharacters }), RangeError);
  }
});

test("clearing visibility does not clear state, while cooling-set eviction does", () => {
  const runtime = new SessionActiveGraphRuntime({ maxTaskFramesPerSession: 1 });
  const binding = runtime.bindWorkingState("owner", "task-a");
  runtime.replaceWorkingState(binding, "Keep state through compaction.");
  runtime.clearDisclosures("owner");
  assert.equal(state(runtime)[0]?.statement, "Keep state through compaction.");
  runtime.observe({
    sessionId: "owner",
    taskFrameId: "task-b",
    statement: "B observation.",
  });
  assert.equal(runtime.taskFrame("owner", "task-a"), null);
  runtime.bindWorkingState("owner", "task-a");
  assert.deepEqual(state(runtime), []);
  assert.throws(() => runtime.replaceWorkingState(binding, "Old incarnation."), /binding/u);
});
