import { mkdirSync } from "node:fs";
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
  entityRow,
  queryBounds,
  queryWhere,
  receiptRow,
  sqlLiteral,
  validateCommit,
} from "./entity-rows.ts";

/** Portable memory format. The legacy Store is imported explicitly, never opened as this schema. */
export class SqliteMemoryBackend implements MemoryBackend {
  readonly kind = "sqlite" as const;
  private readonly writer: DatabaseSync;
  private readonly readers = new Map<MemoryReadView, DatabaseSync>();
  private closed = false;
  private readonly path: string;
  readonly namespace: string;

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
      CREATE VIRTUAL TABLE IF NOT EXISTS nmg_memory_fts USING fts5(namespace UNINDEXED, key UNINDEXED, text);`);
    this.writer.prepare("INSERT OR IGNORE INTO nmg_memory_head VALUES (?, 0)").run(namespace);
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
    let where = `namespace = ${sqlLiteral(this.namespace)} AND ${queryWhere(query)}`;
    if (query.text?.trim()) {
      const terms = query.text
        .trim()
        .split(/\s+/u)
        .map((word) => `"${word.replaceAll('"', '""')}"`)
        .join(" OR ");
      where += ` AND key IN (SELECT key FROM nmg_memory_fts WHERE namespace = ${sqlLiteral(this.namespace)} AND text MATCH ${sqlLiteral(terms)})`;
    }
    return db
      .prepare(
        `SELECT kind, payload FROM nmg_memory_entities WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`,
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

  async closeRead(view: MemoryReadView): Promise<void> {
    const db = this.readers.get(view);
    if (!db) return;
    this.readers.delete(view);
    db.close();
  }

  async commit(request: MemoryCommitRequest): Promise<MemoryCommitOutcome> {
    this.assertOpen();
    validateCommit(request);
    this.writer.exec("BEGIN IMMEDIATE");
    try {
      const outcome = this.write(request);
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
      result: request.result,
    };
    const statement = this.writer.prepare(
      `INSERT OR REPLACE INTO nmg_memory_entities VALUES (${Array(ENTITY_COLUMNS.length + 1)
        .fill("?")
        .join(",")})`,
    );
    for (const row of [...request.changes.upsert.map(entityRow), receiptRow(receipt)]) {
      statement.run(this.namespace, ...ENTITY_COLUMNS.map((column) => row[column]));
      this.writer
        .prepare("DELETE FROM nmg_memory_fts WHERE namespace=? AND key=?")
        .run(this.namespace, row.key);
      if (row.kind === "memory")
        this.writer
          .prepare("INSERT INTO nmg_memory_fts VALUES (?, ?, ?)")
          .run(this.namespace, row.key, row.text);
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
