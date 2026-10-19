import assert from "node:assert/strict";
import test from "node:test";
import { NMG_CLI_COMMANDS } from "../../src/cli/commands.ts";

const build = (name: string, positionals: string[], options: Record<string, string> = {}) => {
  const spec = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === name);
  assert.ok(spec, `missing ${name}`);
  return spec.buildParams({
    positionals,
    options: new Map(Object.entries(options).map(([key, value]) => [key, [value]])),
    flags: new Set(),
  });
};

test("state CLI keeps direction and space in command words with domain arguments", () => {
  assert.deepEqual(build("state read ag", [], { "session-id": "owner" }), {
    action: "read",
    space: "ag",
    operation: "read",
    sessionId: "owner",
  });
  assert.deepEqual(
    build("state write ag", ["replace"], {
      "session-id": "owner",
      text: "Current state.",
    }),
    {
      action: "write",
      space: "ag",
      operation: "replace",
      sessionId: "owner",
      text: "Current state.",
      requester: "agent:cli",
    },
  );
  assert.deepEqual(
    build("state write board", ["put"], {
      "task-id": "test",
      agent: "worker",
      content: "Shared entry.",
    }),
    {
      action: "write",
      space: "board",
      operation: "put",
      taskId: "test",
      agentId: "worker",
      content: "Shared entry.",
    },
  );
});

test("state CLI preserves event payload objects and independent status notes", () => {
  assert.deepEqual(
    build("state write board", ["eventUpdate"], {
      agent: "worker",
      "event-id": "event-1",
      "event-json": JSON.stringify({ expectedRevision: 2, kind: "close", text: "Ended" }),
    }),
    {
      action: "write",
      space: "board",
      operation: "eventUpdate",
      agentId: "worker",
      eventId: "event-1",
      event: { expectedRevision: 2, kind: "close", text: "Ended" },
    },
  );
  assert.equal(
    (
      build("state write board", ["agentStatus"], { agent: "worker", text: "Waiting" }) as Record<
        string,
        unknown
      >
    ).text,
    "Waiting",
  );
  assert.throws(
    () => build("state write board", ["eventCreate"], { agent: "worker", "event-json": "{" }),
    /JSON/,
  );
});

test("state CLI preserves notification retry identity and rejects invalid JSON", () => {
  const notification = { key: "invite-1", scopes: ["direct"], recipients: ["b"], invite: true };
  const params = build("state write board", ["put"], {
    agent: "a",
    "task-id": "discussion",
    content: "Compare options",
    "notification-json": JSON.stringify(notification),
  }) as Record<string, unknown>;
  assert.deepEqual(params.notification, notification);
  assert.throws(
    () => build("state write board", ["put"], { agent: "a", "notification-json": "{" }),
    /JSON/,
  );
});

test("state AG commands require a resident daemon and reject extra positionals", () => {
  for (const name of ["state read ag", "state write ag"]) {
    assert.equal(
      NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === name)?.requiresResident,
      true,
    );
    assert.throws(() => build(name, ["read", "extra"], { "session-id": "owner" }), /operation/u);
  }
});
