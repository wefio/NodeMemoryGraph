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
  MemoryHybridPage,
  MemoryReadView,
  MemoryVectorQuery,
  SourceNeighbor,
} from "./backend.ts";
import type { HistoryRecord } from "../types.ts";
import {
  ENTITY_COLUMNS,
  SQLITE_HISTORY_SOURCE,
  commitRows,
  queryBounds,
  sqliteQueryWhere,
  sqlLiteral,
  validateCommit,
} from "./entity-rows.ts";
import type { EntityRow } from "./entity-rows.ts";
import { graphImportRequest } from "./graph-import.ts";
import { readLegacyClaimRows, readLegacyMemoryRows } from "../store/legacy-memory-snapshot.ts";
import { requestHash } from "./model.ts";
import { ensureLocalDaemonSchema, migrate } from "../store/schema.ts";
import { ftsExpression } from "../store/search-ranking.ts";
import { ensureSqliteTextIndexes, textIndex, writeSqliteTextIndex } from "./sqlite-text-index.ts";
import {
  ensureSqliteLeafGroups,
  importLegacySqliteLeaves,
  readSqliteAdjacentSources,
  readSqliteLeafPeers,
} from "./sqlite-leaves.ts";
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
const SQL_BATCH_SIZE = 64;
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
  private readonly requestScoped: boolean;

  constructor(path: string, namespace: string, requestScoped = false) {
    this.path = path;
    this.requestScoped = requestScoped;
    this.namespace = namespace;
    if (!namespace.trim()) throw new Error("Memory namespace is required");
    if (path === ":memory:")
      throw new Error("Snapshot reads require a file-backed memory database");
    mkdirSync(dirname(path), { recursive: true });
    this.writer = new DatabaseSync(path);
    try {
      this.initializeSchema();
      this.vectorIndex = new SqliteMemoryVectors(this.writer, namespace, (view) =>
        this.reader(view),
      );
    } catch (error) {
      this.writer.close();
      throw error;
    }
  }

  private initializeSchema(): void {
    this.writer.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS nmg_memory_head (namespace TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nmg_memory_entities (namespace TEXT NOT NULL,
        ${ENTITY_COLUMNS.map((column) => `${column} TEXT NOT NULL`).join(",")},
        PRIMARY KEY(namespace, key));
      CREATE INDEX IF NOT EXISTS nmg_memory_kind ON nmg_memory_entities(namespace, kind, id);
      CREATE INDEX IF NOT EXISTS nmg_memory_node ON nmg_memory_entities(namespace, kind, node);
      CREATE INDEX IF NOT EXISTS nmg_memory_node_name
        ON nmg_memory_entities(namespace, name, id) WHERE kind='node';
      CREATE INDEX IF NOT EXISTS nmg_memory_history_source
        ON nmg_memory_entities(namespace, ${SQLITE_HISTORY_SOURCE}, id) WHERE kind='history';
      DROP INDEX IF EXISTS nmg_memory_name;
      CREATE INDEX IF NOT EXISTS nmg_memory_scope_node
        ON nmg_memory_entities(namespace, kind, node, scope, id);
      CREATE INDEX IF NOT EXISTS nmg_memory_scope_name
        ON nmg_memory_entities(namespace, kind, name, scope, id);
      CREATE INDEX IF NOT EXISTS nmg_memory_state
        ON nmg_memory_entities(namespace, statekey, scope, id) WHERE kind='memory';
      CREATE INDEX IF NOT EXISTS nmg_memory_edge_source
        ON nmg_memory_entities(namespace, source, id) WHERE kind='edge';
      CREATE INDEX IF NOT EXISTS nmg_memory_edge_target
        ON nmg_memory_entities(namespace, target, id) WHERE kind='edge';`);
    ensureSqliteTextIndexes(this.writer);
    ensureSqliteLeafGroups(this.writer);
    this.writer.prepare("INSERT OR IGNORE INTO nmg_memory_head VALUES (?, 0)").run(this.namespace);
    ensureSqliteMemoryChains(this.writer);
    ensureSqliteMemoryAssociations(this.writer);
  }

  async counts(view: MemoryReadView): Promise<{ memories: number; nodes: number }> {
    const rows = this.reader(view)
      .prepare(
        "SELECT kind, count(*) AS n FROM nmg_memory_entities WHERE namespace=? AND kind IN ('memory','node') GROUP BY kind",
      )
      .all(this.namespace);
    const counts = new Map(rows.map((row) => [String(row.kind), Number(row.n)]));
    return { memories: counts.get("memory") ?? 0, nodes: counts.get("node") ?? 0 };
  }

  async openRead(): Promise<MemoryReadView> {
    this.assertOpen();
    const db = this.requestScoped ? this.writer : new DatabaseSync(this.path, { readOnly: true });
    try {
      if (!this.requestScoped) db.exec("PRAGMA query_only=ON; BEGIN");
      const revision = this.revision(db);
      const view = Object.freeze({ revision });
      this.readers.set(view, db);
      return view;
    } catch (error) {
      if (db !== this.writer) db.close();
      throw error;
    }
  }

  async scan(view: MemoryReadView, query: MemoryEntityQuery): Promise<MemoryEntity[]> {
    const page = entityPage(this.namespace, query);
    return this.reader(view)
      .prepare(page.sql)
      .all(...page.bind)
      .map(decodeEntity);
  }

  adjacentSources(
    view: MemoryReadView,
    source: HistoryRecord,
    query: MemoryEntityQuery,
  ): SourceNeighbor[] {
    return readSqliteAdjacentSources(this.reader(view), this.namespace, source, query);
  }

  hybridCandidates(
    view: MemoryReadView,
    query: MemoryEntityQuery & { text: string },
    semantic: MemoryVectorQuery,
  ): MemoryHybridPage {
    const vector = this.vectorIndex.candidates(view, query, semantic);
    const vectorScores = new Map(
      vector.map(({ entity, recordScore }) => [entity.value.id, recordScore]),
    );
    const expression = ftsExpression(query.text);
    const db = this.reader(view);
    const lexical = expression ? readLexicalMemoryPage(db, this.namespace, query, expression) : [];
    const lexicalIds = lexical.map(({ entity }) => entity.value.id);
    const lexicalSet = new Set(lexicalIds);
    const extraVector = this.vectorIndex.scoresFor(
      view,
      lexicalIds.filter((id) => !vectorScores.has(id)),
      semantic,
    );
    const extraLexical = expression
      ? readCrossBm25(
          db,
          this.namespace,
          expression,
          [...vectorScores.keys()].filter((id) => !lexicalSet.has(id)),
        )
      : new Map<string, number>();
    return {
      vectorIds: [...vectorScores.keys()],
      lexicalIds,
      candidates: [
        ...lexical.map(({ entity, bm25 }) => ({
          entity,
          bm25,
          recordScore: vectorScores.get(entity.value.id) ?? extraVector.get(entity.value.id) ?? 0,
        })),
        ...vector
          .filter(({ entity }) => !lexicalSet.has(entity.value.id))
          .map((candidate) => ({
            ...candidate,
            bm25: extraLexical.get(candidate.entity.value.id) ?? 0,
          })),
      ],
    };
  }

  async scanBatch(
    view: MemoryReadView,
    queries: readonly MemoryEntityQuery[],
  ): Promise<MemoryEntity[][]> {
    const db = this.reader(view);
    const results: MemoryEntity[][] = queries.map(() => []);
    for (let offset = 0; offset < queries.length; offset += SQL_BATCH_SIZE) {
      const pages = queries
        .slice(offset, offset + SQL_BATCH_SIZE)
        .map((query) => entityPage(this.namespace, query));
      const sql = pages
        .map((page, i) => `SELECT ${offset + i} AS slot, * FROM (${page.sql})`)
        .join(" UNION ALL ");
      for (const row of db.prepare(sql).all(...pages.flatMap((page) => page.bind))) {
        results[Number(row.slot)]!.push(decodeEntity(row));
      }
    }
    return results;
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

  async leafPeers(
    view: MemoryReadView,
    seedIds: readonly string[],
    excluded: readonly string[],
    query: MemoryEntityQuery,
  ): Promise<MemoryEntity[]> {
    return readSqliteLeafPeers(this.reader(view), this.namespace, seedIds, excluded, query);
  }

  async closeRead(view: MemoryReadView): Promise<void> {
    const db = this.readers.get(view);
    if (!db) return;
    this.readers.delete(view);
    if (db !== this.writer) db.close();
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
    this.activate(assertLegacyBackup);
  }

  /** The object store retains its immutable source image until its manifest publishes. */
  activateSnapshot(): void {
    if (!this.requestScoped) throw new Error("Snapshot activation requires request-scoped SQLite");
    this.activate(() => {});
  }

  private activate(assertLegacyBackup?: () => void): void {
    this.transaction(() => {
      const current = localNamespace(this.writer);
      if (current ? current !== this.namespace : this.revision(this.writer) !== 0)
        throw new Error("Local activation requires an unused namespace");
      if (hasLegacyMemoryTables(this.writer)) {
        if (!assertLegacyBackup) throw new Error("Local memory migration requires a SQLite backup");
        assertLegacyBackup();
        if (!current) this.installLocalLegacyGraph();
        this.vectorIndex.importLegacy();
        importLegacySqliteLeaves(this.writer, this.namespace);
        this.importLegacyClaims();
        importLegacySqliteChains(this.writer, this.namespace);
        importLegacySqliteAssociations(this.writer, this.namespace);
        retireLegacyMemoryTables(this.writer);
      } else if (!current && !this.requestScoped) {
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
    const rows = commitRows(request, receipt);
    this.writeEntities(rows);
    for (const row of rows) {
      if (row.kind === "memory" || row.kind === "tessera")
        writeSqliteTextIndex(this.writer, this.namespace, row);
    }
    this.writer
      .prepare("UPDATE nmg_memory_head SET revision=? WHERE namespace=?")
      .run(receipt.revision, this.namespace);
    return { status: "committed", receipt };
  }

  private writeEntities(rows: readonly EntityRow[]): void {
    const tuple = `(${Array(ENTITY_COLUMNS.length + 1)
      .fill("?")
      .join(",")})`;
    for (let offset = 0; offset < rows.length; offset += SQL_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + SQL_BATCH_SIZE);
      this.writer
        .prepare(
          `INSERT OR REPLACE INTO nmg_memory_entities VALUES ${batch.map(() => tuple).join(",")}`,
        )
        .run(
          ...batch.flatMap((row) => [
            this.namespace,
            ...ENTITY_COLUMNS.map((column) => row[column]),
          ]),
        );
    }
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

function entityPage(namespace: string, query: MemoryEntityQuery, scoredExpression?: string) {
  const { limit, offset } = queryBounds(query);
  if (query.kind === "edge" && query.connectedTo !== undefined && !query.text)
    return { sql: adjacentEdgePage(namespace, query, query.connectedTo), bind: [limit, offset] };
  const where = `namespace = ${sqlLiteral(namespace)} AND ${sqliteQueryWhere(query)}`;
  const fts = scoredExpression ?? (query.text ? ftsExpression(query.text) : undefined);
  const [kind, table] = textIndex(query.kind);
  // Start from MATCH results so SQLite only looks up entities that matched.
  const from = fts
    ? `(SELECT r.key AS fts_key, f.rank AS fts_rank FROM ${table} f
      CROSS JOIN nmg_memory_fts_rows r ON r.fts_rowid=f.rowid
      WHERE r.namespace = ${sqlLiteral(namespace)} AND r.key GLOB '${kind}:*'
        AND f.text MATCH ${sqlLiteral(fts)})
      CROSS JOIN nmg_memory_entities ON key = fts_key`
    : "nmg_memory_entities";
  const order = fts ? "fts_rank, id" : "id";
  return {
    sql: `SELECT kind, payload${scoredExpression ? ", -fts_rank AS bm25" : ""} FROM ${from}
      WHERE ${fts === "" ? "1 = 0" : where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    bind: [limit, offset],
  };
}

function readLexicalMemoryPage(
  db: DatabaseSync,
  namespace: string,
  query: MemoryEntityQuery,
  expression: string,
) {
  const page = entityPage(namespace, query, expression);
  return db
    .prepare(page.sql)
    .all(...page.bind)
    .map((row) => ({
      entity: decodeEntity(row) as Extract<MemoryEntity, { kind: "memory" }>,
      bm25: Number(row.bm25),
    }));
}

function readCrossBm25(db: DatabaseSync, namespace: string, expression: string, ids: string[]) {
  const scores = new Map<string, number>();
  if (!ids.length) return scores;
  const wanted = new Map(
    db
      .prepare(
        `SELECT r.fts_rowid, wanted.value AS id
      FROM json_each(?) wanted CROSS JOIN nmg_memory_fts_rows r
        ON r.namespace=? AND r.key='memory:' || wanted.value`,
      )
      .all(JSON.stringify(ids), namespace)
      .map((row) => [row.fts_rowid, String(row.id)]),
  );
  if (!wanted.size) return scores;
  // One MATCH scan shares the query's BM25 statistics. Probing each rowid repeats that work.
  for (const row of db
    .prepare(`SELECT rowid, -rank AS score FROM nmg_memory_fts WHERE text MATCH ?`)
    .iterate(expression)) {
    const id = wanted.get(row.rowid);
    if (id !== undefined) scores.set(id, Number(row.score));
  }
  return scores;
}

function adjacentEdgePage(namespace: string, query: MemoryEntityQuery, nodeId: string): string {
  const where = `namespace = ${sqlLiteral(namespace)} AND ${sqliteQueryWhere({
    ...query,
    connectedTo: undefined,
  })}`;
  const node = sqlLiteral(nodeId);
  const edges = `SELECT kind, payload, id FROM nmg_memory_entities WHERE ${where}`;
  // Merge the two index ranges before paging. The source branch already includes any self-loop.
  return `SELECT kind, payload FROM (
    ${edges} AND source = ${node}
    UNION ALL
    ${edges} AND target = ${node} AND source <> ${node}
    ORDER BY id LIMIT ? OFFSET ?
  )`;
}

function decodeEntity(row: { kind?: unknown; payload?: unknown }): MemoryEntity {
  return { kind: row.kind, value: JSON.parse(String(row.payload)) } as MemoryEntity;
}
