import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgStore } from "../../src/core/store.ts";
import {
  prepareBoardWakeBatch,
  deliverBoardWakeBatch,
  enqueueBoardWakeBatch,
} from "../../src/integration/board-wake-batch.ts";
import type { WakeCandidate } from "../../src/integration/board-wake.ts";

const candidates = (count: number): WakeCandidate[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `notice-${i}`,
    taskId: "notices",
    sequence: i,
    agentId: `author-${i}`,
    kind: "note",
    status: "open",
    content: `Reply from author-${i}`,
    to: "receiver",
    notificationChannelId: i === count - 1 ? "other" : "discussion",
    notificationSourceId: `source-${i}`,
    notificationScopes: ["channel"],
  }));

test("one wake admits many authors with scope fairness and per-entry budget accounting", () => {
  const entries = candidates(64);
  const prepared = prepareBoardWakeBatch(entries, { maxCharacters: 2400 });
  assert.ok(prepared.entries.length > 2);
  assert.ok(prepared.entries.length < entries.length);
  assert.ok(prepared.entries.some((entry) => entry.notificationChannelId === "other"));
  assert.ok(prepared.information.text.length <= 2400);
  assert.equal(prepared.information.included.length, prepared.entries.length);
  assert.ok(prepared.information.omitted.length > 0);
});

test("batch sends once, receipts only admitted entries, and failed enqueue consumes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-wake-batch-"));
  const receipts: unknown[] = [];
  let sends = 0;
  const state = { budgetDate: "", budgetUsed: 0, lastWakeAt: 0 };
  const invoke = async (_method: string, params: unknown) => {
    if (_method === "hello") return { capabilities: ["board-wake-batches"] };
    if (_method === "state")
      return { result: { agentActivity: { state: "idle", capabilities: [], reports: [] } } };
    const p = params as { action: string };
    if (p.action === "deliveryCheck") return { delivered: [], acked: [], inactive: [] };
    if (p.action === "recordDelivery") receipts.push(params);
    return {};
  };
  const input = {
    entries: candidates(32),
    invoke,
    dataDir: dir,
    agentId: "receiver",
    sessionId: "s",
    now: Date.now(),
    state,
    config: { enabled: true, budget: 8, cooldownMs: 0, intervalMs: 60000, worldBroadcast: false },
    maxCharacters: 2400,
  };
  try {
    await assert.rejects(
      deliverBoardWakeBatch({
        ...input,
        sendWake: async () => {
          throw Error("enqueue failed");
        },
      }),
      /enqueue failed/,
    );
    assert.equal(state.budgetUsed, 0);
    assert.deepEqual(receipts, []);
    const sent = await deliverBoardWakeBatch({
      ...input,
      sendWake: async () => {
        sends++;
      },
    });
    assert.equal(sends, 1);
    assert.equal(state.budgetUsed, 1);
    assert.equal(receipts.length, 1);
    assert.deepEqual(
      (receipts[0] as { entryIds: string[] }).entryIds,
      sent.map((entry) => entry.id),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending channel replies survive coalescing and receipts cannot pin the first page", () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-wake-page-"));
  const store = new NmgStore(join(dir, "store.sqlite"));
  try {
    store.setBoardChannelSubscription({
      agentId: "receiver",
      sessionId: "s",
      taskId: "discussion",
      subscribed: true,
    });
    for (let i = 0; i < 240; i++)
      store.postBoardMessage({
        taskId: "discussion",
        agentId: `author-${i % 64}`,
        kind: "note",
        content: `Reply ${i}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    const first = store.readDirectedTaskBoard({
      agentId: "receiver",
      agentName: "receiver",
      pendingForSession: "s",
      limit: 200,
    });
    assert.equal(first.length, 200);
    for (const entry of first) store.recordTaskBoardDelivery({ entryId: entry.id, sessionId: "s" });
    const remaining = store.readDirectedTaskBoard({
      agentId: "receiver",
      agentName: "receiver",
      pendingForSession: "s",
      limit: 200,
    });
    assert.equal(remaining.length, 40);
    assert.ok(remaining.every((entry) => !first.some((old) => old.id === entry.id)));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlapping ticks and arrivals preserve the accepted batch boundary", async () => {
  let release!: () => void;
  let entered!: () => void;
  const accepted = new Promise<void>((done) => {
    entered = done;
  });
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const entries = candidates(8);
  const receipts: string[][] = [];
  const invoke = async (method: string, params: unknown) => {
    const p = params as { action?: string; entryIds?: string[] };
    if (method === "state")
      return { result: { agentActivity: { state: "unknown", reports: [], capabilities: [] } } };
    if (method === "hello") return { capabilities: ["board-wake-batches"] };
    if (p.action === "deliveryCheck") return { delivered: [], acked: [], inactive: [] };
    if (p.action === "recordDelivery") receipts.push(p.entryIds!);
    return {};
  };
  const input = {
    entries,
    invoke,
    agentId: "receiver",
    sessionId: "concurrent",
    dataDir: "fixture",
    sendWake: async () => {
      entered();
      await blocked;
    },
  };
  const first = enqueueBoardWakeBatch(input);
  await accepted;
  entries.push({ ...entries[0]!, id: "late", content: "Arrived after snapshot" });
  assert.deepEqual(await enqueueBoardWakeBatch(input), []);
  release();
  const delivered = await first;
  assert.equal(delivered.length, 8);
  assert.equal(receipts.length, 1);
  assert.ok(!receipts[0]!.includes("late"));
  const page = prepareBoardWakeBatch(candidates(300), { maxCharacters: 1_000_000 });
  assert.equal(page.entries.length, 200);
  assert.match(page.information.text, /100 additional sources remain pending/);
});
