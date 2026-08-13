import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-task-board-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("task board shares attributed entries within one task and isolates other tasks", () => {
  withStore((store) => {
    const first = store.putTaskBoardEntry({
      taskId: "release-42",
      agentId: "scout-a",
      sourceSessionId: "session-a",
      kind: "result",
      content: "The parser tests pass.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const second = store.putTaskBoardEntry({
      taskId: "release-42",
      agentId: "scout-b",
      kind: "handoff",
      content: "Review the serializer next.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.putTaskBoardEntry({
      taskId: "unrelated",
      agentId: "scout-c",
      kind: "note",
      content: "Must remain isolated.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const page = store.readTaskBoard({ taskId: "release-42" });
    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      [first.id, second.id],
    );
    assert.deepEqual(
      page.entries.map((entry) => entry.agentId),
      ["scout-a", "scout-b"],
    );
    assert.equal(page.entries[0]!.sourceSessionId, "session-a");
    assert.equal(page.nextCursor, 2);
    assert.equal(store.readTaskBoard({ taskId: "unrelated" }).entries.length, 1);
  });
});

test("task board supports cursor reads, cross-agent resolution, and expiry", () => {
  withStore((store) => {
    const first = store.putTaskBoardEntry({
      taskId: "task-a",
      agentId: "agent-a",
      kind: "question",
      content: "Which schema should we use?",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const second = store.putTaskBoardEntry({
      taskId: "task-a",
      agentId: "agent-b",
      kind: "decision",
      content: "Use the versioned schema.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.putTaskBoardEntry({
      taskId: "task-a",
      agentId: "agent-c",
      kind: "note",
      content: "Expired scratch state.",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    const page = store.readTaskBoard({ taskId: "task-a", afterCursor: first.sequence });
    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      [second.id],
    );

    const resolved = store.resolveTaskBoardEntry({
      taskId: "task-a",
      entryId: first.id,
      agentId: "agent-b",
      resolution: "Answered by entry #2.",
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolvedBy, "agent-b");
    assert.equal(store.readTaskBoard({ taskId: "task-a" }).entries.length, 1);
    assert.equal(
      store.readTaskBoard({ taskId: "task-a", includeResolved: true }).entries.length,
      2,
    );
  });
});

test("task board content never enters semantic memory search", () => {
  withStore((store) => {
    store.putTaskBoardEntry({
      taskId: "task-a",
      agentId: "agent-a",
      kind: "note",
      content: "uniqueboardtoken should remain coordination-only",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.deepEqual(store.search("uniqueboardtoken"), []);
  });
});

test("task board lobby lists active named channels and hides the world channel", () => {
  withStore((store) => {
    const future = "2099-01-01T00:00:00.000Z";
    store.putTaskBoardEntry({
      taskId: "alpha",
      agentId: "agent-a",
      kind: "goal",
      content: "Alpha channel goal.",
      expiresAt: future,
    });
    store.putTaskBoardEntry({
      taskId: "beta",
      agentId: "agent-b",
      kind: "note",
      content: "Beta channel note.",
      expiresAt: future,
    });
    // The world channel itself must not appear in the lobby directory.
    store.putTaskBoardEntry({
      taskId: "default",
      agentId: "agent-c",
      kind: "note",
      content: "A lobby message.",
      expiresAt: future,
    });
    // Expired channels are pruned before listing.
    store.putTaskBoardEntry({
      taskId: "gone",
      agentId: "agent-d",
      kind: "note",
      content: "Expired.",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    // Fully resolved channels are not advertised as active.
    const done = store.putTaskBoardEntry({
      taskId: "done",
      agentId: "agent-e",
      kind: "result",
      content: "Finished.",
      expiresAt: future,
    });
    store.resolveTaskBoardEntry({ taskId: "done", entryId: done.id, agentId: "agent-e" });

    const boards = store.listTaskBoards();
    assert.deepEqual(boards.map((board) => board.taskId).sort(), ["alpha", "beta"]);
    const alpha = boards.find((board) => board.taskId === "alpha");
    assert.equal(alpha?.entryCount, 1);
    assert.ok(alpha?.lastUpdatedAt);
  });
});

test("task board claims are lease-based: CAS, conflict, heartbeat, lazy expiry", () => {
  withStore((store) => {
    const task = store.putTaskBoardEntry({
      taskId: "claim-1",
      agentId: "sender",
      kind: "question",
      content: "Who owns the SkillOpt gate?",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    // Open + unclaimed → claim succeeds with a lease.
    const claimed = store.claimTaskBoardEntry({
      taskId: "claim-1",
      entryId: task.id,
      agentId: "worker-a",
      leaseSeconds: 600,
      now: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(claimed.claimedBy, "worker-a");
    assert.equal(claimed.claimExpiresAt, "2026-08-12T00:10:00.000Z");
    assert.equal(claimed.status, "open");

    // Another agent → CAS loses with a conflict diagnosis.
    assert.throws(
      () =>
        store.claimTaskBoardEntry({
          taskId: "claim-1",
          entryId: task.id,
          agentId: "worker-b",
          now: "2026-08-12T00:01:00.000Z",
        }),
      /already claimed by worker-a/,
    );

    // The holder re-claims → heartbeat refreshes the lease.
    const heartbeated = store.claimTaskBoardEntry({
      taskId: "claim-1",
      entryId: task.id,
      agentId: "worker-a",
      leaseSeconds: 600,
      now: "2026-08-12T00:05:00.000Z",
    });
    assert.equal(heartbeated.claimExpiresAt, "2026-08-12T00:15:00.000Z");

    // After the lease lapses, another agent can claim (lazy expiry, no sweeper).
    const stolen = store.claimTaskBoardEntry({
      taskId: "claim-1",
      entryId: task.id,
      agentId: "worker-b",
      leaseSeconds: 600,
      now: "2026-08-12T00:16:00.000Z",
    });
    assert.equal(stolen.claimedBy, "worker-b");
  });
});

test("task board claims: only the holder releases; resolving clears the claim", () => {
  withStore((store) => {
    const task = store.putTaskBoardEntry({
      taskId: "claim-2",
      agentId: "sender",
      kind: "handoff",
      content: "Verify the wake loop.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.claimTaskBoardEntry({
      taskId: "claim-2",
      entryId: task.id,
      agentId: "worker-a",
      leaseSeconds: 600,
      now: "2026-08-12T00:00:00.000Z",
    });

    // Non-holder release is refused.
    assert.throws(
      () =>
        store.releaseTaskBoardEntry({
          taskId: "claim-2",
          entryId: task.id,
          agentId: "worker-b",
        }),
      /not claimed by worker-b/,
    );

    // Holder releases → back to unclaimed, claimable by anyone.
    const released = store.releaseTaskBoardEntry({
      taskId: "claim-2",
      entryId: task.id,
      agentId: "worker-a",
    });
    assert.equal(released.claimedBy, null);
    assert.equal(released.claimExpiresAt, null);

    const reclaimed = store.claimTaskBoardEntry({
      taskId: "claim-2",
      entryId: task.id,
      agentId: "worker-c",
      leaseSeconds: 600,
      now: "2026-08-12T00:01:00.000Z",
    });
    assert.equal(reclaimed.claimedBy, "worker-c");

    // Resolving clears the claim, and a claim on a resolved entry is refused.
    const resolved = store.resolveTaskBoardEntry({
      taskId: "claim-2",
      entryId: task.id,
      agentId: "worker-c",
      resolution: "done",
    });
    assert.equal(resolved.claimedBy, null);
    assert.throws(
      () =>
        store.claimTaskBoardEntry({
          taskId: "claim-2",
          entryId: task.id,
          agentId: "worker-d",
          now: "2026-08-12T00:02:00.000Z",
        }),
      /already resolved/,
    );
  });
});

test("task board delivery receipts are idempotent and drive re-notify suppression", () => {
  withStore((store) => {
    const entry = store.putTaskBoardEntry({
      taskId: "deliveries-1",
      agentId: "sender",
      kind: "question",
      content: "Any taker?",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(store.hasTaskBoardDelivery({ entryId: entry.id, sessionId: "session-a" }), false);
    store.recordTaskBoardDelivery({ entryId: entry.id, sessionId: "session-a" });
    assert.equal(store.hasTaskBoardDelivery({ entryId: entry.id, sessionId: "session-a" }), true);
    // Idempotent: re-acking is not an error (UNIQUE(entry_id, session_id)).
    store.recordTaskBoardDelivery({ entryId: entry.id, sessionId: "session-a" });
    assert.equal(store.hasTaskBoardDelivery({ entryId: entry.id, sessionId: "session-a" }), true);
    // Another session is not affected.
    assert.equal(store.hasTaskBoardDelivery({ entryId: entry.id, sessionId: "session-b" }), false);
  });
});

test("task board acknowledgements are per-agent, idempotent, visible on read, and RAII-bound", () => {
  withStore((store) => {
    const entry = store.putTaskBoardEntry({
      taskId: "acks-1",
      agentId: "sender",
      kind: "result",
      content: "QPP feeds tau calibration, not the SkillOpt gate.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    // Fresh entry: no acks yet.
    assert.deepEqual(entry.ackedBy, []);
    assert.equal(store.taskBoardAckedIds([entry.id], ["agent-a"]).has(entry.id), false);
    // Ack by two agents — logical "N checkmarks", physical rows.
    store.acknowledgeTaskBoardEntry({ entryId: entry.id, agentId: "agent-a" });
    store.acknowledgeTaskBoardEntry({ entryId: entry.id, agentId: "agent-b", reason: "agreed" });
    // Re-ack is idempotent (UNIQUE(entry_id, agent_id)); updates reason/timestamp.
    store.acknowledgeTaskBoardEntry({ entryId: entry.id, agentId: "agent-a" });
    assert.equal(store.taskBoardAckedIds([entry.id], ["agent-a"]).has(entry.id), true);
    assert.equal(store.taskBoardAckedIds([entry.id], ["agent-a", "agent-b"]).size, 1);
    // Visible on read (the "N checkmarks" per entry).
    const read = store.readTaskBoard({ taskId: "acks-1", includeResolved: true });
    assert.deepEqual(read.entries[0]!.ackedBy, ["agent-a", "agent-b"]);
    // An unrelated agent has not acked.
    assert.equal(store.taskBoardAckedIds([entry.id], ["agent-c"]).has(entry.id), false);
    // RAII: resolving the entry clears its acks (same binding as deliveries).
    store.resolveTaskBoardEntry({ taskId: "acks-1", entryId: entry.id, agentId: "sender" });
    assert.equal(store.taskBoardAckedIds([entry.id], ["agent-a", "agent-b"]).size, 0);
  });
});

test("task board suppression registry is session-scoped and reversible", () => {
  withStore((store) => {
    assert.equal(store.isTaskBoardSuppressed({ sessionId: "session-a", taskId: "noisy" }), false);
    store.suppressTaskBoard({ sessionId: "session-a", taskId: "noisy" });
    assert.equal(store.isTaskBoardSuppressed({ sessionId: "session-a", taskId: "noisy" }), true);
    // Idempotent opt-out.
    store.suppressTaskBoard({ sessionId: "session-a", taskId: "noisy" });
    assert.equal(store.isTaskBoardSuppressed({ sessionId: "session-a", taskId: "noisy" }), true);
    // Session-scoped: session-b is not suppressed, other channels not affected.
    assert.equal(store.isTaskBoardSuppressed({ sessionId: "session-b", taskId: "noisy" }), false);
    store.suppressTaskBoard({ sessionId: "session-b", taskId: "other" });
    assert.equal(store.isTaskBoardSuppressed({ sessionId: "session-a", taskId: "other" }), false);
    // Listing returns this session's suppressions.
    assert.deepEqual(
      store.listTaskBoardSuppressions("session-a").map((item) => item.taskId),
      ["noisy"],
    );
    // Re-subscribe removes it.
    store.unsuppressTaskBoard({ sessionId: "session-a", taskId: "noisy" });
    assert.equal(store.isTaskBoardSuppressed({ sessionId: "session-a", taskId: "noisy" }), false);
    assert.deepEqual(store.listTaskBoardSuppressions("session-a"), []);
  });
});

test("task board subscriptions are explicit topic membership: join to be woken, leave to be silent", () => {
  withStore((store) => {
    // Named channel: not a member until subscribe (no implicit subscription).
    assert.equal(
      store.isTaskBoardSubscribed({ sessionId: "session-a", taskId: "review-x" }),
      false,
    );
    assert.deepEqual(store.listTaskBoardSubscriptions("session-a"), []);
    // Join the channel (idempotent).
    store.subscribeTaskBoard({ sessionId: "session-a", taskId: "review-x" });
    store.subscribeTaskBoard({ sessionId: "session-a", taskId: "review-x" });
    assert.equal(store.isTaskBoardSubscribed({ sessionId: "session-a", taskId: "review-x" }), true);
    assert.deepEqual(
      store.listTaskBoardSubscriptions("session-a").map((item) => item.taskId),
      ["review-x"],
    );
    // Membership is per-session: session-b never joined.
    assert.equal(
      store.isTaskBoardSubscribed({ sessionId: "session-b", taskId: "review-x" }),
      false,
    );
    // Another channel joined by the same session.
    store.subscribeTaskBoard({ sessionId: "session-a", taskId: "review-y" });
    assert.deepEqual(
      store
        .listTaskBoardSubscriptions("session-a")
        .map((item) => item.taskId)
        .sort(),
      ["review-x", "review-y"],
    );
    // Leave: membership removed.
    store.unsubscribeTaskBoard({ sessionId: "session-a", taskId: "review-x" });
    assert.equal(
      store.isTaskBoardSubscribed({ sessionId: "session-a", taskId: "review-x" }),
      false,
    );
    assert.deepEqual(
      store.listTaskBoardSubscriptions("session-a").map((item) => item.taskId),
      ["review-y"],
    );
  });
});

test("delivery receipts are RAII-bound: cleared when the entry resolves or expires", () => {
  withStore((store) => {
    const entry = store.putTaskBoardEntry({
      taskId: "raii-resolve",
      agentId: "sender",
      kind: "question",
      content: "receipt lifecycle via resolve",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.recordTaskBoardDelivery({ entryId: entry.id, sessionId: "sess-a" });
    assert.equal(store.hasTaskBoardDelivery({ entryId: entry.id, sessionId: "sess-a" }), true);
    store.resolveTaskBoardEntry({ taskId: "raii-resolve", entryId: entry.id, agentId: "sender" });
    assert.equal(store.hasTaskBoardDelivery({ entryId: entry.id, sessionId: "sess-a" }), false);
  });
  withStore((store) => {
    const expiring = store.putTaskBoardEntry({
      taskId: "raii-expire",
      agentId: "sender",
      kind: "question",
      content: "receipt lifecycle via expiry",
      expiresAt: "2020-01-01T00:00:00.000Z", // already expired
    });
    store.recordTaskBoardDelivery({ entryId: expiring.id, sessionId: "sess-a" });
    assert.equal(store.hasTaskBoardDelivery({ entryId: expiring.id, sessionId: "sess-a" }), true);
    store.pruneExpiredTaskBoardEntries();
    assert.equal(store.hasTaskBoardDelivery({ entryId: expiring.id, sessionId: "sess-a" }), false);
    // The other delivery (for a live entry) survives a global prune.
    const live = store.putTaskBoardEntry({
      taskId: "raii-live",
      agentId: "sender",
      kind: "note",
      content: "still open",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.recordTaskBoardDelivery({ entryId: live.id, sessionId: "sess-a" });
    store.pruneExpiredTaskBoardEntries();
    assert.equal(store.hasTaskBoardDelivery({ entryId: live.id, sessionId: "sess-a" }), true);
  });
});

test("task board agent registry: register/heartbeat/discover with capability filter", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-task-board-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  const originalOnlineMs = process.env.NMG_AGENT_ONLINE_MS;
  try {
    process.env.NMG_AGENT_ONLINE_MS = "600000";
    store.registerTaskBoardAgent({
      agentName: "codex",
      description: "main coding agent",
      version: "1.0.0",
      capabilities: "stg,audit,blackboard",
    });
    store.registerTaskBoardAgent({
      agentName: "kimi",
      capabilities: "adapter,kimi-hook",
    });

    // discover returns all online agents, newest heartbeat first.
    const all = store.discoverTaskBoardAgents({});
    assert.deepEqual(all.map((a) => a.agentName).sort(), ["codex", "kimi"]);
    const codexAgent = all.find((a) => a.agentName === "codex")!;
    assert.equal(codexAgent.description, "main coding agent");

    // capability filter narrows the roster (A2A discovery semantics).
    const stg = store.discoverTaskBoardAgents({ capabilities: "stg" });
    assert.deepEqual(
      stg.map((a) => a.agentName),
      ["codex"],
    );
    const none = store.discoverTaskBoardAgents({ capabilities: "nonexistent" });
    assert.deepEqual(none, []);

    // heartbeat keeps an agent online and bumps last_seen.
    store.heartbeatTaskBoardAgent({ agentName: "kimi" });
    const again = store.discoverTaskBoardAgents({});
    assert.ok(again.find((a) => a.agentName === "kimi"));

    // A tiny online window, after a real pause, drops everyone (last_seen in
    // the past). Sleep avoids same-millisecond clock races.
    process.env.NMG_AGENT_ONLINE_MS = "1";
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stale = store.discoverTaskBoardAgents({});
    assert.deepEqual(stale, []);
  } finally {
    if (originalOnlineMs === undefined) delete process.env.NMG_AGENT_ONLINE_MS;
    else process.env.NMG_AGENT_ONLINE_MS = originalOnlineMs;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task board directed delivery stores the stable agent name in directed_to", () => {
  withStore((store) => {
    const directed = store.putTaskBoardEntry({
      taskId: "dir-1",
      agentId: "sender",
      kind: "handoff",
      content: "only codex should be woken",
      expiresAt: "2099-01-01T00:00:00.000Z",
      to: "codex",
    });
    assert.equal(directed.to, "codex");

    const broadcast = store.putTaskBoardEntry({
      taskId: "dir-1",
      agentId: "sender",
      kind: "note",
      content: "to everyone",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(broadcast.to, null);

    // read round-trips the directed_to column.
    const read = store.readTaskBoard({ taskId: "dir-1" });
    assert.equal(read.entries[0].to, "codex");
    assert.equal(read.entries[1].to, null);
  });
});

test("task board serial handoff: un-directed actionable is outstanding, next is pending", () => {
  withStore((store) => {
    const first = store.putTaskBoardEntry({
      taskId: "serial-1",
      agentId: "sender",
      kind: "handoff",
      content: "first actionable",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(first.serialState, "outstanding");

    // A second un-directed actionable queues behind the outstanding one.
    const second = store.putTaskBoardEntry({
      taskId: "serial-1",
      agentId: "sender",
      kind: "question",
      content: "queued",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(second.serialState, "pending");

    // Directed actionables are exempt from serialisation (parallel-safe).
    const directed = store.putTaskBoardEntry({
      taskId: "serial-1",
      agentId: "sender",
      kind: "handoff",
      content: "point-to-point",
      expiresAt: "2099-01-01T00:00:00.000Z",
      to: "kimi",
    });
    assert.equal(directed.serialState, null);

    // Notify-only kinds are never serialised.
    const note = store.putTaskBoardEntry({
      taskId: "serial-1",
      agentId: "sender",
      kind: "note",
      content: "fact",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(note.serialState, null);

    // Different channels are independent.
    const other = store.putTaskBoardEntry({
      taskId: "serial-2",
      agentId: "sender",
      kind: "blocker",
      content: "own queue",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(other.serialState, "outstanding");
  });
});
