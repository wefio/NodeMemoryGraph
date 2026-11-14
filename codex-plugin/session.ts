import type { McpSessionBinding } from "../src/integration/mcp-tools.ts";

export interface CodexBinding extends McpSessionBinding {
  nativeId: string;
  turnId?: string;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid Codex host identifier");
  }
  return value.toLowerCase();
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bound(nativeId: string, turnId?: string): CodexBinding {
  const sessionId = `codex-${nativeId}`;
  return { nativeId, turnId, sessionId, agentId: sessionId };
}

/** Only the host's MCP envelope metadata supplies identity, never tool arguments. */
export function codexMcpBinding(metadata: Record<string, unknown> | undefined): CodexBinding {
  const native = record(metadata?.["x-codex-turn-metadata"]);
  if (!native.thread_id) throw new Error("Missing Codex host turn metadata");
  const id = identifier(native.thread_id);
  for (const candidate of [native.session_id, metadata?.threadId, metadata?.sessionId]) {
    if (candidate !== undefined && identifier(candidate) !== id)
      throw new Error("Codex host identity conflict");
  }
  return bound(id, identifier(native.turn_id));
}

export function codexHookBinding(payload: Record<string, unknown>): CodexBinding {
  return bound(
    identifier(payload.session_id),
    payload.turn_id === undefined ? undefined : identifier(payload.turn_id),
  );
}
