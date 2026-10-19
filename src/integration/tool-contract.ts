import type { BoardNoticeMetadata } from "../core/board-notifications.ts";

/** Host-neutral action contracts. Adapters keep their native schema library and
 * host-only fields, but must not silently omit these shared lifecycle actions. */
export const COMMON_REMEMBER_ACTIONS = [
  "save",
  "supersede",
  "relate",
  "forget",
  "resolve",
  "reopen",
  "feedback",
  "claim_outcome",
] as const;

export const PI_REMEMBER_ACTIONS = [...COMMON_REMEMBER_ACTIONS] as const;

export const COMMON_BOARD_ACTIONS = [
  "put",
  "read",
  "readInbox",
  "readPreviews",
  "resolve",
  "acknowledge",
  "claim",
  "release",
  "deliver",
  "judge",
  "unsubscribe",
  "subscribe",
  "discover",
] as const;

export const PI_BOARD_ACTIONS = [...COMMON_BOARD_ACTIONS, "rename"] as const;

/** A single board entry as it comes back over the daemon `taskBoard` RPC.
 * Adapters may extend it with host-only fields, but must not drop these. */
export interface TaskBoardToolEntry extends BoardNoticeMetadata {
  eventId?: string;
  eventRevision?: number;
  eventNotice?: boolean;
  id: string;
  taskId?: string;
  sequence: number;
  agentId: string;
  sourceSessionId?: string | null;
  kind: string;
  status: string;
  content: string;
  claimedBy?: string | null;
  claimExpiresAt?: string | null;
  /** Directed delivery (A2A find→direct): stable agent_name to wake. Others
   * read-but-stay-silent. Null = ordinary broadcast to subscribers. */
  to?: string | null;
  /** Reply-gated serial handoff: 'pending' entries are queued and must not
   * wake until the outstanding one is claimed/resolved. */
  serialState?: "outstanding" | "pending" | "stale" | null;
  ackedBy?: string[];
  createdAt?: string;
}

export interface TaskBoardToolResult {
  action: "put" | "read" | "resolve" | "claim" | "release" | "acknowledge" | "discover";
  entry?: TaskBoardToolEntry;
  entries?: TaskBoardToolEntry[];
  nextCursor?: string | null;
  delivered?: string[];
  acked?: string[];
  /** discover: online agent roster (A2A discovery localised). */
  agents?: Array<{
    id: string;
    agentName: string;
    description: string | null;
    capabilities: string | null;
    lastSeenAt: string;
  }>;
  suppressed?: boolean;
}
