import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NmgStore } from "../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gcyc-"));
  const store = new NmgStore(join(dir, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
  }
}

test("detectGraphCycles finds a directed relation cycle", () => {
  withStore((store) => {
    const m1 = store.remember({ nodeName: "N1", nodeKind: "topic", nodeSummary: "n1", statement: "节点1因果", sessionId: "s1", sourceActor: "user" });
    const m2 = store.remember({ nodeName: "N2", nodeKind: "topic", nodeSummary: "n2", statement: "节点2因果", sessionId: "s1", sourceActor: "user" });
    const m3 = store.remember({ nodeName: "N3", nodeKind: "topic", nodeSummary: "n3", statement: "节点3因果", sessionId: "s1", sourceActor: "user" });
    store.linkNodes({ sourceNodeId: m1.node.id, targetNodeId: m2.node.id, type: "causes" });
    store.linkNodes({ sourceNodeId: m2.node.id, targetNodeId: m3.node.id, type: "causes" });
    store.linkNodes({ sourceNodeId: m3.node.id, targetNodeId: m1.node.id, type: "causes" });

    const r = store.detectGraphCycles();
    assert.equal(r.supersedeCycles.length, 0);
    assert.ok(
      r.relationCycles.some(
        (cycle) =>
          cycle.includes(m1.node.id) && cycle.includes(m2.node.id) && cycle.includes(m3.node.id),
      ),
      "relation cycle N1->N2->N3->N1 detected",
    );
  });
});

test("detectGraphCycles finds a supersede cycle (data anomaly)", () => {
  withStore((store) => {
    const a = store.remember({ nodeName: "X", nodeKind: "topic", nodeSummary: "x", statement: "A版", sessionId: "s1", sourceActor: "user" });
    const b = store.remember({ nodeName: "X", nodeKind: "topic", nodeSummary: "x", statement: "B版", sessionId: "s1", sourceActor: "user" });
    // Normal supersede is a DAG — no cycle.
    assert.equal(store.detectGraphCycles().supersedeCycles.length, 0);
    // Inject a mutual-supersede anomaly directly (write path would reject it).
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...p: unknown[]) => void } } }).db;
    db.prepare("UPDATE memory_records SET supersedes_id = ? WHERE id = ?").run(b.memory.id, a.memory.id);
    db.prepare("UPDATE memory_records SET supersedes_id = ? WHERE id = ?").run(a.memory.id, b.memory.id);
    const r = store.detectGraphCycles();
    assert.ok(
      r.supersedeCycles.some((cycle) => cycle.includes(a.memory.id) && cycle.includes(b.memory.id)),
      "mutual supersede cycle detected",
    );
  });
});

test("detectGraphCycles is empty for an acyclic chain", () => {
  withStore((store) => {
    const p1 = store.remember({ nodeName: "P1", nodeKind: "topic", nodeSummary: "p1", statement: "正常链1", sessionId: "s1", sourceActor: "user" });
    const p2 = store.remember({ nodeName: "P2", nodeKind: "topic", nodeSummary: "p2", statement: "正常链2", sessionId: "s1", sourceActor: "user" });
    const p3 = store.remember({ nodeName: "P3", nodeKind: "topic", nodeSummary: "p3", statement: "正常链3", sessionId: "s1", sourceActor: "user" });
    store.linkNodes({ sourceNodeId: p1.node.id, targetNodeId: p2.node.id, type: "causes" });
    store.linkNodes({ sourceNodeId: p2.node.id, targetNodeId: p3.node.id, type: "causes" });
    const r = store.detectGraphCycles();
    assert.deepEqual(r.relationCycles, []);
    assert.deepEqual(r.supersedeCycles, []);
  });
});

test("symmetric relations (contradicts) never count as cycles", () => {
  withStore((store) => {
    const m1 = store.remember({ nodeName: "N1", nodeKind: "topic", nodeSummary: "n1", statement: "观点A", sessionId: "s1", sourceActor: "user" });
    const m2 = store.remember({ nodeName: "N2", nodeKind: "topic", nodeSummary: "n2", statement: "观点B", sessionId: "s1", sourceActor: "user" });
    store.linkNodes({ sourceNodeId: m1.node.id, targetNodeId: m2.node.id, type: "contradicts" });
    store.linkNodes({ sourceNodeId: m2.node.id, targetNodeId: m1.node.id, type: "contradicts" });
    // A mutual contradiction is normal symmetric semantics, not an anomaly.
    assert.deepEqual(store.detectGraphCycles().relationCycles, []);
    // But the same pair as a directed semantic relation is a real cycle.
    store.linkNodes({ sourceNodeId: m1.node.id, targetNodeId: m2.node.id, type: "causes" });
    store.linkNodes({ sourceNodeId: m2.node.id, targetNodeId: m1.node.id, type: "causes" });
    assert.equal(store.detectGraphCycles().relationCycles.length, 1);
  });
});

test("applySupersession rejects writes that would create a supersede cycle", () => {
  withStore((store) => {
    const a = store.remember({ nodeName: "X", nodeKind: "topic", nodeSummary: "x", statement: "预算5000版1", sessionId: "s1", sourceActor: "user" });
    const b = store.remember({ nodeName: "X", nodeKind: "topic", nodeSummary: "x", statement: "预算5000版2", sessionId: "s1", sourceActor: "user" });
    store.applySupersession({ newMemoryId: a.memory.id, supersededMemoryId: b.memory.id });
    assert.throws(
      () =>
        store.applySupersession({ newMemoryId: b.memory.id, supersededMemoryId: a.memory.id }),
      /supersede cycle/,
      "mutual supersession is rejected at write time",
    );
    // The first supersession is intact and acyclic.
    assert.deepEqual(store.detectGraphCycles().supersedeCycles, []);
  });
});

test("breakSupersedeCycle clears intra-cycle supersedes_id edges", () => {
  withStore((store) => {
    const c = store.remember({ nodeName: "X", nodeKind: "topic", nodeSummary: "x", statement: "预算5000版3", sessionId: "s1", sourceActor: "user" });
    const d = store.remember({ nodeName: "X", nodeKind: "topic", nodeSummary: "x", statement: "预算5000版4", sessionId: "s1", sourceActor: "user" });
    // Inject a mutual-supersede anomaly directly (write path would reject it).
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...p: unknown[]) => void } } }).db;
    db.prepare("UPDATE memory_records SET supersedes_id = ? WHERE id = ?").run(d.memory.id, c.memory.id);
    db.prepare("UPDATE memory_records SET supersedes_id = ? WHERE id = ?").run(c.memory.id, d.memory.id);
    const r = store.detectGraphCycles();
    const cycle = r.supersedeCycles.find((x) => x.includes(c.memory.id) && x.includes(d.memory.id));
    assert.ok(cycle, "cycle detected before break");
    const broke = store.breakSupersedeCycle(cycle!);
    assert.ok(broke.cleared.includes(c.memory.id) || broke.cleared.includes(d.memory.id));
    assert.deepEqual(store.detectGraphCycles().supersedeCycles, []);
  });
});
