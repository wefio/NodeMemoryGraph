import type { DatabaseSync } from "node:sqlite";

import { recallTriggersFromStoredMarkers } from "../recall-triggers.ts";
import { ftsIndexedText, surfaceIndexedText } from "./search-ranking.ts";

export const MEMORY_FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED, statement, node_name, evidence,
    content = '', contentless_delete = 1, tokenize = 'unicode61'
  );`;

const FORMATS = [
  ["fts_text_format", "unicode61-han-bigram-recall-trigger-surface-trigram-v3"],
  ["fts_storage_format", "contentless-registry-v1"],
] as const;

interface FtsDocument {
  memoryId: string;
  statement: string;
  nodeName: string;
  evidence: string;
  triggers: string;
}

/** Inspectors and read-only stores may encounter a database not yet migrated.
 * Resolve only schema metadata, never the stored full-text corpus. */
export function memoryFtsLink(db: DatabaseSync): { join: string; id: string } {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'").get();
  if (/contentless_delete\s*=\s*1/iu.test(String(schema?.sql))) {
    return {
      join: "JOIN memory_fts_registry r ON r.lexical_rowid = f.rowid",
      id: "r.memory_id",
    };
  }
  return { join: "", id: "f.memory_id" };
}

/** The registry's own rowid belongs to the surface index. The separate lexical
 * rowid preserves existing BM25 tie order and the lexical index's append order. */
export function deleteMemoryFts(db: DatabaseSync, memoryId: string): void {
  db.prepare(
    `DELETE FROM memory_fts WHERE rowid IN (
    SELECT lexical_rowid FROM memory_fts_registry WHERE memory_id = ?)`,
  ).run(memoryId);
  db.prepare(
    `DELETE FROM memory_surface_fts WHERE rowid IN (
    SELECT rowid FROM memory_fts_registry WHERE memory_id = ?)`,
  ).run(memoryId);
}

/** One document and both rowid mappings commit together, including when called
 * inside an existing store-owned transaction. Original evidence is not changed. */
export function indexMemoryFts(db: DatabaseSync, document: FtsDocument, rowid?: number): void {
  db.exec("SAVEPOINT nmg_fts_document");
  try {
    db.prepare("INSERT OR IGNORE INTO memory_fts_registry(memory_id) VALUES (?)").run(
      document.memoryId,
    );
    const registry = db
      .prepare("SELECT rowid FROM memory_fts_registry WHERE memory_id = ?")
      .get(document.memoryId)!;
    deleteMemoryFts(db, document.memoryId);
    const inserted = db
      .prepare("INSERT INTO memory_fts(rowid, statement, node_name, evidence) VALUES (?, ?, ?, ?)")
      .run(
        rowid ?? null,
        ftsIndexedText(document.statement),
        ftsIndexedText(document.nodeName),
        ftsIndexedText(`${document.evidence} ${document.triggers}`.trim()),
      );
    db.prepare("UPDATE memory_fts_registry SET lexical_rowid = ? WHERE memory_id = ?").run(
      inserted.lastInsertRowid,
      document.memoryId,
    );
    db.prepare("INSERT INTO memory_surface_fts(rowid, content) VALUES (?, ?)").run(
      registry.rowid!,
      surfaceIndexedText(
        `${document.statement} ${document.nodeName} ${document.evidence} ${document.triggers}`,
      ),
    );
    db.exec("RELEASE nmg_fts_document");
  } catch (error) {
    db.exec("ROLLBACK TO nmg_fts_document; RELEASE nmg_fts_document");
    throw error;
  }
}

function documents(db: DatabaseSync, missingOnly = false): FtsDocument[] {
  return db
    .prepare(
      `SELECT m.id, m.statement, m.markers_json, n.canonical_name, h.content
    FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
    JOIN history_records h ON h.id = m.evidence_id
    JOIN memory_fts_registry r ON r.memory_id = m.id
    WHERE m.storage_state = 'indexed' AND m.status <> 'deleted'
      ${missingOnly ? "AND r.lexical_rowid IS NULL" : ""}
    ORDER BY r.rowid`,
    )
    .all()
    .map((row) => ({
      memoryId: String(row.id),
      statement: String(row.statement),
      nodeName: String(row.canonical_name),
      evidence: String(row.content),
      triggers: recallTriggersFromStoredMarkers(row.markers_json).join(" "),
    }));
}

function ensureRegistryRowid(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(memory_fts_registry)").all();
  if (!columns.some((column) => column.name === "lexical_rowid")) {
    db.exec("ALTER TABLE memory_fts_registry ADD COLUMN lexical_rowid INTEGER");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_fts_registry_lexical ON memory_fts_registry(lexical_rowid)",
  );
}

/** Format changes rebuild once, atomically. Unchanged opens only repair missing
 * registry entries; the nullable-rowid index bounds their lookup. */
export function ensureMemoryFts(db: DatabaseSync): void {
  const current = new Map(
    db
      .prepare("SELECT key, value FROM store_metadata WHERE key IN (?, ?)")
      .all(...FORMATS.map(([key]) => key))
      .map((row) => [row.key, row.value]),
  );
  if (FORMATS.every(([key, value]) => current.get(key) === value)) {
    for (const document of documents(db, true)) indexMemoryFts(db, document);
    return;
  }

  db.exec("SAVEPOINT nmg_fts_migration");
  try {
    const link = memoryFtsLink(db);
    const oldRows = db
      .prepare(
        `SELECT ${link.id} AS memory_id, f.rowid
      FROM memory_fts f ${link.join} ORDER BY f.rowid`,
      )
      .all();
    const oldIds = new Map(oldRows.map((row) => [String(row.memory_id), Number(row.rowid)]));
    let nextRowid = oldRows.reduce((max, row) => Math.max(max, Number(row.rowid)), 0);
    ensureRegistryRowid(db);
    const source = documents(db);
    db.exec(`DROP TABLE memory_fts; ${MEMORY_FTS_SCHEMA}
      DELETE FROM memory_surface_fts;
      UPDATE memory_fts_registry SET lexical_rowid = NULL;`);
    for (const document of source) {
      indexMemoryFts(db, document, oldIds.get(document.memoryId) ?? ++nextRowid);
    }
    const mark = db.prepare(`INSERT INTO store_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    for (const [key, value] of FORMATS) mark.run(key, value);
    db.exec("RELEASE nmg_fts_migration");
  } catch (error) {
    db.exec("ROLLBACK TO nmg_fts_migration; RELEASE nmg_fts_migration");
    throw error;
  }
}
