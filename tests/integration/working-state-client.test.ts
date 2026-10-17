import assert from "node:assert/strict";
import test from "node:test";
import {
  captureWorkingStateInvocation,
  renderLabOutput,
} from "../../src/integration/lab-capabilities.ts";

const binding = {
  sessionId: "owner",
  agId: "ag",
  taskFrameId: "session",
  bindingId: "generation-a",
};

test("ordinary client captures context outside model input and never refreshes a supplied fence", async () => {
  let reads = 0;
  const status = async () => {
    reads++;
    return { action: "status", activation: { workingStateBinding: binding } };
  };
  const model = {
    action: "invoke",
    capability: "working_state",
    sessionId: "owner",
    operation: "replace",
    input: { text: "Keep current state." },
  };
  const captured = await captureWorkingStateInvocation(model, status);
  assert.deepEqual(captured.input, model.input);
  assert.deepEqual(captured.workingStateBinding, binding);
  assert.equal(reads, 1);
  await captureWorkingStateInvocation(captured, status);
  assert.equal(reads, 1, "retry must not borrow a newer frame binding");
  const plain = { action: "invoke", capability: "reasoning_workspace" };
  assert.equal(await captureWorkingStateInvocation(plain, status), plain);
  assert.equal(reads, 1);
});

test("missing or cross-session host context fails closed and does not manufacture a binding", async () => {
  const params = {
    action: "invoke",
    capability: "working_state",
    sessionId: "other",
  };
  await assert.rejects(
    captureWorkingStateInvocation(params, async () => ({ activation: null })),
    /binding/u,
  );
  await assert.rejects(
    captureWorkingStateInvocation(params, async () => ({
      activation: { workingStateBinding: binding },
    })),
    /binding/u,
  );
});

test("state tool output is a short acknowledgement, not a body echo or an acceptance", () => {
  for (const output of ["updated", "unchanged", "cleared"]) {
    assert.equal(
      renderLabOutput({
        action: "invoke",
        capability: "working_state",
        output,
      }),
      output,
    );
  }
  assert.match(renderLabOutput({ action: "list", capabilities: [] }), /capabilities/u);
});
