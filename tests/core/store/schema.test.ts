import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { migrate } from "../../../src/core/store/schema.ts";

function withDatabase(run: (db: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-schema-"));
  const db = new DatabaseSync(join(directory, "test.sqlite"));
  try {
    run(db);
  } finally {
    db.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

test("migrate creates the core graph tables", () => {
  withDatabase((db) => {
    migrate(db);
    const tables = tableNames(db);
    for (const expected of [
      "history_records",
      "memory_nodes",
      "memory_records",
      "memory_resolution_events",
      "claim_posteriors",
      "claim_outcome_events",
      "maintenance_runs",
      "node_relations",
      "memory_embeddings",
      "embedding_index_state",
      "retrieval_traces",
      "task_board_entries",
    ]) {
      assert.ok(tables.has(expected), `expected table ${expected}`);
    }
    const relationColumns = new Set(
      (db.prepare("PRAGMA table_info(node_relations)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const expected of ["strength", "direction", "fan_budget", "activation_rule"]) {
      assert.ok(relationColumns.has(expected), `expected node_relations.${expected}`);
    }
    const memoryColumns = new Set(
      (db.prepare("PRAGMA table_info(memory_records)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const expected of ["resolution", "opened_at", "related_memory_ids_json"]) {
      assert.ok(memoryColumns.has(expected), `expected memory_records.${expected}`);
    }
    const claimOutcomeColumns = new Set(
      (db.prepare("PRAGMA table_info(claim_outcome_events)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    assert.ok(claimOutcomeColumns.has("evidence_id"));
  });
});

test("migrate is idempotent across repeated opens", () => {
  // Migration runs on every store open, so re-running must be a no-op rather
  // than failing on already-created tables or already-added columns.
  withDatabase((db) => {
    migrate(db);
    const before = tableNames(db);
    migrate(db);
    migrate(db);
    assert.deepEqual([...tableNames(db)].sort(), [...before].sort());
  });
});

test("migrate preserves existing rows when re-run", () => {
  withDatabase((db) => {
    migrate(db);
    db.prepare(
      `INSERT INTO history_records (id, role, content, created_at)
       VALUES ('h1', 'user', 'hello', '2026-01-01T00:00:00.000Z')`,
    ).run();

    migrate(db);

    const row = db.prepare("SELECT content FROM history_records WHERE id = 'h1'").get() as
      { content: string } | undefined;
    assert.equal(row?.content, "hello");
  });
});

test("migrate adds session, disclosure, and attribution columns to legacy retrieval traces", () => {
  // Regression: session_id was added to CREATE TABLE with session isolation
  // (P0) but not to ensureRetrievalTraceColumns, so databases created before
  // that change never received the column and every traced search failed with
  // "table retrieval_traces has no column named session_id".
  withDatabase((db) => {
    db.exec("CREATE TABLE retrieval_traces (id TEXT PRIMARY KEY, created_at TEXT)");
    migrate(db);
    const columns = new Set(
      (db.prepare("PRAGMA table_info(retrieval_traces)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    assert.ok(columns.has("session_id"), "expected retrieval_traces.session_id after migrate");
    assert.ok(
      columns.has("disclosed_memory_ids_json"),
      "expected retrieval_traces.disclosed_memory_ids_json after migrate",
    );
    assert.ok(
      columns.has("attributed_memory_ids_json"),
      "expected retrieval_traces.attributed_memory_ids_json after migrate",
    );
  });
});
