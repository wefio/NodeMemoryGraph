import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { ADAPTER_CAPABILITY_CATALOG } from "../../src/integration/adapter-capability-catalog.ts";
import { createLabTool } from "../../src/integration/lab-tool.ts";

test("DSH adapter exposes the unified daemon Lab capability tool", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../dsh/dsh-nmg/src/plugin/index.ts"),
    "utf8",
  );
  assert.ok(ADAPTER_CAPABILITY_CATALOG.dsh.capabilities.includes("lab"));
  assert.match(source, /registerTool: tool => registerNativeTool/u);
  const labels = createLabTool().inputSchema.properties.capability.enum;
  assert.ok(labels.includes("controller_active"));
  assert.ok(labels.includes("recall_gate"));
  assert.match(source, /action: 'beginDisclosureTurn'/u);
  assert.match(source, /action: 'disclose'/u);
  assert.doesNotMatch(source, /recallWindows/u);
  assert.match(source, /projectDir: workspaceRoot, sessionId/u);
  assert.match(source, /recallCue: args\.recallCue/u);
  assert.match(source, /recallRevision: args\.recallRevision/u);
  assert.match(source, /nmgPrompts\.search_recall_cue_parameter_description/u);
  assert.doesNotMatch(source, /recallSource:/u);
});
