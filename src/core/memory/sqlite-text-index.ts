import type { DatabaseSync } from "node:sqlite";
import { recallTriggersFromMarkers } from "../recall-triggers.ts";
import { ftsIndexedText, surfaceIndexedText } from "../store/search-ranking.ts";
import { lexicalMemoryText, type EntityRow } from "./entity-rows.ts";

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
    columns: ["text", "triggers"],
    rank: "bm25(1.0, 1.5)",
  },
  {
    kind: "tessera",
    lexicalTable: "nmg_memory_tessera_fts",
    surfaceTable: "nmg_memory_tessera_surface_fts",
    columns: ["text", "path", "label"],
    rank: "bm25(1.0, 2.5, 1.8)",
  },
];

function specFor(kind: string): TextIndexSpec {
  return kind === "tessera" ? TEXT_INDEX_SPECS[1]! : TEXT_INDEX_SPECS[0]!;
}

export function textIndex(kind: string): readonly [string, string, string] {
  const spec = specFor(kind);
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

function rawIndexText(kind: string, row: Pick<EntityRow, "payload" | "text">): string {
  return kind === "memory" ? lexicalMemoryText(JSON.parse(row.payload)) : row.text;
}

function lexicalIndexFields(
  kind: "memory" | "tessera",
  row: Pick<EntityRow, "payload" | "text">,
): string[] {
  if (kind === "memory") {
    const memory = JSON.parse(row.payload);
    if (memory.storageState) return ["", ""];
    return [
      ftsIndexedText(String(memory.statement ?? "")),
      ftsIndexedText(recallTriggersFromMarkers(memory.markers).join(" ")),
    ];
  }
  const tessera = JSON.parse(row.payload);
  return [
    ftsIndexedText(String(tessera.snippet ?? "")),
    ftsIndexedText(String(tessera.path ?? "")),
    ftsIndexedText(String(tessera.label ?? "")),
  ];
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
  const hasEntities = Boolean(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='nmg_memory_entities'").get(),
  );
  const reindexedRowids = new Set<string>();
  for (const { kind, lexicalTable, columns, rank } of TEXT_INDEX_SPECS) {
    const oldSql = tables.get(lexicalTable);
    if (isCurrentLexical(oldSql, columns)) continue;
    const hasOld = tables.has(lexicalTable);
    const colSql = columns.join(", ");
    if (hasOld && !isContentless(oldSql)) {
      reindexedRowids.add(kind);
      const target = `${lexicalTable}_next`;
      db.exec(`CREATE VIRTUAL TABLE ${target}
          USING fts5(${colSql}, content='', contentless_delete=1, tokenize='porter unicode61');
        DELETE FROM nmg_memory_fts_rows WHERE key GLOB '${kind}:*';
        INSERT INTO nmg_memory_fts_rows
          SELECT namespace, key, rowid FROM ${lexicalTable};
        INSERT INTO ${target}(rowid, text) SELECT rowid, text FROM ${lexicalTable};
        DROP TABLE ${lexicalTable};
        ALTER TABLE ${target} RENAME TO ${lexicalTable};
        INSERT INTO ${lexicalTable}(${lexicalTable}, rank) VALUES('rank', '${rank}');`);
      continue;
    }
    db.exec(`DROP TABLE IF EXISTS ${lexicalTable};
      CREATE VIRTUAL TABLE ${lexicalTable}
        USING fts5(${colSql}, content='', contentless_delete=1, tokenize='porter unicode61');
      INSERT INTO ${lexicalTable}(${lexicalTable}, rank) VALUES('rank', '${rank}');`);
    if (!hasOld || !hasEntities) continue;
    const placeholders = columns.map(() => "?").join(", ");
    const insertLexical = db.prepare(
      `INSERT INTO ${lexicalTable}(rowid, ${colSql}) VALUES (?, ${placeholders})`,
    );
    for (const row of db
      .prepare(
        `SELECT e.payload, e.text, r.fts_rowid
        FROM nmg_memory_entities e
        JOIN nmg_memory_fts_rows r ON r.namespace = e.namespace AND r.key = e.key
        WHERE e.kind = ?`,
      )
      .all(kind)) {
      insertLexical.run(
        row.fts_rowid,
        ...lexicalIndexFields(kind, { payload: String(row.payload), text: String(row.text) }),
      );
    }
  }
  for (const { kind, surfaceTable } of TEXT_INDEX_SPECS) {
    if (isContentlessTrigram(tables.get(surfaceTable)) && !reindexedRowids.has(kind)) continue;
    db.exec(`DROP TABLE IF EXISTS ${surfaceTable};
      CREATE VIRTUAL TABLE ${surfaceTable} USING fts5(text, content='', contentless_delete=1, tokenize='trigram');`);
    if (!hasEntities) continue;
    const insertSurface = db.prepare(`INSERT INTO ${surfaceTable}(rowid, text) VALUES (?, ?)`);
    for (const row of db
      .prepare(
        `SELECT e.payload, e.text, r.fts_rowid
        FROM nmg_memory_entities e
        JOIN nmg_memory_fts_rows r ON r.namespace = e.namespace AND r.key = e.key
        WHERE e.kind = ?`,
      )
      .all(kind)) {
      insertSurface.run(
        row.fts_rowid,
        surfaceIndexedText(
          rawIndexText(kind, { payload: String(row.payload), text: String(row.text) }),
        ),
      );
    }
  }
}

export function writeSqliteTextIndex(db: DatabaseSync, namespace: string, row: EntityRow): void {
  const { kind, lexicalTable, surfaceTable, columns } = specFor(row.kind);
  const fields = lexicalIndexFields(kind, row);
  const surfaceText = surfaceIndexedText(rawIndexText(kind, row));
  const previous = db
    .prepare("SELECT fts_rowid FROM nmg_memory_fts_rows WHERE namespace=? AND key=?")
    .get(namespace, row.key);
  if (previous) {
    const assignments = columns.map((column) => `${column}=?`).join(", ");
    const updated = db
      .prepare(`UPDATE ${lexicalTable} SET ${assignments} WHERE rowid=?`)
      .run(...fields, previous.fts_rowid);
    if (updated.changes !== 1) throw new Error("Memory text index row is missing");
    const updatedSurface = db
      .prepare(`UPDATE ${surfaceTable} SET text=? WHERE rowid=?`)
      .run(surfaceText, previous.fts_rowid);
    if (updatedSurface.changes !== 1) throw new Error("Memory surface index row is missing");
    return;
  }
  const colSql = columns.join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO ${lexicalTable}(${colSql}) VALUES (${placeholders})`)
    .run(...fields);
  db.prepare(`INSERT INTO ${surfaceTable}(rowid, text) VALUES (?, ?)`).run(
    lastInsertRowid,
    surfaceText,
  );
  db.prepare("INSERT INTO nmg_memory_fts_rows VALUES (?, ?, ?)").run(
    namespace,
    row.key,
    lastInsertRowid,
  );
}
