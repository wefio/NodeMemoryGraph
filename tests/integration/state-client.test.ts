import assert from "node:assert/strict";
import test from "node:test";
import {
  captureStateInvocation,
  renderStateOutput,
  stateOperation,
} from "../../src/integration/state.ts";
import { prepareInformationOutput } from "../../src/integration/information-output.ts";

const binding = {
  sessionId: "owner",
  agId: "ag",
  taskFrameId: "session",
  bindingId: "generation-a",
};

test("state client captures AG fence once outside model parameters and preserves it on retry", async () => {
  let reads = 0;
  const status = async () => {
    reads++;
    return {
      action: "read",
      space: "ag",
      operation: "status",
      result: {
        action: "status",
        activation: { workingStateBinding: binding },
      },
    };
  };
  const params = {
    action: "write",
    space: "ag",
    operation: "replace",
    sessionId: "owner",
    text: "Current state.",
  };
  const captured = await captureStateInvocation(params, status);
  assert.deepEqual(captured.workingStateBinding, binding);
  assert.equal(captured.text, params.text);
  assert.equal(await captureStateInvocation(captured, status), captured);
  assert.equal(reads, 1);
  const board = { action: "write", space: "board", operation: "put" };
  assert.equal(await captureStateInvocation(board, status), board);
  assert.equal(reads, 1);
});

test("state client refuses absent or foreign bindings instead of creating an activation", async () => {
  const params = {
    action: "write",
    space: "ag",
    operation: "clear",
    sessionId: "other",
  };
  await assert.rejects(
    captureStateInvocation(params, async () => ({
      result: { action: "status", activation: null },
    })),
    /binding/u,
  );
  await assert.rejects(
    captureStateInvocation(params, async () => ({
      result: {
        action: "status",
        activation: { workingStateBinding: binding },
      },
    })),
    /binding/u,
  );
});

test("state operation validation rejects foreign AG fields and cross-space status envelopes", async () => {
  assert.equal(stateOperation({ action: "read", space: "ag" }), "read");
  assert.throws(
    () =>
      stateOperation({
        action: "write",
        space: "ag",
        operation: "replace",
        taskId: "foreign",
      } as never),
    /AG state field/u,
  );
  await assert.rejects(
    captureStateInvocation(
      { action: "write", space: "ag", operation: "clear", sessionId: "owner" },
      async () => ({
        action: "read",
        space: "board",
        operation: "status",
        result: {
          action: "status",
          activation: { workingStateBinding: binding },
        },
      }),
    ),
    /binding/u,
  );
});

test("state rendering uses prepared views unchanged and AG writes keep short acknowledgements", () => {
  const information = prepareInformationOutput([
    { body: "Source text.", requiredLabels: ["[temporary]"] },
  ]);
  assert.equal(
    renderStateOutput({
      action: "read",
      space: "ag",
      operation: "read",
      result: { action: "snapshot", snapshot: null },
      information,
    }),
    information.text,
  );
  assert.equal(
    renderStateOutput({
      action: "write",
      space: "ag",
      operation: "replace",
      result: {
        action: "invoke",
        capability: "working_state",
        operation: "replace",
        output: "updated",
      },
    }),
    "updated",
  );
});
