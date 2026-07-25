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
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
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
      "node_relations",
      "memory_embeddings",
      "embedding_index_state",
      "retrieval_traces",
    ]) {
      assert.ok(tables.has(expected), `expected table ${expected}`);
    }
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
