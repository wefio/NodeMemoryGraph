import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const hookPath = resolve(import.meta.dirname, "../../kimi-plugin/nmg-hook.mjs");

function runHook(payload: unknown): Record<string, unknown> | null {
  const { status, stdout } = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(status, 0);
  return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : null;
}

test("kimi hook nudges on completion keywords, git commit, and stays silent otherwise", () => {
  const keyword = runHook({ hook_event_name: "UserPromptSubmit", prompt: "完成了，收工" });
  assert.match(String(keyword?.additionalContext), /nmg_remember/);

  // Kimi sends prompts as ContentPart[] rather than a plain string.
  const contentParts = runHook({
    hook_event_name: "UserPromptSubmit",
    prompt: [{ type: "text", text: "wrapped up" }],
  });
  assert.ok(contentParts?.additionalContext);

  const commit = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "git add . && git commit -m x" },
  });
  assert.ok(commit?.additionalContext);

  assert.equal(runHook({ hook_event_name: "UserPromptSubmit", prompt: "继续" }), null);
  assert.equal(
    runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
    }),
    null,
  );
  assert.equal(runHook({ hook_event_name: "SessionStart" }), null);
});
