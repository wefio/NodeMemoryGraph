import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readGraphData } from "../../src/cli/graph-data.ts";
import { openInspectDb } from "../../src/cli/inspect-data.ts";
import { NmgService } from "../../src/cli/service.ts";

test("graph projection reads nodes, memories, and all three edge layers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-graph-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    await service.invoke("remember", {
      statement: "The Atlas project must remain offline-first.",
      nodeName: "Atlas architecture",
      memoryType: "constraint",
      evidence: "The Atlas project must remain offline-first.",
      scope: { project: "atlas" },
    });
    const sync = await service.invoke("remember", {
      statement: "Atlas sync runs nightly.",
      nodeName: "Atlas sync",
      memoryType: "fact",
      evidence: "Atlas sync runs nightly.",
      scope: { project: "atlas" },
    });
    await service.invoke("remember", {
      statement: "Atlas sync runs hourly.",
      nodeName: "Atlas deploy",
      memoryType: "fact",
      supersedesId: sync.memory.id,
      scope: { project: "atlas" },
    });

    // Relations are normally written by consolidation; seed one directly so
    // the projection test does not depend on that pipeline.
    const writable = new DatabaseSync(databasePath);
    const nodeIds = writable
      .prepare("SELECT id, canonical_name FROM memory_nodes")
      .all()
      .map((row) => ({ id: String(row.id), name: String(row.canonical_name) }));
    const nodeId = (name: string) => nodeIds.find((node) => node.name === name)!.id;
    writable
      .prepare(
        `INSERT INTO node_relations
           (id, source_node_id, target_node_id, relation_type, strength, direction,
            consolidated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "rel-1",
        nodeId("Atlas sync"),
        nodeId("Atlas architecture"),
        "depends_on",
        0.8,
        "source->target",
        new Date().toISOString(),
        new Date().toISOString(),
      );
    const pairSignal = writable.prepare(
      `INSERT INTO node_pair_signals
         (left_node_id, right_node_id, co_retrieval_count, useful_count, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Already consolidated — must be excluded from the candidate layer.
    pairSignal.run(nodeId("Atlas sync"), nodeId("Atlas architecture"), 5, 5, new Date().toISOString());
    // Genuine candidate awaiting consolidation.
    pairSignal.run(nodeId("Atlas deploy"), nodeId("Atlas architecture"), 3, 1, new Date().toISOString());
    // Below the noise floor — must not surface.
    pairSignal.run(nodeId("Atlas deploy"), nodeId("Atlas sync"), 1, 0, new Date().toISOString());
    writable.close();

    // Read-only projection must be safe while the writer is still open (WAL).
    const db = openInspectDb(databasePath);
    try {
      const graph = readGraphData(db);
      assert.equal(graph.nodes.length, 3);
      const byName = new Map(graph.nodes.map((node) => [node.name, node]));
      assert.equal(byName.get("Atlas architecture")!.memoryCount, 1);
      assert.equal(byName.get("Atlas architecture")!.kind, "concept");
      // The sync memory was superseded by the deploy one, so it drops out of
      // the active/disputed projection entirely.
      assert.equal(byName.get("Atlas sync")!.memoryCount, 0);
      assert.deepEqual(byName.get("Atlas sync")!.statements, []);

      const relations = graph.edges.filter((edge) => edge.layer === "relation");
      assert.equal(relations.length, 1);
      assert.equal(relations[0]!.type, "depends_on");
      assert.equal(relations[0]!.source, nodeId("Atlas sync"));
      assert.equal(relations[0]!.target, nodeId("Atlas architecture"));
      assert.equal(relations[0]!.strength, 0.8);

      const candidates = graph.edges.filter((edge) => edge.layer === "candidate");
      assert.equal(candidates.length, 1, "consolidated pairs and sub-threshold pairs are excluded");
      assert.equal(candidates[0]!.type, "co_retrieved");
      assert.equal(candidates[0]!.observations, 3);
      assert.ok(Math.abs(candidates[0]!.strength - 1 / 3) < 1e-9);
      const candidatePair = [candidates[0]!.source, candidates[0]!.target].sort();
      assert.deepEqual(candidatePair, [nodeId("Atlas architecture"), nodeId("Atlas deploy")].sort());

      const supersedes = graph.edges.filter((edge) => edge.layer === "supersedes");
      assert.equal(supersedes.length, 1);
      assert.equal(supersedes[0]!.source, nodeId("Atlas deploy"));
      assert.equal(supersedes[0]!.target, nodeId("Atlas sync"));
      assert.equal(supersedes[0]!.direction, "source->target");
      assert.equal(supersedes[0]!.observations, 1);

      // Every node has at least one edge here; an unconnected node would stay 0.
      assert.ok([...byName.values()].every((node) => node.degree >= 1));
      assert.ok(graph.generatedAt);
    } finally {
      db.close();
    }
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("graph projection on an empty database yields an empty graph", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-graph-empty-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    // The service opens SQLite lazily; a no-op search forces file creation
    // and migration so the read-only handle has something to open.
    await service.invoke("search", { query: "nothing stored yet" });
    const db = openInspectDb(databasePath);
    try {
      const graph = readGraphData(db);
      assert.deepEqual(graph.nodes, []);
      assert.deepEqual(graph.edges, []);
    } finally {
      db.close();
    }
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
