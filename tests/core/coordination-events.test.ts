import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgStore } from "../../src/core/store.ts";

function fixture(run: (store: NmgStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "nmg-events-"));
  const path = join(dir, "store.sqlite"),
    store = new NmgStore(path);
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("event history keeps channel evolution, ended discussions and failure independently of ordinary TTL", () => {
  fixture((store, path) => {
    const e = store.createCoordinationEvent({
      agentId: "a",
      title: "Interaction redesign",
      participants: ["b"],
    });
    store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "a",
      expectedRevision: 1,
      change: {
        kind: "channel",
        text: "Discuss alternatives",
        channel: { channelId: "A", summary: "Compare X and Y", state: "active" },
      },
    });
    store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "b",
      expectedRevision: 2,
      change: {
        kind: "channel",
        text: "X was abandoned",
        channel: { channelId: "A", summary: "X abandoned; choose Y", state: "abandoned" },
      },
    });
    store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "a",
      expectedRevision: 3,
      change: {
        kind: "channel",
        text: "Coordinate implementation",
        channel: { channelId: "B", summary: "Implement Y", state: "active" },
      },
    });
    const closed = store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "b",
      expectedRevision: 4,
      change: { kind: "close", text: "Ended without acceptance", outcome: "failed" },
    });
    assert.equal(closed.status, "ended");
    assert.equal(closed.outcome, "failed");
    store.pruneExpiredTaskBoardEntries("2099-01-01T00:00:00.000Z");
    const reopened = new NmgStore(path);
    try {
      const result = reopened.readCoordinationEvent(e.id, { afterRevision: 0, limit: 3 });
      assert.deepEqual(
        result.changes.map((c) => c.revision),
        [1, 2, 3],
      );
      assert.equal(result.nextRevision, 3);
      assert.equal(result.event.channels[0]?.state, "abandoned");
      const final = reopened.readCoordinationEvent(e.id, { afterRevision: 3 });
      assert.equal(final.changes.length, 2);
      assert.equal(final.nextRevision, undefined);
      assert.ok(final.channelDetails.every((channel) => !channel.available));
    } finally {
      reopened.close();
    }
  });
});

test("event revision updates reach an old reader; unsubscribe suppresses notices, resubscribe does not erase history", () => {
  fixture((store) => {
    const e = store.createCoordinationEvent({
      agentId: "a",
      title: "Feature discussion",
      participants: ["b"],
    });
    const initial = store
      .readDirectedTaskBoard({ agentId: "b", agentName: "b" })
      .filter((x) => x.eventNotice);
    assert.equal(initial.length, 1);
    store.acknowledgeTaskBoardEntry({ entryId: initial[0]!.id, agentId: "b" });
    store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "a",
      expectedRevision: 1,
      change: { kind: "close", text: "Discussion ended" },
    });
    const fresh = store
      .readDirectedTaskBoard({ agentId: "b", agentName: "b" })
      .filter((x) => x.eventRevision === 2);
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0]!.id, initial[0]!.id);
    assert.equal(fresh[0]!.kind, "note", "notification is not a request to claim work");
    store.unsubscribeCoordinationEvent({ eventId: e.id, agentId: "b" });
    assert.equal(
      store.readDirectedTaskBoard({ agentId: "b", agentName: "b" }).filter((x) => x.eventNotice)
        .length,
      0,
    );
    store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "a",
      expectedRevision: 2,
      change: { kind: "note", text: "Conclusion corrected" },
    });
    assert.equal(
      store.readDirectedTaskBoard({ agentId: "b", agentName: "b" }).filter((x) => x.eventNotice)
        .length,
      0,
    );
    store.subscribeCoordinationEvent({ eventId: e.id, agentId: "b" });
    assert.equal(store.readCoordinationEvent(e.id).changes.length, 3);
    assert.throws(
      () =>
        store.updateCoordinationEvent({
          eventId: e.id,
          agentId: "a",
          expectedRevision: 2,
          change: { kind: "note", text: "Lost update" },
        }),
      /revision/,
    );
    assert.equal(
      store.readCoordinationEvent(e.id).changes.length,
      3,
      "failed update must not append history/notices",
    );
  });
});

test("closing a parent does not close children or release somebody else's effect", () => {
  fixture((store) => {
    const parent = store.createCoordinationEvent({
      agentId: "a",
      title: "Development",
      participants: ["b"],
    });
    const child = store.createCoordinationEvent({
      agentId: "b",
      title: "Review",
      parentId: parent.id,
      dependencies: [parent.id],
    });
    store.updateCoordinationEvent({
      eventId: parent.id,
      agentId: "a",
      expectedRevision: 1,
      change: {
        kind: "effect",
        text: "Hold writes",
        effect: {
          id: "hold",
          resource: "shared checkout",
          condition: "owner review",
          state: "active",
        },
      },
    });
    store.updateCoordinationEvent({
      eventId: parent.id,
      agentId: "b",
      expectedRevision: 2,
      change: { kind: "close", text: "Attempt failed", outcome: "failed" },
    });
    assert.equal(store.readCoordinationEvent(child.id).event.status, "active");
    assert.equal(
      store.listCoordinationEvents({}).some((x) => x.id === parent.id),
      true,
      "active effects stay discoverable",
    );
    assert.throws(
      () =>
        store.updateCoordinationEvent({
          eventId: parent.id,
          agentId: "b",
          expectedRevision: 3,
          change: {
            kind: "effect",
            text: "Unauthorized release",
            effect: { id: "hold", resource: "shared checkout", condition: "", state: "released" },
          },
        }),
      /owner/,
    );
    assert.equal(store.readCoordinationEvent(parent.id).event.revision, 3);
  });
});

test("Agent status defaults idle, preserves notes and derives multiple task associations from task ownership", () => {
  fixture((store) => {
    store.registerTaskBoardAgent({ id: "a", agentName: "A" });
    assert.equal(store.getAgentWorkStatus("a").activity, "idle");
    store.setAgentStatusNote({ agentId: "a", text: "Waiting for feedback" });
    const e = store.createCoordinationEvent({ agentId: "a", title: "Release" });
    const first = store.putTaskBoardEntry({
      taskId: "work",
      agentId: "a",
      kind: "goal",
      content: "Review",
      eventId: e.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const second = store.putTaskBoardEntry({
      taskId: "work",
      agentId: "x",
      kind: "handoff",
      to: "a",
      content: "Test",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(
      store.getAgentWorkStatus("a").tasks.length,
      1,
      "receiving a handoff is not accepting it",
    );
    store.claimTaskBoardEntry({ taskId: "work", entryId: second.id, agentId: "a" });
    assert.equal(store.getAgentWorkStatus("a").tasks.length, 2);
    store.updateCoordinationEvent({
      eventId: e.id,
      agentId: "a",
      expectedRevision: 1,
      change: { kind: "close", text: "Event ended" },
    });
    assert.equal(store.getAgentWorkStatus("a").activity, "working");
    store.resolveTaskBoardEntry({ taskId: "work", entryId: first.id, agentId: "a" });
    assert.equal(store.getAgentWorkStatus("a").activity, "working");
    store.releaseTaskBoardEntry({ taskId: "work", entryId: second.id, agentId: "a" });
    assert.equal(store.getAgentWorkStatus("a").activity, "idle");
    assert.equal(store.getAgentWorkStatus("a").statusNote, "Waiting for feedback");
    store.registerTaskBoardAgent({ id: "a", agentName: "A" });
    assert.equal(
      store.getAgentWorkStatus("a").statusNote,
      "Waiting for feedback",
      "heartbeat/upsert does not erase note",
    );
  });
});
