import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Any dispatch attempt, including a call that later fails validation or execution. */
export function attemptedToolCall(events: AgentSessionEvent[], toolName: string): boolean {
  return events.some(
    (event) =>
      (event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
      event.toolName === toolName,
  );
}

/** A completed, usable tool result. Required-tool assertions use this stricter signal. */
export function successfulToolCall(events: AgentSessionEvent[], toolName: string): boolean {
  return events.some(
    (event) =>
      event.type === "tool_execution_end" &&
      event.toolName === toolName &&
      !event.isError &&
      !(
        toolName === "nmg_remember" &&
        (event.result as { details?: { saved?: boolean } } | undefined)?.details?.saved === false
      ),
  );
}
