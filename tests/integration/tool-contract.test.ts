import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { createRememberTool } from "../../src/integration/remember-tool.ts";
import {
  COMMON_BOARD_ACTIONS,
  COMMON_REMEMBER_ACTIONS,
  PI_BOARD_ACTIONS,
  PI_REMEMBER_ACTIONS,
} from "../../src/integration/tool-contract.ts";

test("host-neutral action contracts are unique and Pi only adds host-owned actions", () => {
  for (const actions of [
    COMMON_BOARD_ACTIONS,
    COMMON_REMEMBER_ACTIONS,
    PI_BOARD_ACTIONS,
    PI_REMEMBER_ACTIONS,
  ]) {
    assert.equal(new Set(actions).size, actions.length);
  }
  for (const action of COMMON_BOARD_ACTIONS) assert.ok(PI_BOARD_ACTIONS.includes(action));
  for (const action of COMMON_REMEMBER_ACTIONS) assert.ok(PI_REMEMBER_ACTIONS.includes(action));
  assert.deepEqual(
    PI_BOARD_ACTIONS.filter((action) => !COMMON_BOARD_ACTIONS.includes(action as never)),
    ["rename"],
  );
  assert.deepEqual(
    PI_REMEMBER_ACTIONS.filter((action) => !COMMON_REMEMBER_ACTIONS.includes(action as never)),
    [],
  );
});

test("shared remember schema exposes recall triggers and only supported actions", () => {
  const tool = createRememberTool(["remember", "resolveRemember"]);
  assert.ok(Object.hasOwn(tool.inputSchema.properties, "recallTriggers"));
  assert.deepEqual(tool.inputSchema.properties.action.enum, [
    "save",
    "supersede",
    "relate",
    "forget",
    "resolve",
    "reopen",
  ]);
});

test("Pi, MCP, DSH, and OpenCode register and call shared definitions", () => {
  const sources = [
    "../../.pi/extensions/nmg/index.ts",
    "../../src/integration/mcp-tools.ts",
    "../../dsh/dsh-nmg/src/plugin/index.ts",
    "../../opencode-plugin/index.ts",
  ];
  for (const path of sources) {
    const source = readFileSync(resolve(import.meta.dirname, path), "utf8");
    assert.match(source, /tool\.inputSchema/u);
    assert.match(source, /tool\.execute/u);
  }
});
