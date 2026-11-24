import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleAdapterCapabilities,
  type SharedAdapterTool,
} from "../../src/integration/adapter-capability-assembly.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "../../src/integration/adapter-capability-catalog.ts";
import { createDaemonHealthTool } from "../../src/integration/daemon-health-tool.ts";
import { createGetTool } from "../../src/integration/get-tool.ts";
import { createLabTool, createReasonTool } from "../../src/integration/lab-tool.ts";
import { createRememberTool } from "../../src/integration/remember-tool.ts";
import { createSearchTool } from "../../src/integration/search-tool.ts";
import { createStateTool } from "../../src/integration/state-tool.ts";
import { assertSnapshotJsonSafe, findNonJsonValuePaths } from "../helpers/json-value-safety.ts";

function toSnapshotPayload(tool: SharedAdapterTool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

test("findNonJsonValuePaths catches undefined properties, functions, BigInt, NaN, class instances, and sparse arrays", () => {
  class Box {
    value = 1;
  }
  const sparse: unknown[] = [1];
  sparse[2] = 3;
  const badPayload = {
    name: "bad",
    description: undefined,
    fn: () => "nope",
    big: 10n,
    badNum: Number.NaN,
    instance: new Box(),
    sparse,
  };

  const issues = findNonJsonValuePaths(badPayload);
  assert.ok(issues.some((entry) => entry.includes("$.description: unsupported undefined")));
  assert.ok(issues.some((entry) => entry.includes("$.fn: unsupported function")));
  assert.ok(issues.some((entry) => entry.includes("$.big: unsupported bigint")));
  assert.ok(issues.some((entry) => entry.includes("$.badNum: non-finite number")));
  assert.ok(issues.some((entry) => entry.includes("$.instance: non-plain instance (Box)")));
  assert.ok(issues.some((entry) => entry.includes("$.sparse[1]: sparse array hole")));
});

test("every shared NMG tool produces a strictly JSON-snapshot-safe schema across variants", () => {
  const variants: Array<{ label: string; tool: SharedAdapterTool }> = [
    { label: "search(graph=true)", tool: createSearchTool(true) },
    { label: "search(graph=false)", tool: createSearchTool(false) },
    {
      label: "search(filtered)",
      tool: createSearchTool(true, ["query", "limit", "nodeName", "eventTimeFrom"]),
    },
    { label: "remember(default)", tool: createRememberTool() },
    {
      label: "remember(allowUnsafe,native-evidence)",
      tool: createRememberTool(undefined, { allowUnsafe: true, claimOutcome: "native-evidence" }),
    },
    {
      label: "remember(disabled,save-only)",
      tool: createRememberTool(["remember"], { claimOutcome: "disabled" }),
    },
    { label: "get(graph=true)", tool: createGetTool(true) },
    { label: "get(graph=false)", tool: createGetTool(false) },
    { label: "lab", tool: createLabTool() },
    { label: "reason", tool: createReasonTool() },
    { label: "state(ag)", tool: createStateTool(["ag"]) },
    { label: "state(ag,board)", tool: createStateTool(["ag", "board"]) },
    { label: "daemon", tool: createDaemonHealthTool() },
  ];

  for (const { label, tool } of variants) {
    assertSnapshotJsonSafe(toSnapshotPayload(tool), label);
  }
});

test("assembleAdapterCapabilities for DSH registers 6 strictly JSON-snapshot-safe tools", async () => {
  const registered: SharedAdapterTool[] = [];
  const noopService = () => undefined;
  const assembly = assembleAdapterCapabilities(ADAPTER_CAPABILITY_CATALOG.dsh.capabilities, {
    registerTool: (tool) => {
      registered.push(tool);
    },
    "automatic-recall": noopService,
    "state-context": noopService,
    "tool-observation": noopService,
    "completion-nudge": noopService,
    "answer-attribution": noopService,
    "board-delivery": noopService,
  });
  await assembly.ready;

  const names = registered.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "nmg_daemon",
    "nmg_get",
    "nmg_lab",
    "nmg_remember",
    "nmg_search",
    "nmg_state",
  ]);
  for (const tool of registered) {
    assertSnapshotJsonSafe(toSnapshotPayload(tool), `dsh:${tool.name}`);
  }
  await assembly.dispose();
});
