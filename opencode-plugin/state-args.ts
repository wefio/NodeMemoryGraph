// Argument assembly for the nmg_state board branch (opencode adapter).
//
// The shared layer (src/integration/state.ts `stateOperation()`) speaks the
// tool-schema shape: a direction (`action: read|write`) plus a concrete
// `operation`. The OpenCode tool schema in index.ts mirrors that shape, while
// pi-style single-verb calls (`action=put`) remain valid payloads across
// adapters. Assembling the RPC payload here keeps the shared layer strict and
// the adapter tolerant: the concrete operation wins over the direction, the
// direction is derived from the operation table afterwards, and the
// session-scoped agent identity is attached deterministically instead of
// trusting caller-supplied fields.

import { boardStateDirection } from "../src/integration/state.ts";
import { WORLD_BOARD_ID } from "../src/core/types.ts";

/** Resolve the concrete board operation from tool arguments. Returns null when
 * no concrete verb can be determined — a bare direction (`write`) is never an
 * operation and must fail locally instead of producing a confusing daemon 400.
 * The literal `read` intentionally doubles as the concrete read verb. */
export function resolveBoardOperation(args: Record<string, unknown>): string | null {
  const raw = String(args.operation ?? args.action ?? "").trim();
  if (raw === "write") return null;
  return raw || null;
}

/** Build one `state` RPC payload for the board branch from tool arguments:
 *  the concrete operation, the derived direction (`read`/`write`), the
 *  resolved target channel, and the stable agent identity of the session. */
export function assembleBoardStateParams(
  args: Record<string, unknown>,
  sessionId: string,
  identity: { id: string; agentName: string },
): Record<string, unknown> {
  const operation = resolveBoardOperation(args);
  if (!operation)
    throw new Error(
      "nmg_state board requires a concrete operation (put/read/claim/...), not a bare direction",
    );
  const direction = boardStateDirection(operation, args.action);
  return {
    ...args,
    action: direction,
    space: "board",
    operation,
    taskId: String(args.taskId ?? "").trim() || WORLD_BOARD_ID,
    sessionId,
    agentId: identity.id,
    agentName: identity.agentName,
    sourceSessionId: sessionId,
  };
}
