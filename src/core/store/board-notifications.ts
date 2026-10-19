import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TransactionPort } from "./store-ctor.ts";
import type { TaskBoardEntry } from "../types.ts";
import { WORLD_BOARD_ID } from "../types.ts";
import { EVENT_NOTICE_CHANNEL, coordinationText } from "../coordination-events.ts";
import {
  parseBoardNotification,
  type BoardMessageInput,
  type BoardMessageWriter,
  type BoardNotificationScope,
} from "../board-notifications.ts";

type Row = Record<string, unknown>;

export function setChannelMembership(
  db: DatabaseSync,
  taskId: string,
  agentId: string,
  subscribed: boolean,
): void {
  db.prepare(
    `INSERT INTO board_channel_members(task_id,agent_id,subscribed,subscribed_at) VALUES(?,?,?,?)
    ON CONFLICT(task_id,agent_id) DO UPDATE SET subscribed=excluded.subscribed,subscribed_at=excluded.subscribed_at`,
  ).run(taskId, agentId, Number(subscribed), new Date().toISOString());
}
function channelMember(db: DatabaseSync, taskId: string, agentId: string): boolean {
  return (
    db
      .prepare("SELECT subscribed FROM board_channel_members WHERE task_id=? AND agent_id=?")
      .get(taskId, agentId)?.subscribed === 1
  );
}
function eventMember(db: DatabaseSync, eventId: string, agentId: string): boolean {
  return (
    db
      .prepare("SELECT subscribed FROM coordination_event_members WHERE event_id=? AND agent_id=?")
      .get(eventId, agentId)?.subscribed === 1
  );
}
export function boardNoticeInactive(db: DatabaseSync, row: Row): boolean {
  if (typeof row.notification_source_id !== "string") return false;
  const channel = String(row.notification_channel_id),
    actor = String(row.to);
  if (row.notification_invitation === 1) return !channelMember(db, channel, actor);
  const scopes = JSON.parse(String(row.notification_scopes_json)) as BoardNotificationScope[];
  return !scopes.some(
    (scope) =>
      scope === "direct" ||
      (scope === "channel"
        ? channelMember(db, channel, actor)
        : eventMember(db, String(row.coordination_event_id), actor)),
  );
}

function scopeRecipients(
  db: DatabaseSync,
  input: BoardMessageInput,
  scope: BoardNotificationScope,
): string[] {
  if (scope === "direct") {
    const targets = [...(input.notification?.recipients ?? []), ...(input.to ? [input.to] : [])];
    if (!targets.length) throw Error("Direct notification requires recipients or to");
    return targets;
  }
  if (scope === "channel")
    return db
      .prepare("SELECT agent_id FROM board_channel_members WHERE task_id=? AND subscribed=1")
      .all(input.taskId)
      .map((row) => String(row.agent_id));
  if (!input.eventId) throw Error("Event notification requires eventId");
  const event = db.prepare("SELECT status FROM coordination_events WHERE id=?").get(input.eventId);
  if (!event || event.status !== "active")
    throw Error("Event notification requires an active eventId");
  return db
    .prepare("SELECT agent_id FROM coordination_event_members WHERE event_id=? AND subscribed=1")
    .all(input.eventId)
    .map((row) => String(row.agent_id));
}
function recipients(db: DatabaseSync, input: BoardMessageInput) {
  const scopes =
    input.notification?.scopes ?? (input.to || input.taskId === WORLD_BOARD_ID ? [] : ["channel"]);
  const result = new Map<string, Set<BoardNotificationScope>>();
  for (const scope of scopes) {
    for (const actor of scopeRecipients(db, input, scope as BoardNotificationScope)) {
      const selected = result.get(actor) ?? new Set<BoardNotificationScope>();
      selected.add(scope as BoardNotificationScope);
      result.set(actor, selected);
    }
  }
  return result;
}
function replay(
  db: DatabaseSync,
  writer: BoardMessageWriter,
  input: BoardMessageInput,
  digest: string,
): TaskBoardEntry | undefined {
  if (!input.notification) return undefined;
  const old = db
    .prepare(
      "SELECT entry_id,body_hash FROM board_notification_requests WHERE agent_id=? AND request_key=?",
    )
    .get(input.agentId, input.notification.key);
  if (!old) return undefined;
  if (old.body_hash !== digest)
    throw Error("Notification key already committed with different content or scope");
  const entry = writer.get(input.taskId, String(old.entry_id));
  if (!entry)
    throw Error(
      "Notification already committed; its source expired. Use a new key only for a genuinely new request",
    );
  return entry;
}
/** Retire the withdrawn route permanently, so resubscription cannot resurrect old alerts. */
export function retireBoardNoticeScope(
  db: DatabaseSync,
  writer: Pick<BoardMessageWriter, "resolve">,
  input: {
    agentId: string;
    scope: "channel" | "event";
    targetId: string;
  },
): void {
  const column = input.scope === "channel" ? "notification_channel_id" : "coordination_event_id";
  const rows = db
    .prepare(
      `SELECT * FROM task_board_entries WHERE notification_source_id IS NOT NULL
    AND [to]=? AND ${column}=? AND status='open'`,
    )
    .all(input.agentId, input.targetId);
  for (const row of rows) {
    if (input.scope === "event" && row.notification_invitation === 1) continue;
    const scopes = JSON.parse(String(row.notification_scopes_json)) as BoardNotificationScope[];
    if (!scopes.includes(input.scope) && row.notification_invitation !== 1) continue;
    const remaining = scopes.filter((scope) => scope !== input.scope);
    if (row.notification_invitation === 1 || !remaining.length)
      writer.resolve({
        taskId: String(row.task_id),
        entryId: String(row.id),
        agentId: input.agentId,
        resolution: "Notification scope unsubscribed",
      });
    else
      db.prepare("UPDATE task_board_entries SET notification_scopes_json=? WHERE id=?").run(
        JSON.stringify(remaining),
        String(row.id),
      );
  }
}

/** Coalescing only undelivered/unacknowledged notices preserves in-flight and read identities. */
export function coalesceNotices(
  db: DatabaseSync,
  writer: Pick<BoardMessageWriter, "resolve">,
  where: string,
  args: string[],
): void {
  const rows = db
    .prepare(
      `SELECT id,task_id,[to] FROM task_board_entries WHERE status='open' AND ${where}
    AND NOT EXISTS(SELECT 1 FROM task_board_deliveries d WHERE d.entry_id=task_board_entries.id)
    AND NOT EXISTS(SELECT 1 FROM task_board_acks a WHERE a.entry_id=task_board_entries.id)`,
    )
    .all(...args);
  for (const row of rows)
    writer.resolve({
      taskId: String(row.task_id),
      entryId: String(row.id),
      agentId: String(row.to),
      resolution: "Coalesced into a newer notice; source history remains readable",
    });
}
function writeNotice(
  db: DatabaseSync,
  writer: BoardMessageWriter,
  source: TaskBoardEntry,
  actor: string,
  scopes: Set<BoardNotificationScope>,
  invite: boolean,
  port: TransactionPort,
): void {
  const selected = [...scopes].sort();
  if (!invite && selected.length === 1 && selected[0] === "channel")
    coalesceNotices(
      db,
      writer,
      "notification_channel_id=? AND [to]=? AND notification_invitation=0 AND notification_scopes_json='[\"channel\"]'",
      [source.taskId, actor],
    );
  const label = invite
    ? "Invitation; channel subscription registered (you may leave)"
    : "Discussion update";
  const notice = writer.put(
    {
      taskId: EVENT_NOTICE_CHANNEL,
      agentId: source.agentId,
      sourceSessionId: source.sourceSessionId ?? undefined,
      kind: "note",
      to: actor,
      content: `${label}: channel=${source.taskId} entry=${source.id}\n${source.content}`,
      expiresAt: source.expiresAt,
    },
    port,
  );
  db.prepare(
    `UPDATE task_board_entries SET notification_source_id=?,notification_channel_id=?,notification_scopes_json=?,notification_invitation=?,coordination_event_id=? WHERE id=?`,
  ).run(
    source.id,
    source.taskId,
    JSON.stringify(selected),
    Number(invite),
    source.eventId ?? null,
    notice.id,
  );
}

function validateNewNotification(input: BoardMessageInput): void {
  if (!input.notification) return;
  if (input.kind !== "note")
    throw Error("Explicit notification messages use kind=note; publish claimable work separately");
  coordinationText(input.content, "notification content");
  if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())
    throw Error("New notification must have a future expiresAt");
}
function registerNotification(
  db: DatabaseSync,
  input: BoardMessageInput,
  entryId: string,
  digest: string,
  targets: Iterable<string>,
): void {
  if (!input.notification) return;
  db.prepare(
    "INSERT INTO board_notification_requests(agent_id,request_key,body_hash,entry_id) VALUES(?,?,?,?)",
  ).run(input.agentId, input.notification.key, digest, entryId);
  if (input.notification.invite)
    for (const actor of new Set([input.agentId, ...targets]))
      setChannelMembership(db, input.taskId, actor, true);
}
function isRoutedSource(db: DatabaseSync, input: BoardMessageInput, targetCount: number): boolean {
  if (input.notification) return true;
  if (input.to !== undefined) return false;
  if (targetCount > 0) return true;
  return (
    input.taskId !== WORLD_BOARD_ID &&
    (input.eventId !== undefined ||
      !!db.prepare("SELECT 1 FROM board_channel_members WHERE task_id=? LIMIT 1").get(input.taskId))
  );
}

/** The caller owns the transaction port: message, retry identity, enrollment and outbox commit together. */
export function writeBoardMessage(
  db: DatabaseSync,
  writer: BoardMessageWriter,
  raw: BoardMessageInput,
  port: TransactionPort,
): TaskBoardEntry {
  if (raw.taskId === EVENT_NOTICE_CHANNEL)
    throw Error("Reserved notification channel is not a public posting channel");
  const input = { ...raw, notification: parseBoardNotification(raw.notification) };
  if (input.notification?.recipients?.length && !input.notification.scopes.includes("direct"))
    throw Error("notification recipients require direct scope");
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        actor: input.agentId,
        channel: input.taskId,
        content: input.content,
        kind: input.kind,
        to: input.to,
        eventId: input.eventId,
        notification: input.notification,
      }),
    )
    .digest("hex");
  const previous = replay(db, writer, input, digest);
  if (previous) return previous;
  validateNewNotification(input);
  const targets = recipients(db, input);
  const source = writer.put(input, port);
  registerNotification(db, input, source.id, digest, targets.keys());
  const origin = isRoutedSource(db, input, targets.size);
  if (origin)
    db.prepare("UPDATE task_board_entries SET notification_origin=1 WHERE id=?").run(source.id);
  for (const [actor, scopes] of targets) {
    if (actor !== input.agentId)
      writeNotice(db, writer, source, actor, scopes, input.notification?.invite === true, port);
  }
  return origin ? { ...source, notificationOrigin: true } : source;
}
