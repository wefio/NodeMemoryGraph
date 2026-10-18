import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleBoardStateParams,
  resolveBoardOperation,
} from "../../opencode-plugin/state-args.ts";

const identity = { id: "sess_agent", agentName: "sess_agent" };

test("schema-shaped calls pass the concrete operation through and derive direction", () => {
  const read = assembleBoardStateParams(
    { action: "read", space: "board", operation: "read" },
    "session-1",
    identity,
  );
  assert.equal(read.operation, "read");
  assert.equal(read.action, "read");
  assert.equal(read.agentId, identity.id);
  assert.equal(read.sourceSessionId, "session-1");

  const put = assembleBoardStateParams(
    { action: "write", space: "board", operation: "put" },
    "session-1",
    identity,
  );
  assert.equal(put.operation, "put");
  assert.equal(put.action, "write");
});

test("channel resolution keeps an explicit taskId and defaults to the world board", () => {
  const explicit = assembleBoardStateParams(
    { action: "write", operation: "put", taskId: "  board-event-opencode-integration  " },
    "session-1",
    identity,
  );
  assert.equal(explicit.taskId, "board-event-opencode-integration");

  const fallback = assembleBoardStateParams(
    { action: "write", operation: "put", taskId: "   " },
    "session-1",
    identity,
  );
  assert.equal(fallback.taskId, "default");
});

test("legacy verb-shape calls still assemble (pi-style action=put tolerance)", () => {
  const legacy = assembleBoardStateParams({ action: "put" }, "session-1", identity);
  assert.equal(legacy.operation, "put");
  assert.equal(legacy.action, "write");
});

test("legacy direction-shaped calls fail closed instead of returning 'write' as the verb", () => {
  // Regression: the previous implementation used `String(args.action)` as the
  // operation, so a schema-shaped write call became operation:"write" — the
  // daemon rejected every board write with an INVALID_PARAMS 400 (read worked
  // only by collision). The fix must never reconstruct that payload.
  assert.equal(resolveBoardOperation({ action: "write" }), null);
  assert.equal(resolveBoardOperation({ action: "read", operation: "read" }), "read");
  assert.equal(resolveBoardOperation({ action: "put" }), "put");
});
