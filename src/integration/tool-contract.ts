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

/** Keep source-clock fields intact in both RPC and CLI fallback transports. */
export function appendRememberTimeContext(
  input: Record<string, unknown>,
  params: Record<string, unknown>,
  argv: string[],
): void {
  for (const [key, flag] of [
    ["referenceTime", "--reference-time"],
    ["timeZone", "--time-zone"],
  ] as const) {
    if (input[key] === undefined) continue;
    params[key] = input[key];
    argv.push(flag, String(input[key]));
  }
}

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

/** One retrieval parameter, described once in JSON Schema. */
export interface SearchParameterContract {
  name: string;
  /** Spread into an adapter's own schema object. An adapter may enrich the
   *  prose from the prompt catalog, but not the type or the bound. */
  schema: Readonly<Record<string, unknown>>;
  required?: boolean;
}

/**
 * What a memory search accepts, independent of host.
 *
 * Every adapter projects this table into its native schema library — JSON
 * Schema, TypeBox (`Type.Unsafe`), zod (`z.string()`) — so a retrieval
 * capability reaches all of them or none. Host-only fields (`recallCue`,
 * `secondPass`, `queries`) stay in the adapter: they describe a host's own
 * turn machinery, not what the store can be asked.
 */
export const SEARCH_TOOL_PARAMETERS: readonly SearchParameterContract[] = [
  {
    name: "query",
    required: true,
    schema: { type: "string", description: "Focused recall query." },
  },
  {
    name: "limit",
    schema: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Return 1..50 records (default 8).",
    },
  },
  {
    name: "maxTier",
    schema: { type: "integer", minimum: 0, maximum: 3, description: "Deepest memory tier 0..3." },
  },
  {
    name: "graphHops",
    schema: { type: "integer", minimum: 0, maximum: 3, description: "Graph expansion 0..3." },
  },
  {
    name: "nodeName",
    schema: { type: "string", description: "Restrict to one semantic node." },
  },
  {
    name: "sourceActor",
    schema: {
      type: "string",
      enum: ["user", "assistant", "system", "tool"],
      description: "Restrict evidence actor.",
    },
  },
  {
    name: "includeHistorical",
    schema: { type: "boolean", description: "Include inactive/superseded memories." },
  },
  {
    name: "scope",
    schema: {
      type: "object",
      additionalProperties: { type: "string" },
      description: 'Applicability scope, e.g. {"project":"nmg"}.',
    },
  },
  {
    name: "eventTimeFrom",
    schema: {
      type: "string",
      description:
        'Earliest event time to return, inclusive. A date ("2026-01-01") or a phrase ("上个月", "上周三"); a date covers its whole day.',
    },
  },
  {
    name: "eventTimeTo",
    schema: {
      type: "string",
      description:
        'Latest event time to return, inclusive. "as of" style: a date covers that whole day.',
    },
  },
];

export const SEARCH_REQUIRED_PARAMETERS: readonly string[] = SEARCH_TOOL_PARAMETERS.filter(
  (parameter) => parameter.required,
).map((parameter) => parameter.name);

/** JSON Schema `properties` object for the shared retrieval parameters. */
export function searchParameterProperties(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    SEARCH_TOOL_PARAMETERS.map((parameter) => [parameter.name, { ...parameter.schema }]),
  );
}

/** The contract's own description, for a schema library that cannot take JSON
 *  Schema verbatim (zod). */
export function searchParameterDescription(name: string): string {
  const found = SEARCH_TOOL_PARAMETERS.find((parameter) => parameter.name === name);
  const description = found?.schema.description;
  if (typeof description !== "string") throw new Error(`unknown search parameter: ${name}`);
  return description;
}
