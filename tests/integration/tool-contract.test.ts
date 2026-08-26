import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

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
    ["feedback"],
  );
});

test("Pi, MCP, and DSH schemas consume the shared action contract", () => {
  const sources = [
    ["../../.pi/extensions/nmg/index.ts", /PI_BOARD_ACTIONS/u, /PI_REMEMBER_ACTIONS/u],
    [
      "../../claude-plugins/nmg-memory/agents/memory-copilot.ts",
      /COMMON_BOARD_ACTIONS/u,
      /COMMON_REMEMBER_ACTIONS/u,
    ],
    ["../../dsh/dsh-nmg/src/plugin/index.ts", /COMMON_BOARD_ACTIONS/u, /COMMON_REMEMBER_ACTIONS/u],
  ] as const;
  for (const [relativePath, boardContract, rememberContract] of sources) {
    const source = readFileSync(resolve(import.meta.dirname, relativePath), "utf8");
    assert.match(source, boardContract);
    assert.match(source, rememberContract);
  }
});

test("Pi, MCP, and DSH render through the shared agent surface", () => {
  const sources = [
    "../../.pi/extensions/nmg/index.ts",
    "../../claude-plugins/nmg-memory/agents/memory-copilot.ts",
    "../../dsh/dsh-nmg/src/plugin/index.ts",
  ] as const;
  for (const relativePath of sources) {
    const source = readFileSync(resolve(import.meta.dirname, relativePath), "utf8");
    assert.match(source, /renderSearchSurface/u);
    assert.match(source, /renderEvidenceSurface/u);
    assert.match(source, /renderRememberSurface/u);
    assert.match(source, /renderTaskBoardSurface/u);
  }
});
