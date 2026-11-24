import type { DatabaseSync } from "node:sqlite";
import { eventDateIndexText } from "../memory-normalization.ts";
import { recallTriggersFromMarkers } from "../recall-triggers.ts";
import { ftsIndexedText, surfaceIndexedText } from "../store/search-ranking.ts";
import type { MemoryRecord, TesseraRecord } from "../types.ts";

export { eventDateIndexText };

interface TextIndexSpec {
  readonly kind: "memory" | "tessera";
  readonly lexicalTable: string;
  readonly surfaceTable: string;
  readonly columns: readonly string[];
  readonly rank: string;
}

const TEXT_INDEX_SPECS: readonly TextIndexSpec[] = [
  {
    kind: "memory",
    lexicalTable: "nmg_memory_fts",
    surfaceTable: "nmg_memory_surface_fts",
    columns: ["text", "triggers", "dates"],
    rank: "bm25(1.0, 1.5, 1.0)",
  },
  {
    kind: "tessera",
    lexicalTable: "nmg_memory_tessera_fts",
    surfaceTable: "nmg_memory_tessera_surface_fts",
    columns: ["text", "path", "label"],
    rank: "bm25(1.0, 2.5, 1.8)",
  },
];

function specFor(kind: "memory" | "tessera"): TextIndexSpec {
  return kind === "tessera" ? TEXT_INDEX_SPECS[1]! : TEXT_INDEX_SPECS[0]!;
}

export function textIndex(kind: string): readonly [string, string, string] {
  const spec = kind === "tessera" ? TEXT_INDEX_SPECS[1]! : TEXT_INDEX_SPECS[0]!;
  return [spec.kind, spec.lexicalTable, spec.surfaceTable];
}

function isContentless(sql: unknown): boolean {
  return /contentless_delete\s*=\s*1/iu.test(String(sql));
}

function isCurrentLexical(sql: unknown, columns: readonly string[]): boolean {
  const schema = String(sql);
  return (
    isContentless(schema) &&
    /tokenize\s*=\s*['"]?porter\s+unicode61/iu.test(schema) &&
    columns.every((column) => new RegExp(`\\b${column}\\b`, "iu").test(schema))
  );
}

function isContentlessTrigram(sql: unknown): boolean {
  const schema = String(sql);
  return isContentless(schema) && /tokenize\s*=\s*['"]?trigram/iu.test(schema);
}

interface IndexedTextPayload {
  readonly fields: string[];
  readonly surfaceText: string;
}

function memoryIndexPayload(input: {
  statement: string;
  eventTime: string | null;
  status: string;
  storageState: string | undefined;
  hasForget: boolean;
  triggers: readonly string[];
}): IndexedTextPayload {
  if (input.status === "deleted" || input.storageState || input.hasForget) {
    return { fields: ["", "", ""], surfaceText: "" };
  }
  return {
    fields: [
      ftsIndexedText(input.statement),
      ftsIndexedText(input.triggers.join(" ")),
      ftsIndexedText(eventDateIndexText(input.eventTime)),
    ],
    surfaceText: surfaceIndexedText([input.statement, ...input.triggers].join(" ")),
  };
}

function tesseraIndexPayload(input: {
  snippet: string;
  path: string;
  label: string;
}): IndexedTextPayload {
  return {
    fields: [
      ftsIndexedText(input.snippet),
      ftsIndexedText(input.path),
      ftsIndexedText(input.label),
    ],
    surfaceText: surfaceIndexedText([input.path, input.label, input.snippet].join(" ")),
  };
}

export function hasContentlessMemoryTextIndex(db: DatabaseSync): boolean {
  return isContentless(
    db.prepare("SELECT sql FROM sqlite_schema WHERE name='nmg_memory_fts'").get()?.sql,
  );
}

/** Convert both lexical and surface trigram projections under the same writer lock. */
export function ensureSqliteTextIndexes(db: DatabaseSync): void {
  const schema = db.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE name IN (
      'nmg_memory_fts', 'nmg_memory_tessera_fts',
      'nmg_memory_surface_fts', 'nmg_memory_tessera_surface_fts',
      'nmg_memory_fts_rows'
    )`);
  const readSchema = () => new Map(schema.all().map(({ name, sql }) => [String(name), sql]));
  const current = (tables: ReadonlyMap<string, unknown>) =>
    tables.has("nmg_memory_fts_rows") &&
    TEXT_INDEX_SPECS.every(
      ({ lexicalTable, surfaceTable, columns }) =>
        isCurrentLexical(tables.get(lexicalTable), columns) &&
        isContentlessTrigram(tables.get(surfaceTable)),
    );
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

function readTriggerMapForBackfill(db: DatabaseSync): Map<string, string[]> {
  const triggersByKey = new Map<string, string[]>();
  const rows = db
    .prepare(
      `SELECT mk.namespace, mk.memory_id, mk.attr_json
       FROM nmg_memory_markers mk
       WHERE mk.kind = 'recall_trigger'
       ORDER BY mk.namespace, mk.memory_id, mk.ordinal`,
    )
    .all() as Array<{ namespace: string; memory_id: string; attr_json: string }>;
  for (const row of rows) {
    if (!row.attr_json) continue;
    const attrs = JSON.parse(String(row.attr_json)) as { term?: unknown; value?: unknown };
    const value = attrs.term ?? attrs.value;
    if (typeof value !== "string" || !value.trim()) continue;
    const key = `${row.namespace}\0${row.memory_id}`;
    const list = triggersByKey.get(key) ?? [];
    list.push(value.trim());
    triggersByKey.set(key, list);
  }
  return triggersByKey;
}

function readRelationalTextBackfillRows(
  db: DatabaseSync,
  kind: "memory" | "tessera",
): Array<{ rowid: number | bigint; payload: IndexedTextPayload }> {
  if (kind === "memory") {
    const triggersByKey = readTriggerMapForBackfill(db);
    return (
      db
        .prepare(
          `SELECT m.namespace, m.id, m.statement, m.event_time, m.status, m.storage_state,
             m.has_forget, r.fts_rowid
           FROM nmg_memories m
           JOIN nmg_memory_fts_rows r ON r.namespace = m.namespace AND r.key = 'memory:' || m.id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      rowid: row.fts_rowid as number | bigint,
      payload: memoryIndexPayload({
        statement: String(row.statement),
        eventTime: row.event_time ? String(row.event_time) : null,
        status: String(row.status),
        storageState: row.storage_state ? String(row.storage_state) : undefined,
        hasForget: Number(row.has_forget) === 1,
        triggers: triggersByKey.get(`${row.namespace}\0${row.id}`) ?? [],
      }),
    }));
  }
  return (
    db
      .prepare(
        `SELECT t.snippet, t.path, t.label, r.fts_rowid
         FROM nmg_tesserae t
         JOIN nmg_memory_fts_rows r ON r.namespace = t.namespace AND r.key = 'tessera:' || t.id`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({
    rowid: row.fts_rowid as number | bigint,
    payload: tesseraIndexPayload({
      snippet: String(row.snippet),
      path: String(row.path),
      label: String(row.label),
    }),
  }));
}

function populateLexicalFromRelational(db: DatabaseSync, spec: TextIndexSpec): void {
  const colSql = spec.columns.join(", ");
  const placeholders = spec.columns.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO ${spec.lexicalTable}(rowid, ${colSql}) VALUES (?, ${placeholders})`,
  );
  for (const row of readRelationalTextBackfillRows(db, spec.kind)) {
    insert.run(row.rowid, ...row.payload.fields);
  }
}

function populateSurfaceFromRelational(db: DatabaseSync, spec: TextIndexSpec): void {
  const insert = db.prepare(`INSERT INTO ${spec.surfaceTable}(rowid, text) VALUES (?, ?)`);
  for (const row of readRelationalTextBackfillRows(db, spec.kind)) {
    insert.run(row.rowid, row.payload.surfaceText);
  }
}

function createEmptyLexicalTable(db: DatabaseSync, spec: TextIndexSpec): void {
  const colSql = spec.columns.join(", ");
  db.exec(`DROP TABLE IF EXISTS ${spec.lexicalTable};
    CREATE VIRTUAL TABLE ${spec.lexicalTable}
      USING fts5(${colSql}, content='', contentless_delete=1, tokenize='porter unicode61');
    INSERT INTO ${spec.lexicalTable}(${spec.lexicalTable}, rank) VALUES('rank', '${spec.rank}');`);
}

function upgradeNonContentlessLexicalTable(db: DatabaseSync, spec: TextIndexSpec): void {
  const target = `${spec.lexicalTable}_next`;
  const colSql = spec.columns.join(", ");
  db.exec(`CREATE VIRTUAL TABLE ${target}
      USING fts5(${colSql}, content='', contentless_delete=1, tokenize='porter unicode61');
    DELETE FROM nmg_memory_fts_rows WHERE key GLOB '${spec.kind}:*';
    INSERT INTO nmg_memory_fts_rows
      SELECT namespace, key, rowid FROM ${spec.lexicalTable};
    INSERT INTO ${target}(rowid, text) SELECT rowid, text FROM ${spec.lexicalTable};
    DROP TABLE ${spec.lexicalTable};
    ALTER TABLE ${target} RENAME TO ${spec.lexicalTable};
    INSERT INTO ${spec.lexicalTable}(${spec.lexicalTable}, rank) VALUES('rank', '${spec.rank}');`);
}

function migrateTextIndexes(db: DatabaseSync, tables: ReadonlyMap<string, unknown>): void {
  if (
    !tables.has("nmg_memory_fts_rows") &&
    TEXT_INDEX_SPECS.some(({ lexicalTable }) => isContentless(tables.get(lexicalTable)))
  ) {
    throw new Error("Memory text index row mapping is missing");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS nmg_memory_fts_rows (
      namespace TEXT NOT NULL, key TEXT NOT NULL, fts_rowid INTEGER NOT NULL,
      PRIMARY KEY(namespace, key)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS nmg_memory_fts_rows_by_rowid
      ON nmg_memory_fts_rows(namespace, fts_rowid);`);
  const reindexedRowids = new Set<string>();
  for (const spec of TEXT_INDEX_SPECS) {
    const oldSql = tables.get(spec.lexicalTable);
    if (isCurrentLexical(oldSql, spec.columns)) continue;
    const hasOld = tables.has(spec.lexicalTable);
    if (hasOld && !isContentless(oldSql)) {
      reindexedRowids.add(spec.kind);
      upgradeNonContentlessLexicalTable(db, spec);
      continue;
    }
    createEmptyLexicalTable(db, spec);
    if (hasOld) populateLexicalFromRelational(db, spec);
  }
  for (const spec of TEXT_INDEX_SPECS) {
    if (isContentlessTrigram(tables.get(spec.surfaceTable)) && !reindexedRowids.has(spec.kind))
      continue;
    db.exec(`DROP TABLE IF EXISTS ${spec.surfaceTable};
      CREATE VIRTUAL TABLE ${spec.surfaceTable} USING fts5(text, content='', contentless_delete=1, tokenize='trigram');`);
    populateSurfaceFromRelational(db, spec);
  }
}

function upsertTextIndexRow(
  db: DatabaseSync,
  namespace: string,
  kind: "memory" | "tessera",
  key: string,
  payload: IndexedTextPayload,
): void {
  const { lexicalTable, surfaceTable, columns } = specFor(kind);
  const previous = db
    .prepare("SELECT fts_rowid FROM nmg_memory_fts_rows WHERE namespace=? AND key=?")
    .get(namespace, key);
  if (previous) {
    const assignments = columns.map((column) => `${column}=?`).join(", ");
    const updated = db
      .prepare(`UPDATE ${lexicalTable} SET ${assignments} WHERE rowid=?`)
      .run(...payload.fields, previous.fts_rowid);
    if (updated.changes !== 1) throw new Error("Memory text index row is missing");
    const updatedSurface = db
      .prepare(`UPDATE ${surfaceTable} SET text=? WHERE rowid=?`)
      .run(payload.surfaceText, previous.fts_rowid);
    if (updatedSurface.changes !== 1) throw new Error("Memory surface index row is missing");
    return;
  }
  const colSql = columns.join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO ${lexicalTable}(${colSql}) VALUES (${placeholders})`)
    .run(...payload.fields);
  db.prepare(`INSERT INTO ${surfaceTable}(rowid, text) VALUES (?, ?)`).run(
    lastInsertRowid,
    payload.surfaceText,
  );
  db.prepare("INSERT INTO nmg_memory_fts_rows VALUES (?, ?, ?)").run(
    namespace,
    key,
    lastInsertRowid,
  );
}

/** Update or clear derived lexical and trigram FTS5 rows for a MemoryRecord. */
export function writeMemoryTextIndex(
  db: DatabaseSync,
  namespace: string,
  memory: MemoryRecord,
): void {
  const triggers = recallTriggersFromMarkers(memory.markers);
  const hasForget = memory.markers.some((marker) => marker.kind === "forget");
  const payload = memoryIndexPayload({
    statement: memory.statement,
    eventTime: memory.eventTime,
    status: memory.status,
    storageState: memory.storageState,
    hasForget,
    triggers,
  });
  upsertTextIndexRow(db, namespace, "memory", `memory:${memory.id}`, payload);
}

/** Update derived lexical and trigram FTS5 rows for a TesseraRecord. */
export function writeTesseraTextIndex(
  db: DatabaseSync,
  namespace: string,
  tessera: TesseraRecord,
): void {
  const payload = tesseraIndexPayload(tessera);
  upsertTextIndexRow(db, namespace, "tessera", `tessera:${tessera.id}`, payload);
}

/** Drop and deterministically rebuild all FTS5 text indexes from authoritative relational tables. */
export function rebuildSqliteTextIndexes(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM nmg_memory_fts_rows;
      DROP TABLE IF EXISTS nmg_memory_fts;
      DROP TABLE IF EXISTS nmg_memory_surface_fts;
      DROP TABLE IF EXISTS nmg_memory_tessera_fts;
      DROP TABLE IF EXISTS nmg_memory_tessera_surface_fts;
    `);
    for (const spec of TEXT_INDEX_SPECS) {
      createEmptyLexicalTable(db, spec);
      db.exec(
        `CREATE VIRTUAL TABLE ${spec.surfaceTable} USING fts5(text, content='', contentless_delete=1, tokenize='trigram');`,
      );
    }
    const triggersByKey = readTriggerMapForBackfill(db);
    const memories = db
      .prepare(
        "SELECT namespace, id, statement, event_time, status, storage_state, has_forget FROM nmg_memories ORDER BY namespace, rowid",
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of memories) {
      const ns = String(row.namespace);
      const id = String(row.id);
      const payload = memoryIndexPayload({
        statement: String(row.statement),
        eventTime: row.event_time ? String(row.event_time) : null,
        status: String(row.status),
        storageState: row.storage_state ? String(row.storage_state) : undefined,
        hasForget: Number(row.has_forget) === 1,
        triggers: triggersByKey.get(`${ns}\0${id}`) ?? [],
      });
      upsertTextIndexRow(db, ns, "memory", `memory:${id}`, payload);
    }
    const tesserae = db
      .prepare(
        "SELECT namespace, id, path, snippet, label FROM nmg_tesserae ORDER BY namespace, rowid",
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of tesserae) {
      const payload = tesseraIndexPayload({
        path: String(row.path),
        snippet: String(row.snippet),
        label: String(row.label),
      });
      upsertTextIndexRow(db, String(row.namespace), "tessera", `tessera:${row.id}`, payload);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
