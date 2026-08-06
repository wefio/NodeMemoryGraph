#!/usr/bin/env node
/**
 * NMG write-reminder hook for Kimi Code CLI.
 *
 * Kimi Code hooks speak the Claude-style JSON protocol: one JSON payload on
 * stdin, one JSON response on stdout. This script is dependency-free so it
 * runs anywhere Node does, and fast enough to sit on the prompt path.
 *
 * Events handled:
 *   UserPromptSubmit  — completion keywords (done/完成了/收工/…) → nudge
 *   PostToolUse(Bash) — `git commit` in the command             → nudge
 *
 * The nudge is a weak reminder injected as additionalContext, mirroring the
 * Pi extension's completion nudge (src/prompts/nmg-prompts.yaml): it reminds
 * the agent that NMG memory is available; it never forces a write.
 *
 * Payload shapes are defensive: Kimi sends UserPromptSubmit as ContentPart[]
 * (array of {type:"text", text}) while other clients send a plain string;
 * both are handled.
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
  if (event === "PostToolUse") {
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
      process.stdout.write(JSON.stringify({ additionalContext: NUDGE }));
    }
  } catch {
    // A hook must never break the session: stay silent on malformed input.
  }
});
