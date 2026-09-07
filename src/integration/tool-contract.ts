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
  "unsubscribe",
  "subscribe",
  "discover",
] as const;

export const PI_BOARD_ACTIONS = [...COMMON_BOARD_ACTIONS, "rename"] as const;
