import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { syncLeafEmbeddings, syncRecordEmbeddings } from "../../src/core/embedding-sync.ts";
import { NmgStore } from "../../src/core/store.ts";

test("record embedding sync indexes only missing records and marks the index ready", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-embedding-sync-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  const calls: string[][] = [];
  const client = {
    indexId: "records@test",
    model: "test-model",
    profile: "plain",
    async embedDocuments(inputs: string[]) {
      calls.push(inputs);
      return inputs.map((_, index) => [1, index + 1]);
    },
  };
  try {
    store.remember({ statement: "Alpha memory", nodeName: "Alpha" });
    store.remember({ statement: "Beta memory", nodeName: "Beta" });

    const first = await syncRecordEmbeddings(store, client, 1);
    assert.equal(first.indexed, 2);
    assert.equal(first.health.status, "ready");
    assert.deepEqual(first.health.targets, ["records"]);
    assert.equal(first.health.pending.records, 0);
    assert.equal(calls.length, 2);

    const second = await syncRecordEmbeddings(store, client, 1);
    assert.equal(second.indexed, 0);
    assert.equal(calls.length, 2);

    store.remember({ statement: "Gamma memory", nodeName: "Gamma" });
    const third = await syncRecordEmbeddings(store, client, 8);
    assert.equal(third.indexed, 1);
    assert.equal(calls.length, 3);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("record embedding sync persists retryable failure state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-embedding-sync-failure-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    store.remember({ statement: "Alpha memory", nodeName: "Alpha" });
    await assert.rejects(
      syncRecordEmbeddings(store, {
        indexId: "failed@test",
        async embedDocuments() {
          throw new Error("provider offline");
        },
      }),
      /provider offline/u,
    );
    const health = store.embeddingIndexHealth("failed@test");
    assert.equal(health?.status, "failed");
    assert.match(health?.lastError ?? "", /provider offline/u);
    assert.equal(health?.pending.records, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("leaf embedding sync shares the lifecycle but writes leaf targets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-leaf-embedding-sync-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  const calls: string[][] = [];
  const client = {
    indexId: "leaves@test",
    async embedDocuments(inputs: string[]) {
      calls.push(inputs);
      return inputs.map(() => [1, 2, 3]);
    },
  };
  try {
    store.remember({ statement: "Alpha leaf memory", nodeName: "Alpha" });
    store.rebuildLeafBlocks();

    const first = await syncLeafEmbeddings(store, client, 1);
    assert.equal(first.indexed, 1);
    assert.equal(first.health.status, "ready");
    assert.deepEqual(first.health.targets, ["leaves"]);
    assert.equal(first.health.pending.leaves, 0);
    assert.equal(calls.length, 1);

    const second = await syncLeafEmbeddings(store, client, 1);
    assert.equal(second.indexed, 0);
    assert.equal(calls.length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
