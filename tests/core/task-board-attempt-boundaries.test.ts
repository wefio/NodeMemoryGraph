import assert from "node:assert/strict";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { taskBoardClaimIsLive } from "../../src/core/store/base.ts";
import { claimAndDeliver } from "../support/task-board-behavior.ts";

const START = "2026-01-01T00:00:00.000Z";
const LAST_LIVE = "2026-01-01T00:00:59.999Z";
const AT_EXPIRY = "2026-01-01T00:01:00.000Z";

test("an expired holder starts a fresh attempt even when its identity is unchanged", (t) => {
  const store = new NmgStore(":memory:");
  t.after(() => store.close());
  const entry = store.putTaskBoardEntry({
    taskId: "same-holder-expiry",
    agentId: "coordinator",
    kind: "result",
    content: "Rework the artifact after the lease expires.",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const reference = { taskId: entry.taskId, entryId: entry.id };
  const first = claimAndDeliver(store, entry, {
    agentId: "worker-a",
    digest: "d1",
    now: START,
    leaseSeconds: 60,
  });
  assert.equal(first.attempt, 1);
  assert.equal(first.claimExpiresAt, AT_EXPIRY);

  // One millisecond before expiry, revision still belongs to the first attempt.
  const revised = store.deliverTaskBoardEntry({
    ...reference,
    agentId: "worker-a",
    digest: "d2",
    ref: "artifact/d2.patch",
    summary: "last live revision",
    now: LAST_LIVE,
  });
  assert.equal(revised.attempt, 1);
  const judged = store.judgeTaskBoardEntry({
    ...reference,
    agentId: "verifier-c",
    verdict: "accepted",
    reason: "reviewed d2",
    now: LAST_LIVE,
  });
  assert.equal(judged.judgedDigest, "d2");
  assert.equal(judged.verdict, "accepted");
  assert.equal(taskBoardClaimIsLive(judged, LAST_LIVE), true);
  assert.equal(taskBoardClaimIsLive(judged, AT_EXPIRY), false);

  assert.throws(
    () =>
      store.deliverTaskBoardEntry({
        ...reference,
        agentId: "worker-a",
        digest: "stale",
        now: AT_EXPIRY,
      }),
    /requires the live claim holder/u,
  );
  assert.deepEqual(store.getTaskBoardEntryById(entry.taskId, entry.id), judged);

  // Observe fencing before composing delivery: a successful new artifact must
  // not hide a stale verdict or make an expired self-claim look like a heartbeat.
  const reclaimed = store.claimTaskBoardEntry({
    ...reference,
    agentId: "worker-a",
    now: AT_EXPIRY,
    leaseSeconds: 60,
  });
  assert.equal(reclaimed.id, entry.id);
  assert.equal(reclaimed.attempt, 2);
  assert.equal(reclaimed.claimedAt, AT_EXPIRY);
  assert.equal(reclaimed.deliveredBy, null);
  assert.equal(reclaimed.deliveredAt, null);
  assert.equal(reclaimed.deliverableDigest, null);
  assert.equal(reclaimed.deliverableRef, null);
  assert.equal(reclaimed.deliverableSummary, null);
  assert.equal(reclaimed.verdict, null);
  assert.equal(reclaimed.judgedBy, null);
  assert.equal(reclaimed.judgedAt, null);
  assert.equal(reclaimed.judgedDigest, null);
  assert.equal(reclaimed.verdictReason, null);

  const next = claimAndDeliver(store, reclaimed, {
    agentId: "worker-a",
    digest: "d3",
    now: AT_EXPIRY,
    leaseSeconds: 60,
  });
  assert.equal(next.id, first.id);
  assert.equal(next.attempt, 2, "renewing the new live claim does not create attempt three");
  assert.equal(next.deliverableDigest, "d3");
  assert.equal(next.verdict, null);
  assert.equal(judged.judgedDigest, "d2", "the old observation remains a snapshot");
});

test("an expiry-boundary takeover changes delivery authority without blacklisting the old actor", (t) => {
  const store = new NmgStore(":memory:");
  t.after(() => store.close());
  const entry = store.putTaskBoardEntry({
    taskId: "different-holder-expiry",
    agentId: "coordinator",
    kind: "result",
    content: "Hand an expired attempt to another worker.",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const reference = { taskId: entry.taskId, entryId: entry.id };
  const first = claimAndDeliver(store, entry, {
    agentId: "worker-a",
    digest: "d1",
    now: START,
    leaseSeconds: 60,
  });
  const judged = store.judgeTaskBoardEntry({
    ...reference,
    agentId: "verifier-c",
    verdict: "accepted",
    now: LAST_LIVE,
  });
  assert.equal(judged.judgedDigest, "d1");
  assert.equal(judged.verdict, "accepted");

  assert.throws(
    () =>
      store.claimTaskBoardEntry({
        ...reference,
        agentId: "worker-b",
        now: LAST_LIVE,
        leaseSeconds: 60,
      }),
    /already claimed by worker-a/u,
  );
  assert.deepEqual(store.getTaskBoardEntryById(entry.taskId, entry.id), judged);

  const taken = store.claimTaskBoardEntry({
    ...reference,
    agentId: "worker-b",
    now: AT_EXPIRY,
    leaseSeconds: 60,
  });
  assert.equal(taken.id, first.id);
  assert.equal(taken.claimedBy, "worker-b");
  assert.equal(taken.attempt, 2);
  assert.equal(taken.deliverableDigest, null);
  assert.equal(taken.deliveredBy, null);
  assert.equal(taken.verdict, null);
  assert.equal(taken.judgedDigest, null);

  const next = claimAndDeliver(store, taken, {
    agentId: "worker-b",
    digest: "d2",
    now: AT_EXPIRY,
    leaseSeconds: 60,
  });
  assert.equal(next.id, first.id);
  assert.equal(next.attempt, 2);
  assert.equal(next.deliveredBy, "worker-b");
  assert.equal(next.deliverableDigest, "d2");
  assert.throws(
    () =>
      store.deliverTaskBoardEntry({
        ...reference,
        agentId: "worker-a",
        digest: "stale-d1",
        now: AT_EXPIRY,
      }),
    /requires the live claim holder/u,
  );
  assert.deepEqual(store.getTaskBoardEntryById(entry.taskId, entry.id), next);

  // Identity is not a permanent exclusion: the old deliverer is independent
  // of worker-b's current artifact and may judge that artifact, not inherit d1.
  const currentVerdict = store.judgeTaskBoardEntry({
    ...reference,
    agentId: "worker-a",
    verdict: "accepted",
    now: AT_EXPIRY,
  });
  assert.equal(currentVerdict.judgedBy, "worker-a");
  assert.equal(currentVerdict.verdict, "accepted");
  assert.equal(currentVerdict.judgedDigest, "d2");
  assert.throws(
    () =>
      claimAndDeliver(store, first, {
        agentId: "worker-a",
        digest: "stale-d1",
        now: AT_EXPIRY,
        leaseSeconds: 60,
      }),
    /already claimed by worker-b/u,
  );
  assert.deepEqual(store.getTaskBoardEntryById(entry.taskId, entry.id), currentVerdict);
});
