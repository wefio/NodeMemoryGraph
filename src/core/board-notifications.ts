import type { TaskBoardEntry, TaskBoardKind } from "./types.ts";
import { coordinationNames, coordinationText } from "./coordination-events.ts";

export type BoardNotificationScope = "direct" | "channel" | "event";
export interface BoardNotificationRequest {
  /** Stable across retries of the same invitation/notification, scoped to its author. */
  key: string;
  scopes: BoardNotificationScope[];
  recipients?: string[];
  invite?: boolean;
}
export interface BoardMessageInput {
  taskId: string;
  agentId: string;
  kind: TaskBoardKind;
  content: string;
  expiresAt: string;
  sourceSessionId?: string;
  eventId?: string;
  to?: string;
  notification?: BoardNotificationRequest;
}
export interface BoardNoticeMetadata {
  notificationSourceId?: string;
  notificationChannelId?: string;
  notificationScopes?: BoardNotificationScope[];
  invitation?: boolean;
  notificationOrigin?: boolean;
}
export function parseBoardNotification(value: unknown): BoardNotificationRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("notification must be an object");
  const data = value as Record<string, unknown>;
  const scopes = coordinationNames(data.scopes, "notification scopes");
  if (!scopes.length || scopes.some((s) => !["direct", "channel", "event"].includes(s)))
    throw new Error("notification scopes must select direct, channel or event");
  if (data.invite !== undefined && typeof data.invite !== "boolean")
    throw new Error("notification invite must be a boolean");
  return {
    key: coordinationText(data.key, "notification key", 200),
    scopes: scopes.sort() as BoardNotificationScope[],
    recipients: coordinationNames(data.recipients, "notification recipients").sort(),
    invite: data.invite === true,
  };
}
export function isBoardDiscussionNotice(entry: BoardNoticeMetadata & { to?: unknown }): boolean {
  return (
    typeof entry.to === "string" &&
    typeof entry.notificationSourceId === "string" &&
    entry.notificationSourceId.length > 0 &&
    typeof entry.notificationChannelId === "string" &&
    entry.notificationChannelId.length > 0 &&
    Array.isArray(entry.notificationScopes) &&
    entry.notificationScopes.length > 0 &&
    entry.notificationScopes.every((scope) => ["direct", "channel", "event"].includes(scope))
  );
}
export type BoardMessageWriter = {
  get(taskId: string, entryId: string): TaskBoardEntry | null;
  put(
    input: BoardMessageInput,
    port: import("./store/store-ctor.ts").TransactionPort,
  ): TaskBoardEntry;
  resolve(input: {
    taskId: string;
    entryId: string;
    agentId: string;
    resolution: string;
  }): TaskBoardEntry;
};
