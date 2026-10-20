import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NmgStore } from "../../src/core/store.ts";
import { EVENT_NOTICE_CHANNEL } from "../../src/core/coordination-events.ts";
import type { BoardMessageInput } from "../../src/core/board-notifications.ts";

function fixture(run: (store: NmgStore, db: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), "nmg-notification-atomic-"));
  const path = join(dir, "fixture.sqlite");
  const store = new NmgStore(path);
  const db = new DatabaseSync(path);
  try {
    run(store, db);
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
function message(extra: Partial<BoardMessageInput> = {}): BoardMessageInput {
  return {
    agentId: "a",
    taskId: "channel",
    kind: "note",
    content: "Compare options",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...extra,
  };
}
function rejectOutbox(db: DatabaseSync) {
  db.exec(`CREATE TRIGGER reject_notice BEFORE INSERT ON task_board_entries
    WHEN NEW.task_id='${EVENT_NOTICE_CHANNEL}' BEGIN SELECT RAISE(ABORT,'fixture outbox failure'); END;`);
}
const invite = { key: "join", scopes: ["direct" as const], recipients: ["b"], invite: true };

test("outbox failure rolls back source, invitation replay key and all enrollment", () =>
  fixture((store, db) => {
    rejectOutbox(db);
    assert.throws(
      () => store.postBoardMessage(message({ notification: invite })),
      /fixture outbox failure/,
    );
    for (const table of [
      "task_board_entries",
      "board_channel_members",
      "board_notification_requests",
    ])
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
    db.exec("DROP TRIGGER reject_notice");
    const source = store.postBoardMessage(message({ notification: invite }));
    assert.ok(source.notificationOrigin);
    assert.equal(store.readInboxTaskBoard({ agentId: "b", agentName: "b" }).length, 1);
  }));

test("failed coalescing restores the old unread notice instead of losing both versions", () =>
  fixture((store, db) => {
    store.postBoardMessage(message({ notification: invite }));
    const old = store.postBoardMessage(message({ content: "First alternative" }));
    const before = db.prepare("SELECT COUNT(*) AS n FROM task_board_entries").get()?.n;
    rejectOutbox(db);
    assert.throws(
      () => store.postBoardMessage(message({ content: "Second alternative" })),
      /fixture outbox failure/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_board_entries").get()?.n, before);
    const notices = store.readInboxTaskBoard({ agentId: "b", agentName: "b" });
    assert.ok(notices.some((e) => e.notificationSourceId === old.id && e.status === "open"));
  }));

test("expired source retains only replay identity and cannot silently re-enroll after opt-out", () =>
  fixture((store) => {
    const input = message({ notification: invite });
    store.postBoardMessage(input);
    store.setBoardChannelSubscription({
      agentId: "b",
      sessionId: "old-session",
      taskId: "channel",
      subscribed: false,
    });
    store.pruneExpiredTaskBoardEntries("2100-01-01T00:00:00.000Z");
    assert.throws(() => store.postBoardMessage(input), /already committed.*source expired/);
    assert.deepEqual(
      store.listBoardChannelSubscriptions({ agentId: "b", sessionId: "new-session" }),
      [],
    );
  }));

test("same invitation key survives a session change without undoing unsubscribe; malformed/expired invitations leave no enrollment", () =>
  fixture((store) => {
    const input = message({ sourceSessionId: "first-session", notification: invite });
    const first = store.postBoardMessage(input);
    store.setBoardChannelSubscription({
      agentId: "b",
      sessionId: "b-session",
      taskId: "channel",
      subscribed: false,
    });
    assert.equal(
      store.postBoardMessage({ ...input, sourceSessionId: "replacement-session" }).id,
      first.id,
    );
    assert.deepEqual(
      store.listBoardChannelSubscriptions({ agentId: "b", sessionId: "b-session" }),
      [],
    );
    assert.throws(
      () =>
        store.postBoardMessage(
          message({ kind: "question", notification: { ...invite, key: "question" } }),
        ),
      /kind=note/,
    );
    assert.throws(
      () =>
        store.postBoardMessage(
          message({
            notification: { ...invite, key: "expired" },
            expiresAt: "2000-01-01T00:00:00.000Z",
          }),
        ),
      /future expiresAt/,
    );
  }));

test("withdrawing one route preserves direct delivery and never resurrects old event-only notices", () =>
  fixture((store) => {
    const event = store.createCoordinationEvent({
      agentId: "a",
      title: "Feature",
      participants: ["b"],
    });
    const combined = store.postBoardMessage(
      message({
        eventId: event.id,
        notification: { key: "combined", scopes: ["direct", "event"], recipients: ["b"] },
      }),
    );
    const combinedNotice = store
      .readInboxTaskBoard({ agentId: "b", agentName: "b" })
      .find((e) => e.notificationSourceId === combined.id)!;
    store.unsubscribeCoordinationEvent({ eventId: event.id, agentId: "b" });
    assert.deepEqual(store.inactiveTaskBoardEntries([combinedNotice.id]), []);
    assert.deepEqual(
      store.getTaskBoardEntryById(combinedNotice.taskId, combinedNotice.id)?.notificationScopes,
      ["direct"],
    );
    store.subscribeCoordinationEvent({ eventId: event.id, agentId: "b" });
    const eventOnly = store.postBoardMessage(
      message({ eventId: event.id, notification: { key: "event-only", scopes: ["event"] } }),
    );
    const old = store
      .readInboxTaskBoard({ agentId: "b", agentName: "b" })
      .find((e) => e.notificationSourceId === eventOnly.id)!;
    store.unsubscribeCoordinationEvent({ eventId: event.id, agentId: "b" });
    store.subscribeCoordinationEvent({ eventId: event.id, agentId: "b" });
    assert.deepEqual(store.inactiveTaskBoardEntries([old.id]), [old.id]);
    assert.deepEqual(store.inactiveTaskBoardEntries([combinedNotice.id]), []);
  }));

test("ordinary event notes retain history without another notification round; typed progress still notifies", () =>
  fixture((store) => {
    const event = store.createCoordinationEvent({
      agentId: "a",
      title: "Feature",
      participants: ["b"],
    });
    const initial = store.readInboxTaskBoard({ agentId: "b", agentName: "b" });
    store.updateCoordinationEvent({
      agentId: "a",
      eventId: event.id,
      expectedRevision: 1,
      change: { kind: "note", text: "Acknowledged" },
    });
    assert.deepEqual(
      store.readInboxTaskBoard({ agentId: "b", agentName: "b" }).map((e) => e.id),
      initial.map((e) => e.id),
    );
    store.updateCoordinationEvent({
      agentId: "a",
      eventId: event.id,
      expectedRevision: 2,
      change: {
        kind: "channel",
        text: "Start comparison",
        channel: { channelId: "channel", summary: "Compare options", state: "active" },
      },
    });
    assert.equal(store.readInboxTaskBoard({ agentId: "b", agentName: "b" })[0]?.eventRevision, 3);
    assert.deepEqual(
      store.readCoordinationEvent(event.id).changes.map((c) => c.kind),
      ["created", "note", "channel"],
    );
  }));
