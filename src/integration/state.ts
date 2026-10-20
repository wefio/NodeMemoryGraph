import type { NmgStateResult } from "../cli/protocol.ts";
import { renderLabOutput } from "./lab-capabilities.ts";
import {
  COORDINATION_OPERATIONS,
  COORDINATION_READ_OPERATIONS,
  COORDINATION_WRITE_OPERATIONS,
} from "./coordination-state.ts";
export { COORDINATION_OPERATIONS } from "./coordination-state.ts";

export function stateRequiresBoardEvents(params: Record<string, unknown>): boolean {
  return (
    params.space === "board" &&
    (params.eventId !== undefined ||
      params.notification !== undefined ||
      COORDINATION_OPERATIONS.has(String(params.operation)))
  );
}

export const STATE_AG_FIELDS = [
  "action",
  "space",
  "operation",
  "sessionId",
  "requester",
  "reason",
  "ttlSeconds",
  "text",
  "workingStateBinding",
] as const;

export const STATE_AG_READ_OPERATIONS = ["read", "status"] as const;
export const STATE_AG_WRITE_OPERATIONS = ["enable", "disable", "replace", "clear"] as const;
export const STATE_BOARD_READ_OPERATIONS = [
  ...COORDINATION_READ_OPERATIONS,
  "read",
  "readInbox",
  "readPreviews",
  "discover",
  "list",
] as const;
export const STATE_BOARD_WRITE_OPERATIONS = [
  ...COORDINATION_WRITE_OPERATIONS,
  "put",
  "resolve",
  "acknowledge",
  "claim",
  "release",
  "deliver",
  "judge",
  "unsubscribe",
  "subscribe",
  "rename",
] as const;

/** A verb normally decides direction; dual-direction verbs retain the requested direction. */
export function boardStateDirection(operation: string, requested: unknown): "read" | "write" {
  const read = (STATE_BOARD_READ_OPERATIONS as readonly string[]).includes(operation);
  const write = (STATE_BOARD_WRITE_OPERATIONS as readonly string[]).includes(operation);
  if (read && write && (requested === "read" || requested === "write")) return requested;
  return read ? "read" : "write";
}

/** Lease-only hosts check additive event fields before a resident older owner can ignore them. */
export async function requireBoardEventCapability(
  params: Record<string, unknown>,
  readHello: () => Promise<unknown>,
): Promise<void> {
  if (!stateRequiresBoardEvents(params)) return;
  const hello = (await readHello()) as { capabilities?: string[] } | null;
  if (!hello?.capabilities?.includes("board-events"))
    throw new Error("NMG daemon does not advertise board-events");
}

export const STATE_OPERATIONS = [
  ...new Set<string>([
    ...STATE_AG_READ_OPERATIONS,
    ...STATE_AG_WRITE_OPERATIONS,
    ...STATE_BOARD_READ_OPERATIONS,
    ...STATE_BOARD_WRITE_OPERATIONS,
  ]),
] as [string, ...string[]];

export function stateOperation(params: {
  action: string;
  space: string;
  operation?: string;
}): string {
  if (
    params.space === "ag" &&
    Object.entries(params).some(
      ([key, value]) =>
        value !== undefined && !(STATE_AG_FIELDS as readonly string[]).includes(key),
    )
  )
    throw new Error("Unsupported AG state field");
  const operation = params.operation ?? (params.action === "read" ? "read" : "");
  const table =
    params.space === "ag"
      ? params.action === "read"
        ? STATE_AG_READ_OPERATIONS
        : STATE_AG_WRITE_OPERATIONS
      : params.action === "read"
        ? STATE_BOARD_READ_OPERATIONS
        : STATE_BOARD_WRITE_OPERATIONS;
  if (
    !["ag", "board"].includes(params.space) ||
    !["read", "write"].includes(params.action) ||
    !(table as readonly string[]).includes(operation)
  )
    throw new Error(
      `Unsupported state space/direction/operation: ${params.space} ${params.action} ${operation}`,
    );
  return operation;
}

/** Host capture before transport. Supplied fences survive reconnect/retry unchanged. */
export async function captureStateInvocation(
  params: Record<string, unknown>,
  readStatus: (sessionId: string) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  if (
    params.action !== "write" ||
    params.space !== "ag" ||
    !["replace", "clear"].includes(String(params.operation)) ||
    params.workingStateBinding !== undefined
  )
    return params;
  if (typeof params.sessionId !== "string")
    throw new Error("state AG requires a host session binding");
  const binding = stateStatusBinding(await readStatus(params.sessionId));
  if (!binding || binding.sessionId !== params.sessionId)
    throw new Error("state AG requires an enabled host binding");
  return { ...params, workingStateBinding: Object.freeze({ ...binding }) };
}

function stateStatusBinding(value: unknown) {
  const status = value as NmgStateResult;
  const result = status?.result;
  return status?.space === "ag" &&
    status.action === "read" &&
    status.operation === "status" &&
    result?.action === "status"
    ? result.activation?.workingStateBinding
    : undefined;
}

/** No parsing or rewriting old rendered text: prepared domain views and short acks only. */
export function renderStateOutput(result: NmgStateResult): string {
  if (result.information) return result.information.text;
  if (result.space === "ag") return renderLabOutput(result.result);
  return JSON.stringify(result.result, null, 2);
}
