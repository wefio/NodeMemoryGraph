import assert from "node:assert/strict";
import test from "node:test";
import { renderSessionActiveGraphSurface } from "../../src/integration/agent-surface.ts";
import { SessionActiveGraphRuntime } from "../../src/core/session-active-graph.ts";
import {
  PI_WORKING_STATE_INPUT_CAPABILITY,
  prepareWorkingStateInput,
} from "../../src/integration/working-state-input.ts";

function state() {
  const runtime = new SessionActiveGraphRuntime();
  const binding = runtime.bindWorkingState("input-session");
  runtime.replaceWorkingState(binding, "Plan with exact constraint=123");
  const current = prepareWorkingStateInput(runtime.snapshot("input-session"))!;
  return { runtime, binding, current };
}

test("the declared host carriage is per-user-turn and claims no provider confirmation", () => {
  assert.deepEqual(PI_WORKING_STATE_INPUT_CAPABILITY, {
    carriage: "per-user-turn",
    confirmation: "unsupported",
  });
});

test("one complete temporary body is prepared, fenced to its snapshot, and kept out of the mixed projection", () => {
  const { runtime, current } = state();
  assert.equal(current.text, "[temporary] Plan with exact constraint=123");
  assert.equal(current.sessionId, "input-session");
  assert.equal(current.textHash.length, 64);
  assert.equal(
    renderSessionActiveGraphSurface(runtime.snapshot("input-session"), undefined, {
      includeWorkingState: false,
    }),
    "",
  );
});

test("preparation fails closed on an absent snapshot, a missing capture or an over-budget body", () => {
  assert.equal(prepareWorkingStateInput(null), null);
  const empty = new SessionActiveGraphRuntime();
  empty.bindWorkingState("input-session");
  assert.equal(prepareWorkingStateInput(empty.snapshot("input-session")), null);
  const { runtime } = state();
  assert.equal(prepareWorkingStateInput(runtime.snapshot("input-session"), 1), null);
});

test("clearing state or disclosures never deletes resident content", () => {
  const { runtime, binding, current } = state();
  runtime.clearDisclosures("input-session");
  assert.equal(prepareWorkingStateInput(runtime.snapshot("input-session"))?.text, current.text);
  assert.equal(
    runtime.snapshot("input-session")!.items[0].statement,
    "Plan with exact constraint=123",
  );
  runtime.clearWorkingState(binding);
  assert.equal(prepareWorkingStateInput(runtime.snapshot("input-session")), null);
  assert.deepEqual(runtime.snapshot("input-session")!.disclosures, []);
});
