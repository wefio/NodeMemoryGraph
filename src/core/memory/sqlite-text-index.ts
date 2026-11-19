import type { DatabaseSync } from "node:sqlite";
import { ftsIndexedText } from "../store/search-ranking.ts";
import { lexicalMemoryText, type EntityRow } from "./entity-rows.ts";

const TEXT_INDEXES = [
  ["memory", "nmg_memory_fts"],
  ["tessera", "nmg_memory_tessera_fts"],
] as const;

export function textIndex(kind: string): (typeof TEXT_INDEXES)[number] {
  return kind === "tessera" ? TEXT_INDEXES[1] : TEXT_INDEXES[0];
}

function isContentless(sql: unknown): boolean {
  return /contentless_delete\s*=\s*1/iu.test(String(sql));
}

export function hasContentlessMemoryTextIndex(db: DatabaseSync): boolean {
  return isContentless(
    db.prepare("SELECT sql FROM sqlite_schema WHERE name='nmg_memory_fts'").get()?.sql,
  );
}

/** Convert both projections under the same writer lock, including all namespaces. */
export function ensureSqliteTextIndexes(db: DatabaseSync): void {
  const schema = db.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE name IN ('nmg_memory_fts', 'nmg_memory_tessera_fts', 'nmg_memory_fts_rows')`);
  const readSchema = () => new Map(schema.all().map(({ name, sql }) => [String(name), sql]));
  const current = (tables: ReadonlyMap<string, unknown>) =>
    tables.has("nmg_memory_fts_rows") &&
    TEXT_INDEXES.every(([, table]) => isContentless(tables.get(table)));
  if (current(readSchema())) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const tables = readSchema();
    if (!current(tables)) migrateTextIndexes(db, tables);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateTextIndexes(db: DatabaseSync, tables: ReadonlyMap<string, unknown>): void {
  if (
    !tables.has("nmg_memory_fts_rows") &&
    TEXT_INDEXES.some(([, table]) => isContentless(tables.get(table)))
  ) {
    throw new Error("Memory text index row mapping is missing");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS nmg_memory_fts_rows (
      namespace TEXT NOT NULL, key TEXT NOT NULL, fts_rowid INTEGER NOT NULL,
      PRIMARY KEY(namespace, key)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS nmg_memory_fts_rows_by_rowid
      ON nmg_memory_fts_rows(namespace, fts_rowid);`);
  for (const [kind, table] of TEXT_INDEXES) {
    if (isContentless(tables.get(table))) continue;
    const oldTable = tables.has(table);
    const target = oldTable ? `${table}_next` : table;
    db.exec(`CREATE VIRTUAL TABLE ${target} USING fts5(text, content='', contentless_delete=1)`);
    if (!oldTable) continue;
    // Copy the exact indexed text and rowids so tokenization and tie order survive the upgrade.
    db.exec(`DELETE FROM nmg_memory_fts_rows WHERE key GLOB '${kind}:*';
      INSERT INTO nmg_memory_fts_rows
        SELECT namespace, key, rowid FROM ${table};
      INSERT INTO ${target}(rowid, text) SELECT rowid, text FROM ${table};
      DROP TABLE ${table};
      ALTER TABLE ${target} RENAME TO ${table};`);
  }
}

export function writeSqliteTextIndex(db: DatabaseSync, namespace: string, row: EntityRow): void {
  const [, table] = textIndex(row.kind);
  const text = ftsIndexedText(
    row.kind === "memory" ? lexicalMemoryText(JSON.parse(row.payload)) : row.text,
  );
  const previous = db
    .prepare("SELECT fts_rowid FROM nmg_memory_fts_rows WHERE namespace=? AND key=?")
    .get(namespace, row.key);
  if (previous) {
    const updated = db
      .prepare(`UPDATE ${table} SET text=? WHERE rowid=?`)
      .run(text, previous.fts_rowid);
    if (updated.changes !== 1) throw new Error("Memory text index row is missing");
    return;
  }
  const { lastInsertRowid } = db.prepare(`INSERT INTO ${table}(text) VALUES (?)`).run(text);
  db.prepare("INSERT INTO nmg_memory_fts_rows VALUES (?, ?, ?)").run(
    namespace,
    row.key,
    lastInsertRowid,
  );
}
