import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-chains-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Create `n` real memories with ascending event times, return their ids. */
function seedMemories(store: NmgStore, n: number, sessionId = "s1"): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = store.remember({
      nodeName: "预算",
      nodeKind: "topic",
      nodeSummary: "预算",
      statement: `阶段 ${i + 1} 的记忆 ${i + 1}`,
      eventTime: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      sessionId,
      sourceActor: "user",
    });
    ids.push(r.memory.id);
  }
  return ids;
}

test("createMemoryChain writes a typed, owned chain", () => {
  withStore((store) => {
    const temporal = store.createMemoryChain({
      chainType: "temporal",
      topic: "预算项目演进",
      ownerSessionId: "s1",
    });
    assert.equal(temporal.chainType, "temporal");
    assert.equal(temporal.topic, "预算项目演进");
    assert.equal(temporal.ownerSessionId, "s1");
    assert.equal(temporal.status, "active");

    const logical = store.createMemoryChain({
      chainType: "logical",
      topic: "图表依赖数据",
    });
    assert.equal(logical.chainType, "logical");
    assert.equal(logical.ownerSessionId, null);
  });
});

test("addMemoryToChain keeps ordered membership and getMemoryChain pulls the whole chain", () => {
  withStore((store) => {
    const mids = seedMemories(store, 3);
    const chain = store.createMemoryChain({ chainType: "temporal", topic: "演进" });
    mids.forEach((m, i) =>
      store.addMemoryToChain({ chainId: chain.id, memoryId: m, position: i, note: `阶段${i + 1}` }),
    );

    const got = store.getMemoryChain(chain.id)!;
    assert.equal(got.chain.topic, "演进");
    assert.deepEqual(
      got.members.map((m) => m.position),
      [0, 1, 2],
    );
    assert.deepEqual(
      got.members.map((m) => m.note),
      ["阶段1", "阶段2", "阶段3"],
    );
    assert.deepEqual(got.members.map((m) => m.memoryId), mids);
  });
});

test("a memory can join multiple chains (node reuse / cross-chain intersection)", () => {
  withStore((store) => {
    const mids = seedMemories(store, 2);
    const t = store.createMemoryChain({ chainType: "temporal", topic: "演进" });
    const l = store.createMemoryChain({ chainType: "logical", topic: "依赖" });
    for (const m of mids) store.addMemoryToChain({ chainId: t.id, memoryId: m, position: 0 });
    store.addMemoryToChain({ chainId: l.id, memoryId: mids[1]!, position: 1 });

    assert.equal(store.getMemoryChain(t.id)!.members.length, 2);
    assert.equal(store.getMemoryChain(l.id)!.members.length, 1);
    // same memory id appears in both chains
    assert.equal(store.getMemoryChain(l.id)!.members[0]!.memoryId, mids[1]);
  });
});

test("membership is idempotent (PK chain_id+memory_id) and remove works", () => {
  withStore((store) => {
    const mids = seedMemories(store, 2);
    const chain = store.createMemoryChain({ chainType: "logical", topic: "t" });
    store.addMemoryToChain({ chainId: chain.id, memoryId: mids[0]!, position: 1 });
    // duplicate append must not add a second row
    store.addMemoryToChain({ chainId: chain.id, memoryId: mids[0]! });
    assert.equal(store.getMemoryChain(chain.id)!.members.length, 1);

    store.addMemoryToChain({ chainId: chain.id, memoryId: mids[1]!, position: 2 });
    store.removeMemoryFromChain({ chainId: chain.id, memoryId: mids[1]! });
    assert.deepEqual(store.getMemoryChain(chain.id)!.members.map((m) => m.memoryId), [mids[0]]);
  });
});

test("getMemoryChain returns null for unknown chain; add to unknown chain throws", () => {
  withStore((store) => {
    assert.equal(store.getMemoryChain("nope"), null);
    assert.throws(() =>
      store.addMemoryToChain({ chainId: "nope", memoryId: "m", position: 0 }),
    );
  });
});

test("listMemoryChains filters by type and owner", () => {
  withStore((store) => {
    store.createMemoryChain({ chainType: "temporal", topic: "a", ownerSessionId: "s1" });
    store.createMemoryChain({ chainType: "temporal", topic: "b", ownerSessionId: "s2" });
    store.createMemoryChain({ chainType: "logical", topic: "c", ownerSessionId: "s1" });

    assert.equal(store.listMemoryChains({ chainType: "temporal" }).length, 2);
    assert.equal(store.listMemoryChains({ ownerSessionId: "s1" }).length, 2);
    assert.equal(
      store.listMemoryChains({ chainType: "temporal", ownerSessionId: "s1" }).length,
      1,
    );
    assert.equal(
      store.listMemoryChains({ ownerSessionId: "s2" }).map((c) => c.topic).join(),
      "b",
    );
  });
});

test("expandChains appends chain members after a hit (recall supplement, no re-rank)", () => {
  withStore((store) => {
    const mids: string[] = [];
    for (const stmt of [
      "预算跟踪器需求",
      "预算收支记录实现",
      "预算分类图表添加",
      "露营天气讨论",
    ]) {
      const r = store.remember({
        nodeName: "预算",
        nodeKind: "topic",
        nodeSummary: "预算",
        statement: stmt,
        sessionId: "s1",
        sourceActor: "user",
      });
      mids.push(r.memory.id);
    }
    const chain = store.createMemoryChain({
      chainType: "temporal",
      topic: "预算演进",
      ownerSessionId: "s1",
    });
    mids.slice(0, 3).forEach((m, i) =>
      store.addMemoryToChain({ chainId: chain.id, memoryId: m, position: i }),
    );
    const chainMemberIds = store.getMemoryChain(chain.id)!.members.map((m) => m.memoryId);

    // Without expansion, limit=1 returns only the single ranked hit.
    const off = store.searchContext("预算收支", { limit: 1, sessionId: "s1", expandChains: false });
    assert.equal(off.results.length, 1);
    assert.ok(off.results.every((r) => r.chainId === undefined));

    // With expansion, the whole chain surfaces (hit + appended members), the
    // unrelated memory does not, and every chain member carries its chainId.
    const on = store.searchContext("预算收支", { limit: 1, sessionId: "s1", expandChains: true });
    const onIds = on.results.map((r) => r.memory.id);
    for (const id of chainMemberIds) {
      assert.ok(onIds.includes(id), `chain member ${id} present in expanded results`);
    }
    assert.ok(!onIds.includes(mids[3]!), "unrelated memory stays out");
    for (const r of on.results) {
      if (chainMemberIds.includes(r.memory.id)) {
        assert.ok(r.chainId, `chainId set on expanded member ${r.memory.statement}`);
      }
    }
  });
});

test("expandChains does nothing for a hit outside any chain", () => {
  withStore((store) => {
    store.remember({
      nodeName: "天气",
      nodeKind: "topic",
      nodeSummary: "天气",
      statement: "露营天气讨论",
      sessionId: "s1",
      sourceActor: "user",
    });
    const w = store.searchContext("露营", { limit: 5, sessionId: "s1", expandChains: true });
    assert.ok(w.results.length >= 1);
    assert.ok(w.results.every((r) => r.chainId === undefined));
  });
});
