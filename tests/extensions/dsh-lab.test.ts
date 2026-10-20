import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("DSH adapter exposes the unified daemon Lab capability tool", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../dsh/dsh-nmg/src/plugin/index.ts"),
    "utf8",
  );
  assert.match(source, /name:\s*'nmg_lab'/u);
  assert.match(source, /invoke\('lab'/u);
  assert.match(source, /tools\.register\(labTool\)/u);
  assert.match(source, /controller_active/u);
  assert.match(source, /'recall_gate'/u);
  assert.match(source, /action: 'beginDisclosureTurn'/u);
  assert.match(source, /action: 'disclose'/u);
  assert.doesNotMatch(source, /recallWindows/u);
  assert.match(source, /projectDir: workspaceRoot, sessionId/u);
  assert.match(source, /recallCue: args\.recallCue/u);
  assert.match(source, /recallRevision: args\.recallRevision/u);
  assert.match(source, /nmgPrompts\.search_recall_cue_parameter_description/u);
  assert.doesNotMatch(source, /recallSource:/u);
});
