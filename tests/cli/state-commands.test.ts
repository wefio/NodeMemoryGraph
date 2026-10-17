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

test("state AG commands require a resident daemon and reject extra positionals", () => {
  for (const name of ["state read ag", "state write ag"]) {
    assert.equal(
      NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === name)?.requiresResident,
      true,
    );
    assert.throws(() => build(name, ["read", "extra"], { "session-id": "owner" }), /operation/u);
  }
});
