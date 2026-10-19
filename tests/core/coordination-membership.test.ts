import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NmgStore } from "../../src/core/store.ts";
import { ensureCoordinationSchema } from "../../src/core/store/coordination-schema.ts";

function fixture(run: (store: NmgStore) => void) {
  const store = new NmgStore(":memory:");
  try {
    run(store);
  } finally {
    store.close();
  }
}
test("task acceptance registers historical participation without undoing opt-out or treating a request as acceptance", () =>
  fixture((store) => {
    const e = store.createCoordinationEvent({ agentId: "owner", title: "Feature" });
    store.subscribeCoordinationEvent({ eventId: e.id, agentId: "worker" });
    assert.throws(
      () =>
        store.updateCoordinationEvent({
          eventId: e.id,
          agentId: "worker",
          expectedRevision: 1,
          change: { kind: "note", text: "Observer may not mutate" },
        }),
      /participants/,
    );
    store.unsubscribeCoordinationEvent({ eventId: e.id, agentId: "worker" });
    const task = store.putTaskBoardEntry({
      taskId: "channel",
      agentId: "owner",
      to: "worker",
      kind: "handoff",
      content: "Implement",
      eventId: e.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(store.getAgentWorkStatus("worker").activity, "idle");
    store.claimTaskBoardEntry({ taskId: "channel", entryId: task.id, agentId: "worker" });
    assert.deepEqual(
      store.readCoordinationEvent(e.id).members.find((m) => m.agentId === "worker"),
      { agentId: "worker", subscribed: false, associated: true },
    );
    assert.equal(store.getAgentWorkStatus("worker").tasks[0]?.eventId, e.id);
    store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "worker",
      expectedRevision: 1,
      change: { kind: "note", text: "Related work accepted" },
    });
    store.releaseTaskBoardEntry({ taskId: "channel", entryId: task.id, agentId: "worker" });
    assert.equal(store.getAgentWorkStatus("worker").activity, "idle");
    assert.equal(
      store.readCoordinationEvent(e.id).members.find((m) => m.agentId === "worker")?.associated,
      true,
    );
  }));
test("own goal auto-subscribes; stable-id notices survive display-name changes; cancellation invalidates queued notice", () =>
  fixture((store) => {
    const e = store.createCoordinationEvent({ agentId: "owner", title: "General discussion" });
    store.putTaskBoardEntry({
      taskId: "work",
      agentId: "worker",
      kind: "goal",
      content: "Own task",
      eventId: e.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(
      store.readCoordinationEvent(e.id).members.find((m) => m.agentId === "worker")?.subscribed,
      true,
    );
    store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "owner",
      expectedRevision: 1,
      change: { kind: "close", text: "Ended" },
    });
    const notices = store
      .readDirectedTaskBoard({ agentId: "worker", agentName: "renamed-agent" })
      .filter((entry) => entry.eventNotice);
    assert.equal(notices.length, 1);
    assert.throws(
      () =>
        store.claimTaskBoardEntry({
          taskId: notices[0]!.taskId,
          entryId: notices[0]!.id,
          agentId: "worker",
        }),
      /not claimable/,
    );
    assert.deepEqual(store.inactiveTaskBoardEntries([notices[0]!.id]), []);
    store.unsubscribeCoordinationEvent({ eventId: e.id, agentId: "worker" });
    assert.deepEqual(store.inactiveTaskBoardEntries([notices[0]!.id]), [notices[0]!.id]);
  }));
test("additive coordination migration preserves legacy board data and is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE task_board_entries(id TEXT PRIMARY KEY,content TEXT,[to] TEXT); CREATE TABLE task_board_agents(id TEXT PRIMARY KEY); INSERT INTO task_board_entries(id,content) VALUES('legacy','ordinary world message');",
    );
    ensureCoordinationSchema(db);
    ensureCoordinationSchema(db);
    const row = db
      .prepare(
        "SELECT content,coordination_notice,coordination_event_id FROM task_board_entries WHERE id='legacy'",
      )
      .get()!;
    assert.equal(row.content, "ordinary world message");
    assert.equal(row.coordination_notice, 0);
    assert.equal(row.coordination_event_id, null);
  } finally {
    db.close();
  }
});
test("archive deletion requires initiator, terminal lifecycle, released effects and no references", () =>
  fixture((store) => {
    const e = store.createCoordinationEvent({ agentId: "owner", title: "Archive" });
    assert.throws(
      () => store.deleteCoordinationEvent({ eventId: e.id, agentId: "owner", expectedRevision: 1 }),
      /End event/,
    );
    store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "owner",
      expectedRevision: 1,
      change: { kind: "close", text: "Ended", outcome: "failed" },
    });
    assert.throws(
      () =>
        store.deleteCoordinationEvent({ eventId: e.id, agentId: "stranger", expectedRevision: 2 }),
      /initiator/,
    );
    store.deleteCoordinationEvent({ eventId: e.id, agentId: "owner", expectedRevision: 2 });
    assert.throws(() => store.readCoordinationEvent(e.id), /not found/);
  }));
