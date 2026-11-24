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
  MemoryRelationalProjectionPage,
  MemoryRelationalProjectionQuery,
  MemoryVectorCandidate,
  MemoryVectorQuery,
  RelationalMemoryNeighbor,
  SourceNeighbor,
} from "./backend.ts";
import type { HistoryRecord, MemoryRecord } from "../types.ts";
import { validateCommit } from "./entity-rows.ts";
import { graphImportRequest } from "./graph-import.ts";
import { readLegacyClaimRows, readLegacyMemoryRows } from "../store/legacy-memory-snapshot.ts";
import { requestHash } from "./model.ts";
import { ensureLocalDaemonSchema, migrate } from "../store/schema.ts";
import { ftsExpression, surfaceTrigramExpression } from "../store/search-ranking.ts";
import {
  ensureSqliteTextIndexes,
  rebuildSqliteTextIndexes,
  writeMemoryTextIndex,
  writeTesseraTextIndex,
} from "./sqlite-text-index.ts";
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
import { ensureAuthoritativeRelationalSchema } from "./sqlite-entity-migration.ts";
import { writeRelationalCommit } from "./sqlite-relational-writes.ts";
import {
  projectRelationalMemories,
  readRelationalCounts,
  readRelationalLexicalMemoryPage,
  readRelationalMemoryNeighbors,
  readRelationalReceipt,
  readSourceTurnMetadata,
  scanRelational,
  scanRelationalBatch,
} from "./sqlite-relational.ts";

const LOCAL_MEMORY_TABLE = "nmg_local_memory";
const MAX_IDLE_READERS = 4;
const SURFACE_TRIGRAM_WEIGHT = 0.35;
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

/** Authoritative relational SQLite memory backend. Legacy schemas are imported once and retired. */
export class SqliteMemoryBackend implements MemoryBackend {
  readonly kind = "sqlite" as const;
  private readonly writer: DatabaseSync;
  private readonly readers = new Map<MemoryReadView, DatabaseSync>();
  private readonly idleReaders: DatabaseSync[] = [];
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
    this.writer.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      PRAGMA wal_autocheckpoint=4000; PRAGMA cache_size=-16000; PRAGMA temp_store=MEMORY;`);
    ensureAuthoritativeRelationalSchema(this.writer, this.namespace);
    ensureSqliteTextIndexes(this.writer);
    ensureSqliteLeafGroups(this.writer);
    this.writer.prepare("INSERT OR IGNORE INTO nmg_memory_head VALUES (?, 0)").run(this.namespace);
    ensureSqliteMemoryChains(this.writer);
    ensureSqliteMemoryAssociations(this.writer);
  }

  async counts(view: MemoryReadView): Promise<{ memories: number; nodes: number }> {
    return readRelationalCounts(this.reader(view), this.namespace);
  }

  async openRead(): Promise<MemoryReadView> {
    this.assertOpen();
    if (this.requestScoped) {
      const revision = this.revision(this.writer);
      const view = Object.freeze({ revision });
      this.readers.set(view, this.writer);
      return view;
    }
    const db = this.idleReaders.pop() ?? new DatabaseSync(this.path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; BEGIN");
      const revision = this.revision(db);
      const view = Object.freeze({ revision });
      this.readers.set(view, db);
      return view;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure on an unusable reader connection.
      }
      db.close();
      throw error;
    }
  }

  async scan(view: MemoryReadView, query: MemoryEntityQuery): Promise<MemoryEntity[]> {
    return scanRelational(this.reader(view), this.namespace, query);
  }

  adjacentSources(
    view: MemoryReadView,
    source: HistoryRecord,
    query: MemoryEntityQuery,
  ): SourceNeighbor[] {
    return readSqliteAdjacentSources(this.reader(view), this.namespace, source, query);
  }

  projectMemories(
    view: MemoryReadView,
    query: MemoryRelationalProjectionQuery,
  ): MemoryRelationalProjectionPage {
    return projectRelationalMemories(this.reader(view), this.namespace, query);
  }

  relationalNeighbors(
    view: MemoryReadView,
    anchor: MemoryRecord,
    query: MemoryEntityQuery,
  ): RelationalMemoryNeighbor[] {
    return readRelationalMemoryNeighbors(this.reader(view), this.namespace, anchor, query);
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
    const surfaceExpr = surfaceTrigramExpression(query.text);
    const db = this.reader(view);
    const lexicalById = collectHybridLexicalHits(
      db,
      this.namespace,
      query,
      expression,
      surfaceExpr,
    );
    const lexical = [...lexicalById.values()].sort(
      (left, right) =>
        right.bm25 - left.bm25 ||
        (left.entity.value.id < right.entity.value.id
          ? -1
          : Number(left.entity.value.id > right.entity.value.id)),
    );
    const lexicalIds = lexical.map(({ entity }) => entity.value.id);
    const lexicalSet = new Set(lexicalIds);
    const extraVector = this.vectorIndex.scoresFor(
      view,
      lexicalIds.filter((id) => !vectorScores.has(id)),
      semantic,
    );
    const extraLexical =
      expression || surfaceExpr
        ? readCrossBm25(
            db,
            this.namespace,
            expression,
            surfaceExpr,
            [...vectorScores.keys()].filter((id) => !lexicalSet.has(id)),
          )
        : new Map<string, number>();
    const candidates = [
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
    ];
    return {
      vectorIds: [...vectorScores.keys()],
      lexicalIds,
      candidates: withSourceTurnMetadata(db, this.namespace, candidates),
    };
  }

  async scanBatch(
    view: MemoryReadView,
    queries: readonly MemoryEntityQuery[],
  ): Promise<MemoryEntity[][]> {
    return scanRelationalBatch(this.reader(view), this.namespace, queries);
  }

  async receipt(view: MemoryReadView, operationId: string): Promise<MemoryCommitReceipt | null> {
    return readRelationalReceipt(this.reader(view), this.namespace, operationId);
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

  /** Rebuild derived FTS5 text indexes and prune orphaned vectors from authoritative relational tables. */
  rebuildDerivedIndexes(): void {
    this.assertOpen();
    rebuildSqliteTextIndexes(this.writer);
    this.vectorIndex.pruneOrphans();
  }

  async closeRead(view: MemoryReadView): Promise<void> {
    const db = this.readers.get(view);
    if (!db) return;
    this.readers.delete(view);
    if (db === this.writer) return;
    try {
      db.exec("ROLLBACK");
    } catch {
      db.close();
      return;
    }
    if (!this.closed && this.idleReaders.length < MAX_IDLE_READERS) {
      this.idleReaders.push(db);
    } else {
      db.close();
    }
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
    if (readRelationalReceipt(this.writer, this.namespace, operationId)) return;
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
    const previous = readRelationalReceipt(this.writer, this.namespace, request.operationId);
    if (previous) {
      if (previous.requestHash !== request.requestHash)
        throw new MemoryOperationConflict(request.operationId);
      return { status: "replayed", receipt: previous };
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
    writeRelationalCommit(this.writer, this.namespace, request, receipt, {
      onMemoryText: (memory) => writeMemoryTextIndex(this.writer, this.namespace, memory),
      onMemoryPurged: (memoryId) => this.vectorIndex.deleteForMemory(memoryId),
      onTesseraText: (tessera) => writeTesseraTextIndex(this.writer, this.namespace, tessera),
    });
    this.writer
      .prepare("UPDATE nmg_memory_head SET revision=? WHERE namespace=?")
      .run(receipt.revision, this.namespace);
    return { status: "committed", receipt };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const view of [...this.readers.keys()]) await this.closeRead(view);
    while (this.idleReaders.length > 0) this.idleReaders.pop()?.close();
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

function collectHybridLexicalHits(
  db: DatabaseSync,
  namespace: string,
  query: MemoryEntityQuery,
  expression: string,
  surfaceExpr: string,
): Map<string, { entity: Extract<MemoryEntity, { kind: "memory" }>; bm25: number }> {
  const lexicalById = new Map<
    string,
    { entity: Extract<MemoryEntity, { kind: "memory" }>; bm25: number }
  >();
  if (expression) {
    for (const hit of readRelationalLexicalMemoryPage(db, namespace, query, expression)) {
      lexicalById.set(hit.entity.value.id, { ...hit });
    }
  }
  if (surfaceExpr) {
    for (const hit of readRelationalLexicalMemoryPage(
      db,
      namespace,
      query,
      surfaceExpr,
      "nmg_memory_surface_fts",
    )) {
      const bm25 = hit.bm25 * SURFACE_TRIGRAM_WEIGHT;
      const existing = lexicalById.get(hit.entity.value.id);
      if (existing) existing.bm25 += bm25;
      else lexicalById.set(hit.entity.value.id, { entity: hit.entity, bm25 });
    }
  }
  return lexicalById;
}

function readCrossBm25(
  db: DatabaseSync,
  namespace: string,
  expression: string,
  surfaceExpr: string,
  ids: string[],
) {
  const scores = new Map<string, number>();
  if (!ids.length || (!expression && !surfaceExpr)) return scores;
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
  const accumulate = (table: string, expr: string, weight: number): void => {
    if (!expr) return;
    for (const row of db
      .prepare(`SELECT rowid, -rank AS score FROM ${table} WHERE ${table} MATCH ?`)
      .iterate(expr)) {
      const id = wanted.get(row.rowid);
      if (id !== undefined) scores.set(id, (scores.get(id) ?? 0) + Number(row.score) * weight);
    }
  };
  accumulate("nmg_memory_fts", expression, 1);
  accumulate("nmg_memory_surface_fts", surfaceExpr, SURFACE_TRIGRAM_WEIGHT);
  return scores;
}

function withSourceTurnMetadata(
  db: DatabaseSync,
  namespace: string,
  candidates: Array<MemoryVectorCandidate & { bm25: number }>,
): MemoryHybridPage["candidates"] {
  const sourceIds = [
    ...new Set(candidates.map(({ entity }) => entity.value.evidenceId).filter(Boolean)),
  ];
  const bySource = readSourceTurnMetadata(db, namespace, sourceIds);
  return candidates.map((item) => {
    const meta = bySource.get(item.entity.value.evidenceId);
    return meta ? { ...item, sourceSessionId: meta.sessionId, turnOrdinal: meta.ordinal } : item;
  });
}
