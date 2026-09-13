/**
 * Retention: a reference that must outlive ordinary TTL pruning. The point is not the
 * column but the invariant — a consumer may hold a durable pointer at a board entry
 * (a verdict, a handoff) and re-derive its fact later, which is only true if the entry
 * survives the prune that would otherwise delete it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";

const PAST = "2000-01-01T00:00:00.000Z";
const NOW = "2026-01-01T00:00:00.000Z";
/** The claim and delivery happen on the entry's own timeline, before it expired; only then
 *  is the entry both attributable and past its TTL. */
const WHEN_LIVE = "1999-12-31T23:59:00.000Z";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-retention-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function expiredEntry(store: NmgStore, content = "an entry that is past its TTL") {
  const entry = store.putTaskBoardEntry({
    taskId: "retention-channel",
    agentId: "scout-a",
    kind: "result",
    content,
    expiresAt: PAST,
  });
  store.claimTaskBoardEntry({
    taskId: "retention-channel",
    entryId: entry.id,
    agentId: "scout-a",
    leaseSeconds: 600,
    now: WHEN_LIVE,
  });
  store.deliverTaskBoardEntry({
    taskId: "retention-channel",
    entryId: entry.id,
    agentId: "scout-a",
    digest: "d".repeat(64),
    now: WHEN_LIVE,
  });
  store.acknowledgeTaskBoardEntry({
    taskId: "retention-channel",
    entryId: entry.id,
    agentId: "scout-b",
    now: WHEN_LIVE,
  });
  return entry;
}

test("a retained entry, its delivery and its acknowledgement survive the prune", () => {
  withStore((store) => {
    const entry = expiredEntry(store);
    store.retainTaskBoardEntry({
      taskId: "retention-channel",
      entryId: entry.id,
      owner: "round-1",
      reason: "the run re-derives its verdict from this entry",
      now: NOW,
    });

    // Channel-scoped and global pruning are two code paths; both must exempt a retained
    // entry, so both are exercised here.
    assert.equal(
      store.pruneExpiredTaskBoardEntries(NOW, "retention-channel"),
      0,
      "nothing expired in that channel is prunable",
    );
    assert.equal(store.pruneExpiredTaskBoardEntries(NOW), 0, "nothing expired is prunable");
    const kept = store.getTaskBoardEntryById("retention-channel", entry.id);
    assert.ok(kept, "a retained entry outlives its own expiry");
    assert.equal(kept.deliverableDigest, "d".repeat(64), "its delivery stays with it");

    // Releasing the last pin makes it prunable again — retention defers the prune, it does
    // not exempt the entry from it.
    assert.equal(
      store.releaseTaskBoardRetention({
        taskId: "retention-channel",
        entryId: entry.id,
        owner: "round-1",
      }),
      true,
    );
    assert.equal(store.pruneExpiredTaskBoardEntries(NOW, "retention-channel"), 1);
    assert.equal(store.getTaskBoardEntryById("retention-channel", entry.id), null);
  });
});

test("each owner releases only its own pin", () => {
  withStore((store) => {
    const entry = expiredEntry(store);
    for (const owner of ["round-1", "round-2"])
      store.retainTaskBoardEntry({
        taskId: "retention-channel",
        entryId: entry.id,
        owner,
        reason: `${owner} references it`,
        now: NOW,
      });
    assert.deepEqual(
      store
        .listTaskBoardRetentions({ taskId: "retention-channel", entryId: entry.id })
        .map((row) => row.owner),
      ["round-1", "round-2"],
    );

    store.releaseTaskBoardRetention({
      taskId: "retention-channel",
      entryId: entry.id,
      owner: "round-1",
    });
    assert.equal(store.pruneExpiredTaskBoardEntries(NOW), 0, "round-2 still pins it");
    assert.ok(store.getTaskBoardEntryById("retention-channel", entry.id));
    store.releaseTaskBoardRetention({
      taskId: "retention-channel",
      entryId: entry.id,
      owner: "round-2",
    });
    assert.equal(store.pruneExpiredTaskBoardEntries(NOW), 1);
  });
});

test("a bounded pin stops pinning when its bound passes", () => {
  withStore((store) => {
    const entry = expiredEntry(store);
    store.retainTaskBoardEntry({
      taskId: "retention-channel",
      entryId: entry.id,
      owner: "round-1",
      reason: "evidence for as long as this run is retained",
      retainedUntil: "2026-06-01T00:00:00.000Z",
      now: NOW,
    });
    assert.equal(store.pruneExpiredTaskBoardEntries(NOW), 0);
    assert.equal(
      store.pruneExpiredTaskBoardEntries("2027-01-01T00:00:00.000Z"),
      1,
      "a caller that can name an end does not leak retention forever",
    );
  });
});

test("retention refuses a dangling reference or an unattributed pin, by name", () => {
  withStore((store) => {
    const entry = expiredEntry(store);
    assert.throws(
      () =>
        store.retainTaskBoardEntry({
          taskId: "retention-channel",
          entryId: "no-such-entry",
          owner: "round-1",
          reason: "r",
        }),
      /no such entry in this channel/u,
    );
    assert.throws(
      () =>
        store.retainTaskBoardEntry({
          taskId: "retention-channel",
          entryId: entry.id,
          owner: "   ",
          reason: "r",
        }),
      /retention owner required/u,
    );
    assert.throws(
      () =>
        store.retainTaskBoardEntry({
          taskId: "retention-channel",
          entryId: entry.id,
          owner: "round-1",
          reason: "",
        }),
      /retention reason required/u,
    );
    assert.throws(
      () =>
        store.retainTaskBoardEntry({
          taskId: "retention-channel",
          entryId: entry.id,
          owner: "round-1",
          reason: "r",
          retainedUntil: "whenever",
        }),
      /retainedUntil must be an ISO timestamp/u,
    );
    // The entry is in another channel: a channel-scoped reference must not resolve there.
    assert.throws(
      () =>
        store.retainTaskBoardEntry({
          taskId: "other-channel",
          entryId: entry.id,
          owner: "round-1",
          reason: "r",
        }),
      /no such entry in this channel/u,
    );
  });
});
