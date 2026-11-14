import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ToolObservationEvent } from "../src/integration/tool-observation.ts";
import type { CodexBinding } from "./session.ts";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function exitCode(line: string, callId: unknown, turnId: string | undefined): number | undefined {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  const item = row.payload;
  if (
    row.type !== "response_item" ||
    item?.type !== "function_call_output" ||
    item.call_id !== callId ||
    row.metadata?.client_authored === true ||
    item.internal_chat_message_metadata_passthrough?.turn_id !== turnId ||
    typeof item.output !== "string"
  )
    return undefined;
  const match =
    /^(?:Chunk ID: [^\n]+\n)?Wall time: [\d.]+ seconds\nProcess exited with code (-?\d+)\n/.exec(
      item.output,
    );
  return match ? Number(match[1]) : undefined;
}

/** The host hook supplies stdout only for Bash in Codex 0.169. The native
 * transcript's matching result supplies final exit metadata. Its unstable format
 * is checked narrowly and bounded to the first 64 KiB and final 256 KiB. */
async function transcriptRows(
  payload: Record<string, unknown>,
  binding: CodexBinding,
): Promise<unknown[]> {
  if (
    typeof payload.transcript_path !== "string" ||
    !isAbsolute(payload.transcript_path) ||
    !binding.turnId
  )
    return [];
  const file = await open(payload.transcript_path, "r");
  try {
    const size = (await file.stat()).size;
    const header = Buffer.alloc(Math.min(size, 65536));
    await file.read(header, 0, header.length, 0);
    const first = JSON.parse(header.toString("utf8").split("\n")[0]!);
    if (first.type !== "session_meta" || first.payload?.id !== binding.nativeId) return [];
    const tail = Buffer.alloc(Math.min(size, 262144));
    await file.read(tail, 0, tail.length, size - tail.length);
    return tail
      .toString("utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } finally {
    await file.close();
  }
}

async function nativeShellExit(
  payload: Record<string, unknown>,
  binding: CodexBinding,
): Promise<number | undefined> {
  for (const row of await transcriptRows(payload, binding)) {
    const code = exitCode(JSON.stringify(row), payload.tool_use_id, binding.turnId);
    if (code !== undefined) return code;
  }
  return undefined;
}

export async function completedCodexTools(
  payload: Record<string, unknown>,
  binding: CodexBinding,
): Promise<Record<string, unknown>[]> {
  const calls = new Map<string, Record<string, unknown>>();
  const completed: Record<string, unknown>[] = [];
  for (const value of await transcriptRows(payload, binding)) {
    const row = object(value);
    const item = object(row.payload);
    const metadata = object(item.internal_chat_message_metadata_passthrough);
    if (
      row.type !== "response_item" ||
      metadata.turn_id !== binding.turnId ||
      object(row.metadata).client_authored === true
    )
      continue;
    if (
      item.type === "function_call" &&
      /^(exec_command|shell_command|apply_patch)$/.test(String(item.name))
    )
      calls.set(String(item.call_id), item);
    const call = calls.get(String(item.call_id));
    if (item.type !== "function_call_output" || !call) continue;
    const code = exitCode(JSON.stringify(row), item.call_id, binding.turnId);
    if (code === undefined) continue;
    let input;
    try {
      input = JSON.parse(String(call.arguments));
    } catch {
      continue;
    }
    completed.push({
      tool_name: call.name === "shell_command" ? "Bash" : call.name,
      tool_use_id: item.call_id,
      tool_input: input,
      tool_response: { exit_code: code, stdout: item.output },
    });
  }
  return completed;
}

function patchPaths(command: unknown, patch: boolean): string | undefined {
  if (!patch || typeof command !== "string") return undefined;
  return [...command.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)]
    .map((match) => match[1])
    .slice(0, 5)
    .join(", ");
}

export async function normalizeCodexToolResult(
  payload: Record<string, unknown>,
  binding: CodexBinding,
): Promise<ToolObservationEvent | null> {
  const name = String(payload.tool_name ?? "");
  if (name.startsWith("mcp__nmg")) return null;
  const result = object(payload.tool_response);
  const input = object(payload.tool_input);
  const shell = /^(Bash|shell|exec_command)$/i.test(name);
  let code = typeof result.exit_code === "number" ? result.exit_code : undefined;
  if (code === undefined && shell)
    code = await nativeShellExit(payload, binding).catch(() => undefined);
  const explicit = typeof result.isError === "boolean";
  const patch = name === "apply_patch";
  const paths = patchPaths(input.command, patch);
  return {
    toolName: shell ? "bash" : patch ? "edit" : name,
    input: { ...input, command: input.command ?? input.cmd, ...(paths ? { path: paths } : {}) },
    content: result.content ?? result.stdout ?? result.output ?? payload.tool_response,
    isError: code !== undefined ? code !== 0 : result.isError === true,
    outcomeKnown: code !== undefined || explicit,
  };
}
