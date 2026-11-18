import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity } from "../vector.ts";
import {
  memoryEmbeddingModelId,
  memoryEmbeddingText,
  type StoreRow,
} from "../store/search-ranking.ts";
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
      CREATE TABLE IF NOT EXISTS nmg_memory_vector_import (
        namespace TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS nmg_memory_route_vectors (
        namespace TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
        id TEXT NOT NULL, vector BLOB NOT NULL,
        PRIMARY KEY(namespace, model, kind, id));
      CREATE TABLE IF NOT EXISTS nmg_memory_route_members (
        namespace TEXT NOT NULL, memory_id TEXT NOT NULL, leaf_id TEXT NOT NULL,
        PRIMARY KEY(namespace, memory_id, leaf_id));
      CREATE INDEX IF NOT EXISTS nmg_memory_embedding_order ON nmg_memory_entities
        (namespace, json_extract(payload, '$.createdAt') DESC, id) WHERE kind='memory';
      CREATE INDEX IF NOT EXISTS nmg_memory_history_sequence ON nmg_memory_entities
        (namespace, json_extract(payload, '$.sessionId'), CAST(name AS INTEGER) DESC, id)
        WHERE kind='history';`);
  }

  importLegacyHierarchy(): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO nmg_memory_route_vectors
      SELECT ?, model, 'node', node_id, COALESCE(vector_blob, vector_json) FROM node_embeddings
      WHERE COALESCE(vector_blob, vector_json) IS NOT NULL`,
      )
      .run(this.namespace);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO nmg_memory_route_vectors
      SELECT ?, model, 'leaf', block_id, COALESCE(vector_blob, vector_json) FROM leaf_embeddings
      WHERE COALESCE(vector_blob, vector_json) IS NOT NULL`,
      )
      .run(this.namespace);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO nmg_memory_route_members
      SELECT ?, memory_id, block_id FROM memory_leaf_members`,
      )
      .run(this.namespace);
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
    return rows.map((row) => ({
      id: String(row.id),
      createdAt: String(row.createdAt),
      statement: String(row.text),
      text: memoryEmbeddingText(row.text, {
        eventTime: row.eventTime,
        previousTurn: row.previousTurn,
      }),
    }));
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
      for (let offset = 0; offset < documents.length; offset += 64) {
        const batch = documents.slice(offset, offset + 64);
        const bind = batch.flatMap((doc, i) => [
          `memory:${doc.id}`,
          doc.statement,
          encoded[offset + i]!,
        ]);
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
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  candidates(
    view: MemoryReadView,
    query: MemoryEntityQuery,
    semantic: MemoryVectorQuery,
  ): MemoryVectorCandidate[] {
    const db = this.reader(view);
    const { limit } = queryBounds(query);
    db.function("nmg_memory_cosine", { deterministic: true }, (value) => {
      if (typeof value === "bigint") return 0;
      const score = cosineSimilarity(semantic.vector, scoringVector({ vector: value }));
      return Number.isFinite(score) ? score : 0;
    });
    const hierarchy = semantic.granularity !== "records";
    const rows = db
      .prepare(
        `WITH eligible AS (
      SELECT namespace, id, node, payload FROM nmg_memory_entities m
      WHERE namespace=? AND ${sqliteQueryWhere(query)} AND ${INDEXABLE_MEMORY}
    ), scores AS MATERIALIZED (
      SELECT m.id, m.payload,
        COALESCE(nmg_memory_cosine(v.vector), 0) AS recordScore,
        ${hierarchy ? HIERARCHY_SCORE : "0"} AS routeScore
      FROM eligible m LEFT JOIN nmg_memory_vectors v
        ON v.namespace=m.namespace AND v.model=? AND v.id=m.id AND v.dimensions=?
    )
    SELECT payload, recordScore, routeScore FROM scores
    WHERE max(recordScore, routeScore)>0 ORDER BY max(recordScore, routeScore) DESC, id LIMIT ?`,
      )
      .all(
        this.namespace,
        ...(hierarchy ? [semantic.indexId, semantic.indexId] : []),
        semantic.indexId,
        semantic.vector.length,
        limit,
      ) as StoreRow[];
    return rows.map((row) => ({
      entity: { kind: "memory", value: JSON.parse(String(row.payload)) },
      recordScore: Number(row.recordScore),
      routeScore: Number(row.routeScore),
    }));
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

// Keep the current memory's memberships on the outer side of the leaf lookup.
const HIERARCHY_SCORE = `max(coalesce((
  SELECT nmg_memory_cosine(n.vector)
  FROM nmg_memory_route_vectors n
  WHERE n.namespace=m.namespace AND n.kind='node' AND n.id=m.node AND n.model=?
), 0), coalesce((
  SELECT max(nmg_memory_cosine(l.vector))
  FROM nmg_memory_route_members member CROSS JOIN nmg_memory_route_vectors l
    ON l.namespace=member.namespace AND l.kind='leaf' AND l.id=member.leaf_id
  WHERE member.namespace=m.namespace AND member.memory_id=m.id AND l.model=?
), 0))`;

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
