import { messageText } from "./tool-observation.ts";

const COMPLETION_PATTERN =
  /(?:完成了|收工|搞定|结束|提交了|committed|done|finished|wrapped\s+up)/iu;

export const COMPLETION_NUDGE = [
  "<nmg_nudge>",
  "A code commit or task completion was just detected. NMG long-term memory is",
  "available: you may recall relevant decisions (nmg_search) or save this",
  "turn's key conclusions (nmg_remember) if useful. This is only a reminder;",
  "it does not affect the current work.",
  "</nmg_nudge>",
].join("\n");

/** A pre-execution reminder supplies no evidence that an operation succeeded. */
export function promptCompletionNudge(payload: {
  hook_event_name?: string;
  event?: string;
  prompt?: unknown;
  tool_name?: string;
  tool_input?: { command?: unknown };
}): string {
  const event = payload.hook_event_name ?? payload.event;
  if (event === "UserPromptSubmit") {
    return COMPLETION_PATTERN.test(messageText(payload.prompt)) ? COMPLETION_NUDGE : "";
  }
  if (event !== "PreToolUse" || !/^(bash|shell)$/iu.test(payload.tool_name ?? "")) return "";
  const command = payload.tool_input?.command;
  return typeof command === "string" && /\bgit\s+commit\b/u.test(command) ? COMPLETION_NUDGE : "";
}
