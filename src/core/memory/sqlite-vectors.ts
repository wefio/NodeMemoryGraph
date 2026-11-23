import type { DatabaseSync } from "node:sqlite";
import { cosineScorer } from "../vector.ts";
import {
  memoryEmbeddingModelId,
  memoryEmbeddingText,
  type StoreRow,
} from "../store/search-ranking.ts";
import { planEmbeddingWindows, resolveEmbedChunkChars } from "../text-chunking.ts";
import { encodeVector, scoringVector } from "../store/vector-codec.ts";
import type {
  MemoryEntityQuery,
  MemoryReadView,
  MemoryVectorCandidate,
  MemoryVectorCursor,
  MemoryVectorDocument,
  MemoryVectorIndex,
  MemoryVectorQuery,
} from "./backend.ts";
import { queryBounds, sqliteQueryWhere } from "./entity-rows.ts";

/** SQLite owns the vectors, the persisted missing-vector queue and the candidate queries. */
export class SqliteMemoryVectors implements MemoryVectorIndex {
  private readonly db: DatabaseSync;
  private readonly namespace: string;
  private readonly reader: (view: MemoryReadView) => DatabaseSync;

  constructor(db: DatabaseSync, namespace: string, reader: (view: MemoryReadView) => DatabaseSync) {
    this.db = db;
    this.namespace = namespace;
    this.reader = reader;
    db.exec(`CREATE TABLE IF NOT EXISTS nmg_memory_vectors (
      namespace TEXT NOT NULL, model TEXT NOT NULL, id TEXT NOT NULL,
      dimensions INTEGER NOT NULL, vector BLOB NOT NULL,
      PRIMARY KEY(namespace, model, id));
      CREATE TABLE IF NOT EXISTS nmg_memory_vector_chunks (
        namespace TEXT NOT NULL, model TEXT NOT NULL, id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL,
        PRIMARY KEY(namespace, model, id, chunk_index));
      CREATE TABLE IF NOT EXISTS nmg_memory_vector_import (
        namespace TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS nmg_memory_embedding_order ON nmg_memory_entities
        (namespace, json_extract(payload, '$.createdAt') DESC, id) WHERE kind='memory';
      CREATE INDEX IF NOT EXISTS nmg_memory_history_sequence ON nmg_memory_entities
        (namespace, json_extract(payload, '$.sessionId'), CAST(name AS INTEGER) DESC, id)
        WHERE kind='history';`);
  }

  importLegacy(): void {
    const existing = this.db.prepare("SELECT 1 FROM nmg_memory_vector_import WHERE namespace=?");
    if (existing.get(this.namespace)) return;
    const insert = this.db.prepare(`INSERT OR IGNORE INTO nmg_memory_vectors
      SELECT ?, model, memory_id, dimensions, COALESCE(vector_blob, vector_json)
      FROM memory_embeddings JOIN nmg_memory_entities m ON m.namespace = ?
        AND m.kind = 'memory' AND m.id = memory_id`);
    insert.run(this.namespace, this.namespace);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO nmg_memory_vectors
      SELECT ?, ?, memory_id, dimensions, COALESCE(vector_blob, vector_json)
      FROM memory_embeddings JOIN nmg_memory_entities m ON m.namespace = ?
        AND m.kind = 'memory' AND m.id = memory_id WHERE model='nmg-hashing-v1'`,
      )
      .run(this.namespace, memoryEmbeddingModelId("nmg-hashing-v1"), this.namespace);
    this.db.prepare("INSERT INTO nmg_memory_vector_import VALUES (?)").run(this.namespace);
  }

  has(indexId: string, dimensions?: number): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM nmg_memory_vectors WHERE namespace=? AND model=?
      AND (? IS NULL OR dimensions=?) LIMIT 1`,
      )
      .get(this.namespace, indexId, dimensions ?? null, dimensions ?? null);
  }

  stats(indexId: string) {
    const indexed = this.db
      .prepare("SELECT count(*) AS n FROM nmg_memory_vectors WHERE namespace=? AND model=?")
      .get(this.namespace, indexId);
    const pending = this.db
      .prepare(
        `SELECT count(*) AS n FROM nmg_memory_entities m
      WHERE ${MISSING_VECTOR}`,
      )
      .get(this.namespace, indexId);
    return { indexed: Number(indexed?.n), pending: Number(pending?.n) };
  }

  pending(
    indexId: string,
    limit: number,
    after?: MemoryVectorCursor,
  ): (MemoryVectorDocument & MemoryVectorCursor)[] {
    const start = [this.namespace, indexId] as const;
    // Split the cursor at its timestamp so both parts can use ordered index ranges.
    const selection = after
      ? `same_time AS MATERIALIZED (
          ${pendingSelection(`AND ${CREATED_AT}=? AND m.id>?`, "?", "m.id")}
        ), pending AS MATERIALIZED (
          SELECT * FROM same_time
          UNION ALL
          SELECT * FROM (${pendingSelection(`AND ${CREATED_AT}<?`, "(SELECT ? - count(*) FROM same_time)")})
        )`
      : `pending AS MATERIALIZED (${pendingSelection()})`;
    const bind = after
      ? [...start, after.createdAt, after.id, limit, ...start, after.createdAt, limit]
      : [...start, limit];
    const rows = this.db
      .prepare(
        `WITH ${selection}
      SELECT m.id, m.text, m.createdAt, json_extract(m.payload, '$.eventTime') eventTime,
        ${PREVIOUS_TURN} previousTurn
      FROM pending m ORDER BY m.createdAt DESC, m.id`,
      )
      .all(...bind);
    const chunkChars = resolveEmbedChunkChars();
    return rows.flatMap((row) => expandPendingRow(row, chunkChars));
  }

  save(
    indexId: string,
    documents: readonly MemoryVectorDocument[],
    vectors: readonly (number[] | Float32Array)[],
  ): void {
    validateVectors(vectors, documents.length);
    const dimensions = vectors[0]!.length;
    const encoded = vectors.map(encodeVector);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT dimensions FROM nmg_memory_vectors WHERE namespace=? AND model=? LIMIT 1")
        .get(this.namespace, indexId);
      if (existing && Number(existing.dimensions) !== dimensions)
        throw new Error("Embedding vector dimensions differ from the configured index");
      const primary = documents
        .map((doc, i) => ({ doc, vec: encoded[i]! }))
        .filter((entry) => entry.doc.chunkIndex === undefined);
      const chunks = documents
        .map((doc, i) => ({ doc, vec: encoded[i]! }))
        .filter((entry) => entry.doc.chunkIndex !== undefined);
      this.savePrimaryBatch(indexId, dimensions, primary);
      this.saveChunkBatch(indexId, dimensions, chunks);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private savePrimaryBatch(
    indexId: string,
    dimensions: number,
    entries: readonly { doc: MemoryVectorDocument; vec: Uint8Array }[],
  ): void {
    for (let offset = 0; offset < entries.length; offset += 64) {
      const batch = entries.slice(offset, offset + 64);
      const bind = batch.flatMap(({ doc, vec }) => [`memory:${doc.id}`, doc.statement, vec]);
      this.db
        .prepare(
          `WITH incoming(key, text, vector) AS (VALUES ${batch.map(() => "(?, ?, ?)").join(",")})
          INSERT OR IGNORE INTO nmg_memory_vectors
          SELECT m.namespace, ?, m.id, ?, incoming.vector FROM incoming
          JOIN nmg_memory_entities m ON m.namespace=? AND m.key=incoming.key AND m.text=incoming.text
          WHERE ${INDEXABLE_MEMORY}`,
        )
        .run(...bind, indexId, dimensions, this.namespace);
    }
  }

  private saveChunkBatch(
    indexId: string,
    dimensions: number,
    entries: readonly { doc: MemoryVectorDocument; vec: Uint8Array }[],
  ): void {
    for (let offset = 0; offset < entries.length; offset += 64) {
      const batch = entries.slice(offset, offset + 64);
      const bind = batch.flatMap(({ doc, vec }) => [
        `memory:${doc.id}`,
        doc.statement,
        doc.chunkIndex!,
        vec,
      ]);
      this.db
        .prepare(
          `WITH incoming(key, text, chunk_index, vector) AS (VALUES ${batch.map(() => "(?, ?, ?, ?)").join(",")})
          INSERT OR REPLACE INTO nmg_memory_vector_chunks
          SELECT m.namespace, ?, m.id, incoming.chunk_index, ?, incoming.vector FROM incoming
          JOIN nmg_memory_entities m ON m.namespace=? AND m.key=incoming.key AND m.text=incoming.text
          WHERE ${INDEXABLE_MEMORY}`,
        )
        .run(...bind, indexId, dimensions, this.namespace);
    }
  }

  candidates(
    view: MemoryReadView,
    query: MemoryEntityQuery,
    semantic: MemoryVectorQuery,
  ): MemoryVectorCandidate[] {
    const db = this.reader(view);
    const { limit } = queryBounds(query);
    const cosine = cosineScorer(semantic.vector);
    db.function("nmg_memory_cosine", { deterministic: true }, (value) => {
      if (typeof value === "bigint") return 0;
      const score = cosine(scoringVector({ vector: value }));
      return Number.isFinite(score) ? score : 0;
    });
    const rows = db
      .prepare(
        `WITH eligible AS (
      SELECT namespace, id, rowid AS entity_rowid FROM nmg_memory_entities m
      WHERE namespace=? AND ${sqliteQueryWhere(query)} AND ${INDEXABLE_MEMORY}
    ), raw_scores AS (
      SELECT m.id, m.entity_rowid, nmg_memory_cosine(v.vector) AS s
      FROM eligible m JOIN nmg_memory_vectors v
        ON v.namespace=m.namespace AND v.model=? AND v.id=m.id AND v.dimensions=?
      UNION ALL
      SELECT m.id, m.entity_rowid, nmg_memory_cosine(c.vector) AS s
      FROM eligible m JOIN nmg_memory_vector_chunks c
        ON c.namespace=m.namespace AND c.model=? AND c.id=m.id AND c.dimensions=?
    ), scores AS MATERIALIZED (
      SELECT id, entity_rowid, (0.8 * MAX(s) + 0.2 * AVG(s)) AS recordScore
      FROM raw_scores GROUP BY id, entity_rowid
    ), selected AS (
      SELECT * FROM scores
      WHERE recordScore>0 ORDER BY recordScore DESC, id LIMIT ?
    )
    SELECT m.payload, selected.recordScore FROM selected
    CROSS JOIN nmg_memory_entities m ON m.rowid=selected.entity_rowid
    ORDER BY selected.recordScore DESC, selected.id`,
      )
      .all(
        this.namespace,
        semantic.indexId,
        semantic.vector.length,
        semantic.indexId,
        semantic.vector.length,
        limit,
      ) as StoreRow[];
    return rows.map((row) => ({
      entity: { kind: "memory", value: JSON.parse(String(row.payload)) },
      recordScore: Number(row.recordScore),
    }));
  }

  scoresFor(view: MemoryReadView, ids: readonly string[], semantic: MemoryVectorQuery) {
    if (!ids.length) return new Map<string, number>();
    const cosine = cosineScorer(semantic.vector);
    const rows = this.reader(view)
      .prepare(
        `SELECT v.id, v.vector FROM json_each(?) wanted
        CROSS JOIN nmg_memory_vectors v ON v.namespace=? AND v.model=?
          AND v.id=wanted.value AND v.dimensions=?
        UNION ALL
        SELECT c.id, c.vector FROM json_each(?) wanted
        CROSS JOIN nmg_memory_vector_chunks c ON c.namespace=? AND c.model=?
          AND c.id=wanted.value AND c.dimensions=?`,
      )
      .all(
        JSON.stringify(ids),
        this.namespace,
        semantic.indexId,
        semantic.vector.length,
        JSON.stringify(ids),
        this.namespace,
        semantic.indexId,
        semantic.vector.length,
      ) as StoreRow[];
    const acc = new Map<string, { max: number; sum: number; count: number }>();
    for (const row of rows) {
      const id = String(row.id);
      const score = cosine(scoringVector(row));
      if (!Number.isFinite(score)) continue;
      const cur = acc.get(id);
      if (!cur) {
        acc.set(id, { max: score, sum: score, count: 1 });
      } else {
        cur.max = Math.max(cur.max, score);
        cur.sum += score;
        cur.count += 1;
      }
    }
    return new Map(
      Array.from(acc.entries(), ([id, v]) => [id, 0.8 * v.max + 0.2 * (v.sum / v.count)]),
    );
  }
}

const INDEXABLE_MEMORY = `json_extract(m.payload, '$.status') <> 'deleted'
  AND json_extract(m.payload, '$.storageState') IS NULL
  AND NOT EXISTS (SELECT 1 FROM json_each(m.payload, '$.markers') marker
    WHERE json_extract(marker.value, '$.kind')='forget')`;
const MISSING_VECTOR = `m.namespace=? AND m.kind='memory' AND ${INDEXABLE_MEMORY}
  AND NOT EXISTS (SELECT 1 FROM nmg_memory_vectors v
    WHERE v.namespace=m.namespace AND v.model=? AND v.id=m.id)`;

const CREATED_AT = "json_extract(m.payload, '$.createdAt')";

function pendingSelection(boundary = "", limit = "?", order = `${CREATED_AT} DESC, m.id`): string {
  return `SELECT m.namespace, m.id, m.text, m.payload, ${CREATED_AT} createdAt
    FROM nmg_memory_entities m WHERE ${MISSING_VECTOR} ${boundary}
    ORDER BY ${order} LIMIT ${limit}`;
}

// Visit the few evidence IDs first, then seek directly to their history rows.
const PREVIOUS_TURN = `(SELECT json_extract(prev.payload, '$.content')
  FROM json_each(m.payload, '$.evidenceIds') link
  CROSS JOIN nmg_memory_entities h ON h.namespace=m.namespace AND h.key='history:' || link.value
  CROSS JOIN nmg_memory_entities prev ON prev.rowid=(
    SELECT candidate.rowid FROM nmg_memory_entities candidate
    WHERE candidate.namespace=m.namespace AND candidate.kind='history'
      AND json_extract(candidate.payload, '$.sessionId')=json_extract(h.payload, '$.sessionId')
      AND CAST(candidate.name AS INTEGER)<CAST(h.name AS INTEGER)
    ORDER BY CAST(candidate.name AS INTEGER) DESC, candidate.id LIMIT 1
  )
  ORDER BY CAST(prev.name AS INTEGER) DESC, CAST(link.key AS INTEGER) LIMIT 1)`;

function expandPendingRow(
  row: Record<string, unknown>,
  chunkChars: number,
): (MemoryVectorDocument & MemoryVectorCursor)[] {
  const id = String(row.id);
  const createdAt = String(row.createdAt);
  const statement = String(row.text);
  const primary: MemoryVectorDocument & MemoryVectorCursor = {
    id,
    createdAt,
    statement,
    text: memoryEmbeddingText(statement, {
      eventTime: row.eventTime as string | null | undefined,
      previousTurn: row.previousTurn as string | null | undefined,
    }),
  };
  if (chunkChars <= 0) return [primary];
  const extraWindows = planEmbeddingWindows(statement, { windowChars: chunkChars });
  if (extraWindows.length === 0) return [primary];
  return [
    primary,
    ...extraWindows.map((chunk, chunkIndex) => ({
      id,
      createdAt,
      statement,
      chunkIndex,
      text: memoryEmbeddingText(chunk, {
        eventTime: row.eventTime as string | null | undefined,
      }),
    })),
  ];
}

function validateVectors(vectors: readonly (number[] | Float32Array)[], expected: number): void {
  const dimensions = vectors[0]?.length;
  if (
    vectors.length !== expected ||
    !dimensions ||
    !vectors.every(
      (vector) =>
        vector.length === dimensions &&
        vector.every((value) => Number.isFinite(Math.fround(value))),
    )
  )
    throw new Error("Embedding provider returned an invalid vector batch");
}
