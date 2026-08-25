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

    // With expansion, the chain surfaces (hit + appended members — all pass
    // the activation gate here: every statement shares query terms), the
    // unrelated memory does not, and every chain member carries its chainId.
    // Cap is explicit because the default cap scales with the ranked count
    // (limit=1 would otherwise admit a single appended member).
    const on = store.searchContext("预算收支", {
      limit: 1,
      sessionId: "s1",
      expandChains: true,
      chainExpansionMaxMembers: 10,
    });
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

test("chainExpansionWindow caps expansion to a window around the hit", () => {
  withStore((store) => {
    const mids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = store.remember({
        nodeName: "预算",
        nodeKind: "topic",
        nodeSummary: "预算",
        statement: `预算阶段${i}`,
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
    mids.forEach((m, i) => store.addMemoryToChain({ chainId: chain.id, memoryId: m, position: i }));

    // Hit lands on 阶段2 (position 2); window=1 keeps only positions 1..3.
    const win = store.searchContext("阶段2", {
      limit: 1,
      sessionId: "s1",
      expandChains: true,
      chainExpansionWindow: 1,
    });
    const stmts = win.results.map((r) => r.memory.statement);
    assert.ok(stmts.includes("预算阶段1"));
    assert.ok(stmts.includes("预算阶段2"));
    assert.ok(stmts.includes("预算阶段3"));
    assert.ok(!stmts.includes("预算阶段0"));
    assert.ok(!stmts.includes("预算阶段4"));

    // Without a window, activation gating applies: every member shares the
    // "阶段" bigram with the query, so all pass the gate.
    const full = store.searchContext("阶段2", {
      limit: 1,
      sessionId: "s1",
      expandChains: true,
      chainExpansionMaxMembers: 10,
    });
    assert.equal(full.results.length, 5);
  });
});

test("activation gate: proximity decays, importance escapes, cap keeps highest activation", () => {
  withStore((store) => {
    // Default importance 0.5 adds 0.25 static activation, so with θ=0.5 the
    // proximity term alone admits distance ≤ 3 from the hit.
    const stmts = [
      { statement: "起点" }, // pos0 — the ranked hit
      { statement: "内容填充一" }, // pos1: 0.50+0.25 → in
      { statement: "内容填充二" }, // pos2: 0.33+0.25 → in
      { statement: "内容填充三" }, // pos3: 0.25+0.25 → in (boundary)
      { statement: "内容填充四" }, // pos4: 0.20+0.25 → out
      { statement: "内容填充五", importance: 0.9 }, // pos5: 0.17+0.45 → in
    ];
    const mids: string[] = [];
    for (const s of stmts) {
      const r = store.remember({
        nodeName: "预算",
        nodeKind: "topic",
        nodeSummary: "预算",
        statement: s.statement,
        importance: s.importance,
        sessionId: "s1",
        sourceActor: "user",
      });
      mids.push(r.memory.id);
    }
    const chain = store.createMemoryChain({
      chainType: "temporal",
      topic: "门控",
      ownerSessionId: "s1",
    });
    mids.forEach((m, i) => store.addMemoryToChain({ chainId: chain.id, memoryId: m, position: i }));

    const res = store.searchContext("起点", {
      limit: 1,
      sessionId: "s1",
      expandChains: true,
      chainExpansionMaxMembers: 10,
    });
    const got = res.results.map((r) => r.memory.statement);
    for (const expected of ["起点", "内容填充一", "内容填充二", "内容填充三", "内容填充五"]) {
      assert.ok(got.includes(expected), `${expected} admitted by the gate`);
    }
    assert.ok(!got.includes("内容填充四"), "distance-4 member with default importance dropped");

    // The cap keeps the highest-activation members, not the nearest in
    // emission order: cap=1 admits only the distance-1 neighbor (0.75),
    // ahead of the high-importance distance-5 member (0.62).
    const capped = store.searchContext("起点", {
      limit: 1,
      sessionId: "s1",
      expandChains: true,
      chainExpansionMaxMembers: 1,
    });
    const appended = capped.results.filter((r) => r.memory.statement !== "起点");
    assert.equal(appended.length, 1);
    assert.equal(appended[0]!.memory.statement, "内容填充一");
  });
});

test("activation gate: a query-term match escapes position decay at any distance", () => {
  withStore((store) => {
    const mids: string[] = [];
    const filler = "随".repeat(60); // length-penalized so FTS ranks it below the hit
    for (const stmt of [
      "anchor beacon anchor beacon 锚点", // pos0 — both terms, term-dense hit
      "填充甲",
      "填充乙",
      "填充丙",
      "填充丁",
      `beacon ${filler}`, // pos5 — one query term, far from the hit
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
      topic: "相关性逃逸",
      ownerSessionId: "s1",
    });
    mids.forEach((m, i) => store.addMemoryToChain({ chainId: chain.id, memoryId: m, position: i }));

    const res = store.searchContext("anchor beacon", {
      limit: 1,
      sessionId: "s1",
      expandChains: true,
      chainExpansionMaxMembers: 10,
    });
    const got = res.results.map((r) => r.memory.statement);
    assert.ok(got.some((s) => s.startsWith("beacon ")), "term-matching distant member admitted");
    assert.ok(!got.includes("填充丁"), "distance-4 filler dropped");
  });
});

test("chain member reports successorId when its memory is superseded (live reference)", () => {
  withStore((store) => {
    const first = store.remember({
      nodeName: "项目",
      nodeKind: "topic",
      nodeSummary: "项目",
      statement: "预算阶段0",
      sessionId: "s1",
      sourceActor: "user",
    });
    const chain = store.createMemoryChain({
      chainType: "temporal",
      topic: "演进",
      ownerSessionId: "s1",
    });
    store.addMemoryToChain({ chainId: chain.id, memoryId: first.memory.id, position: 0 });
    // Fresh chain member: no supersession yet.
    assert.equal(store.getMemoryChain(chain.id)!.members[0]!.successorId, undefined);

    const successor = store.remember({
      nodeName: "项目",
      nodeKind: "topic",
      nodeSummary: "项目",
      statement: "预算阶段0v2（最新）",
      sessionId: "s1",
      sourceActor: "user",
      supersedesId: first.memory.id,
    });
    const member = store.getMemoryChain(chain.id)!.members[0]!;
    assert.equal(member.memoryId, first.memory.id); // snapshot kept
    assert.equal(member.successorId, successor.memory.id); // live reference
  });
});

test("recencyDecayHalfLifeDays dampens older memories (opt-in, default off)", () => {
  withStore((store) => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const byName = new Map<string, string>();
    for (const [name, days] of [
      ["最新", 0],
      ["百天", 100],
      ["千天", 1000],
    ] as const) {
      const r = store.remember({
        nodeName: "项目",
        nodeKind: "topic",
        nodeSummary: "项目",
        statement: `关于项目的${name}记忆`,
        eventTime: daysAgo(days),
        sessionId: "s1",
        sourceActor: "user",
      });
      byName.set(name, r.memory.id);
    }
    // Default (no decay): the option is off, retrieval is unchanged.
    const base = store.searchContext("项目 记忆", { limit: 3, sessionId: "s1" });
    assert.equal(base.results.length, 3);

    // With decay (half-life 100d): the 1000-day-old memory is dampened far more
    // than the 100-day-old one.
    const dec = store.searchContext("项目 记忆", {
      limit: 3,
      sessionId: "s1",
      recencyDecayHalfLifeDays: 100,
    });
    const score = new Map<string, number>();
    for (const r of dec.results) {
      for (const [name, id] of byName) if (r.memory.id === id) score.set(name, r.combinedScore);
    }
    assert.ok(score.has("千天") && score.has("百天"));
    assert.ok(score.get("千天")! < score.get("百天")!, "older memory dampened more");
  });
});

test("recency decay is skipped for historical (eventTimeTo) queries", () => {
  withStore((store) => {
    for (const name of ["甲", "乙"]) {
      store.remember({
        nodeName: "历史",
        nodeKind: "topic",
        nodeSummary: "历史",
        statement: `历史${name}记录`,
        eventTime: "2024-05-01T00:00:00Z",
        sessionId: "s1",
        sourceActor: "user",
      });
    }
    // Historical window with decay set: the decay path is skipped (no crash),
    // and the windowed records still surface.
    const c = store.searchContext("历史", {
      limit: 5,
      sessionId: "s1",
      recencyDecayHalfLifeDays: 30,
      eventTimeTo: "2024-12-31",
    });
    assert.ok(c.results.length >= 1);
  });
});

test("addMemoryChainEdge writes a directed DAG edge and auto-joins endpoints as members", () => {
  withStore((store) => {
    const chain = store.createMemoryChain({ chainType: "logical", topic: "事故因果", ownerSessionId: "s1" });
    const [a, b, c] = seedMemories(store, 3);
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: a, targetMemoryId: b });
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: b, targetMemoryId: c });
    const edges = store.getMemoryChainEdges(chain.id);
    assert.equal(edges.length, 2);
    assert.deepEqual(
      edges.map((e) => [e.sourceMemoryId, e.targetMemoryId]),
      [[a, b], [b, c]],
    );
    assert.equal(edges[0]!.edgeType, "order");
    // Endpoints were auto-joined as members (no separate addMemoryToChain).
    const fetched = store.getMemoryChain(chain.id)!;
    assert.deepEqual(fetched.members.map((m) => m.memoryId).sort(), [a, b, c].sort());
    // Remove an edge and confirm it is gone.
    store.removeMemoryChainEdge({ chainId: chain.id, sourceMemoryId: b, targetMemoryId: c });
    assert.equal(store.getMemoryChainEdges(chain.id).length, 1);
  });
});

test("addMemoryChainEdge rejects an edge that would close a directed cycle", () => {
  withStore((store) => {
    const chain = store.createMemoryChain({ chainType: "logical", topic: "反馈回路", ownerSessionId: "s1" });
    const [a, b, c] = seedMemories(store, 3);
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: a, targetMemoryId: b });
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: b, targetMemoryId: c });
    // c reaches a through b → a -> c would close a cycle.
    assert.throws(() => {
      store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: c, targetMemoryId: a });
    }, /would create a cycle/);
    assert.throws(() => {
      store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: b, targetMemoryId: a });
    }, /would create a cycle/);
    // Self-loop is rejected outright.
    assert.throws(() => {
      store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: a, targetMemoryId: a });
    }, /distinct memories/);
    // Unrelated edge is still fine.
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: a, targetMemoryId: c });
    assert.equal(store.getMemoryChainEdges(chain.id).length, 3);
  });
});

test("topologicalChainOrder returns a deterministic DAG order (branching chain)", () => {
  withStore((store) => {
    const chain = store.createMemoryChain({ chainType: "logical", topic: "分叉事故", ownerSessionId: "s1" });
    const [a, b, c, d] = seedMemories(store, 4);
    // a --> b, a --> c (branch), c --> d
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: a, targetMemoryId: b });
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: a, targetMemoryId: c });
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: c, targetMemoryId: d });
    const order = store.topologicalChainOrder(chain.id);
    assert.equal(order[0], a, "single source first");
    assert.equal(order.at(-1), d, "deepest target last");
    assert.ok(order.indexOf(b) < order.indexOf(d), "b precedes d");
    assert.ok(order.indexOf(c) < order.indexOf(d), "c precedes d");
    assert.equal(new Set(order).size, order.length, "no duplicates");
  });
});
