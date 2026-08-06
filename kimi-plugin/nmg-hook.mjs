#!/usr/bin/env node
/**
 * NMG write-reminder hook for Kimi Code CLI.
 *
 * Kimi Code hooks receive one JSON payload on stdin; for events that affect
 * the main flow (PreToolUse, Stop, UserPromptSubmit) stdout text is attached
 * to the context on exit 0. PostToolUse is observational — its output is
 * ignored — so the git-commit nudge must hook PreToolUse instead.
 *
 * Events handled:
 *   UserPromptSubmit — completion keywords (done/完成了/收工/…) → nudge
 *   PreToolUse(Bash) — `git commit` in the command              → nudge
 *
 * The nudge is a weak reminder, mirroring the Pi extension's completion
 * nudge (src/prompts/nmg-prompts.yaml): NMG memory is available; never a
 * forced write. Exit 0 always — this hook never blocks.
 *
 * Payload shapes are defensive: the prompt may be a plain string or a
 * ContentPart[] array ({type:"text", text}); both are handled.
 */

const NUDGE = [
  "<nmg_nudge>",
  "A code commit or task completion was just detected. NMG long-term memory is",
  "available: you may recall relevant decisions (nmg_search) or save this",
  "turn's key conclusions (nmg_remember) if useful. This is only a reminder;",
  "it does not affect the current work.",
  "</nmg_nudge>",
].join("\n");

const COMPLETION_PATTERN =
  /(?:完成了|收工|搞定|结束|提交了|committed|done|finished|wrapped\s+up)/iu;

function promptText(payload) {
  const prompt = payload?.prompt;
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function isGitCommit(payload) {
  const command = payload?.tool_input?.command;
  return typeof command === "string" && /\bgit\s+commit\b/u.test(command);
}

function shouldNudge(payload) {
  const event = payload?.hook_event_name ?? payload?.event;
  if (event === "UserPromptSubmit") return COMPLETION_PATTERN.test(promptText(payload));
  if (event === "PreToolUse") {
    const toolName = payload?.tool_name ?? "";
    return /^(bash|shell)$/iu.test(toolName) && isGitCommit(payload);
  }
  return false;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    if (shouldNudge(payload)) {
      // Plain stdout text is attached to the context; exit 0 = allow.
      process.stdout.write(NUDGE);
    }
  } catch {
    // A hook must never break the session: stay silent on malformed input.
  }
});
