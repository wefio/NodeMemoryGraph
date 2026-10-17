/** Host-neutral tool-observation primitives: message flattening, excerpting,
 * milestone detection, and trace summarization. Every harness adapter scores
 * tool results through these functions so "what counts as an observation" is
 * shared state, never adapter-local policy. */

/** Flatten host message content (string or chunk array) into plain text. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

export function excerpt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

/**
 * PostToolUse runtime-state capture (the tool result is the one event that
 * carries input + content + isError + per-tool details).
 */

/** True only when a git commit actually landed, so a failed or no-op commit
 *  never raises the completion nudge. */
export function isSuccessfulCommit(event: {
  toolName: string;
  isError: boolean;
  content: unknown;
  input?: unknown;
}): boolean {
  if (event.toolName !== "bash" || event.isError) return false;
  const command = String((event.input as { command?: unknown })?.command ?? "");
  if (!/\bgit\s+commit\b/.test(command)) return false;
  const output = messageText(event.content);
  return !/(?:nothing to commit|no changes added to commit|nothing added to commit)/iu.test(output);
}

/** Only tool results with lasting information value are captured as traces. */
export function isMemorableToolResult(event: {
  toolName: string;
  isError: boolean;
  content: unknown;
  input?: unknown;
}): boolean {
  if (event.isError) return true;
  const text = messageText(event.content);
  switch (event.toolName) {
    case "bash": {
      const command = String((event.input as { command?: unknown })?.command ?? "");
      const testRun =
        /\b(?:npm|pnpm|yarn|bun|npx|node|deno)\s+(?:run\s+)?test\b|(?:vitest|jest|pytest|go\s+test|cargo\s+test)/iu.test(
          command,
        );
      return testRun || /(?:error|fail(?:ed|ure)?|fatal|warning|exception|✗|FAILED)/iu.test(text);
    }
    case "edit":
    case "write":
      // File mutations are structural changes; capture the path.
      return true;
    case "grep":
      return text.trim().length > 0;
    default:
      return false;
  }
}

export function summarizeToolResult(event: {
  toolName: string;
  isError: boolean;
  content: unknown;
  input?: unknown;
}): { statement: string; nodeName: string } {
  const input = event.input as Record<string, unknown> | undefined;
  if (event.toolName === "edit" || event.toolName === "write") {
    const path = String(input?.path ?? input?.filePath ?? "?");
    const verb = event.toolName === "write" ? "Wrote" : "Edited";
    return {
      statement: `${verb} ${path}${event.isError ? " (tool returned an error)" : ""}.`,
      nodeName: path,
    };
  }
  const text = excerpt(messageText(event.content), 400);
  const status = event.isError ? " [error]" : "";
  return {
    statement: `Tool ${event.toolName}${status}: ${text || "(no text output)"}`,
    nodeName: `tool:${event.toolName}`,
  };
}
