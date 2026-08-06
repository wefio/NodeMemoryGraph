import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const hookPath = resolve(import.meta.dirname, "../../kimi-plugin/nmg-hook.mjs");

function runHook(payload: unknown): string {
  const { status, stdout } = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(status, 0);
  return stdout;
}

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
