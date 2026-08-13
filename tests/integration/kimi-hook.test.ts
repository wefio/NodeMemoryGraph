import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { isBoardWakeCandidate } from "../../kimi-plugin/nmg-hook.mjs";

const hookPath = resolve(import.meta.dirname, "../../kimi-plugin/nmg-hook.mjs");

function runHook(payload: unknown): string {
  const dataDir = mkdtempSync(resolve(tmpdir(), "nmg-kimi-hook-test-"));
  const { status, stdout } = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, NMG_DATA_DIR: dataDir },
  });
  rmSync(dataDir, { recursive: true, force: true });
  assert.equal(status, 0);
  return stdout;
}

test("kimi board wake candidate respects kind, echo, broadcast, and claim lease liveness", () => {
  const now = Date.parse("2026-08-13T12:00:00.000Z");
  const base = {
    status: "open",
    kind: "question",
    content: "Review the adapter",
    agentId: "other",
    sourceSessionId: "other-session",
  };
  const wake = (entry: Record<string, unknown>) =>
    isBoardWakeCandidate({ ...base, ...entry }, { sessionId: "me", agentId: "me", now });

  assert.equal(wake({}), true);
  assert.equal(wake({ kind: "blocker" }), true);
  assert.equal(wake({ kind: "handoff" }), true);
  // Notify-only kinds are silent: pushing them is the acknowledgement storm.
  assert.equal(wake({ kind: "note" }), false);
  assert.equal(wake({ kind: "result" }), false);
  assert.equal(wake({ kind: "decision" }), false);
  assert.equal(wake({ kind: "goal" }), false);
  assert.equal(wake({ kind: undefined }), false);
  assert.equal(wake({ sourceSessionId: "me" }), false);
  assert.equal(wake({ content: "[NMG board 协作广播] meta" }), false);
  assert.equal(wake({ claimedBy: "worker", claimExpiresAt: "2026-08-13T13:00:00.000Z" }), false);
  assert.equal(wake({ claimedBy: "worker", claimExpiresAt: "2026-08-13T11:00:00.000Z" }), true);
});

test("kimi hook nudges on completion keywords, git commit, and stays silent otherwise", () => {
  const keyword = runHook({ hook_event_name: "UserPromptSubmit", prompt: "完成了，收工" });
  assert.match(keyword, /nmg_remember/);

  // Kimi may send prompts as ContentPart[] rather than a plain string.
  const contentParts = runHook({
    hook_event_name: "UserPromptSubmit",
    prompt: [{ type: "text", text: "wrapped up" }],
  });
  assert.match(contentParts, /nmg_nudge/);

  // PostToolUse is observational, so the commit nudge hooks PreToolUse.
  const commit = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git add . && git commit -m x" },
  });
  assert.match(commit, /nmg_nudge/);

  assert.equal(runHook({ hook_event_name: "UserPromptSubmit", prompt: "继续" }), "");
  assert.equal(
    runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
    }),
    "",
  );
  // Observational events never nudge.
  assert.equal(
    runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git commit -m x" },
    }),
    "",
  );
  assert.equal(runHook({ hook_event_name: "SessionStart" }), "");
});
