import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryOperationConflict } from "./backend.ts";
import type {
  MemoryBackend,
  MemoryCommitOutcome,
  MemoryCommitReceipt,
  MemoryCommitRequest,
  MemoryEntity,
  MemoryEntityQuery,
  MemoryReadView,
} from "./backend.ts";
import {
  ENTITY_COLUMNS,
  commitRows,
  lexicalMemoryText,
  queryBounds,
  sqliteQueryWhere,
  sqlLiteral,
  validateCommit,
} from "./entity-rows.ts";
import { graphImportRequest } from "./graph-import.ts";
import { readLegacyClaimRows, readLegacyMemoryRows } from "../store/legacy-memory-snapshot.ts";
import { requestHash } from "./model.ts";
import { ensureLocalDaemonSchema, migrate } from "../store/schema.ts";
import { ftsExpression, ftsIndexedText } from "../store/search-ranking.ts";
import { SqliteMemoryVectors } from "./sqlite-vectors.ts";
import {
  ensureSqliteMemoryChains,
  importLegacySqliteChains,
  readSqliteChainProjection,
} from "./sqlite-chains.ts";
import {
  ensureSqliteMemoryAssociations,
  hasLegacyMemoryTables,
  importLegacySqliteAssociations,
  retireLegacyMemoryTables,
} from "./sqlite-legacy-retirement.ts";

const LOCAL_MEMORY_TABLE = "nmg_local_memory";
export const LOCAL_MEMORY_NAMESPACE = "local-memory-v1";
function localNamespace(db: DatabaseSync): string | undefined {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
    .get(LOCAL_MEMORY_TABLE);
  if (!exists) return undefined;
  return String(
    db.prepare(`SELECT namespace FROM ${LOCAL_MEMORY_TABLE} WHERE id=1`).get()!.namespace,
  );
}

export function activatedLocalMemory(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return localNamespace(db);
  } finally {
    db.close();
  }
}

/** Portable memory format. The legacy Store is imported explicitly, never opened as this schema. */
export class SqliteMemoryBackend implements MemoryBackend {
  readonly kind = "sqlite" as const;
  private readonly writer: DatabaseSync;
  private readonly readers = new Map<MemoryReadView, DatabaseSync>();
  private closed = false;
  private readonly path: string;
  readonly namespace: string;
  readonly vectorIndex: SqliteMemoryVectors;

  constructor(path: string, namespace: string) {
    this.path = path;
    this.namespace = namespace;
    if (!namespace.trim()) throw new Error("Memory namespace is required");
    if (path === ":memory:")
      throw new Error("Snapshot reads require a file-backed memory database");
    mkdirSync(dirname(path), { recursive: true });
    this.writer = new DatabaseSync(path);
    this.writer.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS nmg_memory_head (namespace TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nmg_memory_entities (namespace TEXT NOT NULL,
        ${ENTITY_COLUMNS.map((column) => `${column} TEXT NOT NULL`).join(",")},
        PRIMARY KEY(namespace, key));
      CREATE INDEX IF NOT EXISTS nmg_memory_kind ON nmg_memory_entities(namespace, kind, id);
      CREATE INDEX IF NOT EXISTS nmg_memory_node ON nmg_memory_entities(namespace, kind, node);
      CREATE INDEX IF NOT EXISTS nmg_memory_name ON nmg_memory_entities(namespace, kind, name);
      CREATE VIRTUAL TABLE IF NOT EXISTS nmg_memory_fts USING fts5(namespace UNINDEXED, key UNINDEXED, text);
      CREATE VIRTUAL TABLE IF NOT EXISTS nmg_memory_tessera_fts USING fts5(namespace UNINDEXED, key UNINDEXED, text);`);
    this.writer.prepare("INSERT OR IGNORE INTO nmg_memory_head VALUES (?, 0)").run(namespace);
    ensureSqliteMemoryChains(this.writer);
    ensureSqliteMemoryAssociations(this.writer);
    this.vectorIndex = new SqliteMemoryVectors(this.writer, namespace, (view) => this.reader(view));
  }

  async openRead(): Promise<MemoryReadView> {
    this.assertOpen();
    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; BEGIN");
      const revision = this.revision(db);
      const view = Object.freeze({ revision });
      this.readers.set(view, db);
      return view;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async scan(view: MemoryReadView, query: MemoryEntityQuery): Promise<MemoryEntity[]> {
    const db = this.reader(view);
    const { limit, offset } = queryBounds(query);
    const where = `namespace = ${sqlLiteral(this.namespace)} AND ${sqliteQueryWhere(query)}`;
    const fts = query.text ? ftsExpression(query.text) : undefined;
    if (fts === "") return [];
    const ftsTable = textIndex(query.kind);
    const matches = fts
      ? `JOIN (SELECT key AS fts_key, rank AS fts_rank FROM ${ftsTable}
      WHERE namespace = ${sqlLiteral(this.namespace)} AND text MATCH ${sqlLiteral(fts)})
      ON key = fts_key`
      : "";
    const order = fts ? "fts_rank, id" : "id";
    return db
      .prepare(
        `SELECT kind, payload FROM nmg_memory_entities ${matches} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(limit, offset)
      .map((row) => ({ kind: row.kind, value: JSON.parse(String(row.payload)) }) as MemoryEntity);
  }

  async receipt(view: MemoryReadView, operationId: string): Promise<MemoryCommitReceipt | null> {
    const row = this.reader(view)
      .prepare("SELECT payload FROM nmg_memory_entities WHERE namespace=? AND key=?")
      .get(this.namespace, `receipt:${operationId}`);
    return row ? (JSON.parse(String(row.payload)) as MemoryCommitReceipt) : null;
  }

  chainProjection(view: MemoryReadView, ids: readonly string[], sessionId?: string) {
    return readSqliteChainProjection(this.reader(view), this.namespace, ids, sessionId);
  }

  async closeRead(view: MemoryReadView): Promise<void> {
    const db = this.readers.get(view);
    if (!db) return;
    this.readers.delete(view);
    db.close();
  }

  async commit(request: MemoryCommitRequest): Promise<MemoryCommitOutcome> {
    validateCommit(request);
    return this.publish(request);
  }

  /** Install a trusted legacy graph on an empty namespace, including existing evidence citations. */
  async installLegacySnapshot(entities: readonly MemoryEntity[]): Promise<MemoryCommitReceipt> {
    const request = graphImportRequest(entities, true);
    validateCommit(request, entities.length);
    const outcome = this.publish(request);
    if (outcome.status === "conflict") throw new Error("Graph import requires an empty namespace");
    return outcome.receipt;
  }

  /** Legacy schema can only be retired after a backup of the locked source has been verified. */
  activateLocal(assertLegacyBackup?: () => void): void {
    this.transaction(() => {
      const current = localNamespace(this.writer);
      if (current ? current !== this.namespace : this.revision(this.writer) !== 0)
        throw new Error("Local activation requires an unused namespace");
      if (hasLegacyMemoryTables(this.writer)) {
        if (!assertLegacyBackup) throw new Error("Local memory migration requires a SQLite backup");
        assertLegacyBackup();
        if (!current) this.installLocalLegacyGraph();
        this.vectorIndex.importLegacy();
        this.vectorIndex.importLegacyHierarchy();
        this.importLegacyClaims();
        importLegacySqliteChains(this.writer, this.namespace);
        importLegacySqliteAssociations(this.writer, this.namespace);
        retireLegacyMemoryTables(this.writer);
      } else if (!current) {
        ensureLocalDaemonSchema(this.writer);
      }
      this.reindexLegacyRows();
      if (!current) this.markLocal();
    });
  }

  private installLocalLegacyGraph(): void {
    migrate(this.writer);
    const entities = readLegacyMemoryRows(this.writer, true);
    if (entities.length) {
      const request = graphImportRequest(entities, true);
      validateCommit(request, entities.length);
      this.write(request);
    }
  }

  private markLocal(): void {
    this.writer.exec(`CREATE TABLE ${LOCAL_MEMORY_TABLE} (
        id INTEGER PRIMARY KEY CHECK(id=1), namespace TEXT NOT NULL)`);
    this.writer.prepare(`INSERT INTO ${LOCAL_MEMORY_TABLE} VALUES (1, ?)`).run(this.namespace);
  }

  private importLegacyClaims(): void {
    const operationId = "migration:legacy-sqlite-claims:v1";
    if (
      this.writer
        .prepare("SELECT 1 FROM nmg_memory_entities WHERE namespace=? AND key=?")
        .get(this.namespace, `receipt:${operationId}`)
    )
      return;
    const entities = readLegacyClaimRows(this.writer);
    this.write({
      operationId,
      requestHash: requestHash(entities),
      expectedRevision: this.revision(this.writer),
      changes: { upsert: entities },
      resultIds: [],
    });
  }

  private publish(request: MemoryCommitRequest): MemoryCommitOutcome {
    return this.transaction(() => this.write(request));
  }

  private reindexLegacyRows(): void {
    this.reindexRows("migration:sqlite-tessera-index:v1", "kind='tessera'");
    this.reindexRows(
      "migration:sqlite-recall-trigger-index:v1",
      "kind='memory' AND EXISTS (SELECT 1 FROM json_each(payload, '$.markers') marker WHERE json_extract(marker.value, '$.kind')='recall_trigger')",
    );
  }

  private reindexRows(operationId: string, condition: string): void {
    if (
      this.writer
        .prepare("SELECT 1 FROM nmg_memory_entities WHERE namespace=? AND key=?")
        .get(this.namespace, `receipt:${operationId}`)
    )
      return;
    const rows = this.writer
      .prepare(`SELECT kind, payload FROM nmg_memory_entities WHERE namespace=? AND (${condition})`)
      .all(this.namespace);
    const entities = rows.map((row): MemoryEntity => ({
      kind: row.kind as "tessera" | "memory",
      value: JSON.parse(String(row.payload)),
    }));
    this.write({
      operationId,
      requestHash: requestHash(entities),
      expectedRevision: this.revision(this.writer),
      changes: { upsert: entities },
      resultIds: [],
    });
  }

  private transaction<T>(run: () => T): T {
    this.assertOpen();
    this.writer.exec("BEGIN IMMEDIATE");
    try {
      const outcome = run();
      this.writer.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.writer.exec("ROLLBACK");
      throw error;
    }
  }

  private write(request: MemoryCommitRequest): MemoryCommitOutcome {
    const previous = this.writer
      .prepare("SELECT payload FROM nmg_memory_entities WHERE namespace=? AND key=?")
      .get(this.namespace, `receipt:${request.operationId}`);
    if (previous) {
      const receipt = JSON.parse(String(previous.payload)) as MemoryCommitReceipt;
      if (receipt.requestHash !== request.requestHash)
        throw new MemoryOperationConflict(request.operationId);
      return { status: "replayed", receipt };
    }
    const revision = this.revision(this.writer);
    if (revision !== request.expectedRevision) return { status: "conflict", revision };
    const receipt: MemoryCommitReceipt = {
      operationId: request.operationId,
      requestHash: request.requestHash,
      revision: revision + 1,
      resultIds: [...request.resultIds],
      ...(request.result === undefined ? {} : { result: request.result }),
    };
    const statement = this.writer.prepare(
      `INSERT OR REPLACE INTO nmg_memory_entities VALUES (${Array(ENTITY_COLUMNS.length + 1)
        .fill("?")
        .join(",")})`,
    );
    for (const row of commitRows(request, receipt)) {
      statement.run(this.namespace, ...ENTITY_COLUMNS.map((column) => row[column]));
      if (row.kind === "memory" || row.kind === "tessera") {
        const index = textIndex(row.kind);
        this.writer
          .prepare(`DELETE FROM ${index} WHERE namespace=? AND key=?`)
          .run(this.namespace, row.key);
        this.writer
          .prepare(`INSERT INTO ${index} VALUES (?, ?, ?)`)
          .run(
            this.namespace,
            row.key,
            ftsIndexedText(
              row.kind === "memory" ? lexicalMemoryText(JSON.parse(row.payload)) : row.text,
            ),
          );
      }
    }
    this.writer
      .prepare("UPDATE nmg_memory_head SET revision=? WHERE namespace=?")
      .run(receipt.revision, this.namespace);
    return { status: "committed", receipt };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const view of this.readers.keys()) await this.closeRead(view);
    this.writer.close();
    this.closed = true;
  }

  private revision(db: DatabaseSync): number {
    return Number(
      db.prepare("SELECT revision FROM nmg_memory_head WHERE namespace=?").get(this.namespace)!
        .revision,
    );
  }

  private reader(view: MemoryReadView): DatabaseSync {
    this.assertOpen();
    const db = this.readers.get(view);
    if (!db) throw new Error("Memory read view is closed or belongs to another backend");
    return db;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Memory backend is closed");
  }
}

function textIndex(kind: string): string {
  return kind === "tessera" ? "nmg_memory_tessera_fts" : "nmg_memory_fts";
}
