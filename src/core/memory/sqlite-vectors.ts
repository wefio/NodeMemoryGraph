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
        namespace TEXT PRIMARY KEY);`);
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

  pending(indexId: string, limit: number): MemoryVectorDocument[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.text, json_extract(m.payload, '$.eventTime') eventTime,
      (SELECT json_extract(prev.payload, '$.content')
       FROM json_each(m.payload, '$.evidenceIds') link
       JOIN nmg_memory_entities h ON h.namespace=m.namespace AND h.key='history:' || link.value
       JOIN nmg_memory_entities prev ON prev.namespace=m.namespace AND prev.kind='history'
        AND json_extract(prev.payload, '$.sessionId')=json_extract(h.payload, '$.sessionId')
        AND CAST(prev.name AS INTEGER)<CAST(h.name AS INTEGER)
       ORDER BY CAST(prev.name AS INTEGER) DESC LIMIT 1) previousTurn
      FROM nmg_memory_entities m WHERE ${MISSING_VECTOR}
      ORDER BY json_extract(m.payload, '$.createdAt') DESC, m.id LIMIT ?`,
      )
      .all(this.namespace, indexId, limit);
    return rows.map((row) => ({
      id: String(row.id),
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
    vectors: readonly number[][],
  ): void {
    validateVectors(vectors, documents.length);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO nmg_memory_vectors
      SELECT m.namespace, ?, m.id, ?, ? FROM nmg_memory_entities m
      WHERE m.namespace=? AND m.key=? AND m.text=? AND ${INDEXABLE_MEMORY}`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT dimensions FROM nmg_memory_vectors WHERE namespace=? AND model=? LIMIT 1")
        .get(this.namespace, indexId);
      if (existing && Number(existing.dimensions) !== vectors[0]!.length)
        throw new Error("Embedding vector dimensions differ from the configured index");
      documents.forEach((doc, i) => {
        const vector = vectors[i]!;
        insert.run(
          indexId,
          vector.length,
          encodeVector(vector),
          this.namespace,
          `memory:${doc.id}`,
          doc.statement,
        );
      });
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
    const hierarchy =
      semantic.granularity !== "records" &&
      db.prepare("SELECT 1 FROM nmg_memory_vector_import WHERE namespace=?").get(this.namespace);
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
  AND NOT EXISTS (SELECT 1 FROM json_each(m.payload, '$.markers') marker
    WHERE json_extract(marker.value, '$.kind')='forget')`;
const MISSING_VECTOR = `m.namespace=? AND m.kind='memory' AND ${INDEXABLE_MEMORY}
  AND NOT EXISTS (SELECT 1 FROM nmg_memory_vectors v
    WHERE v.namespace=m.namespace AND v.model=? AND v.id=m.id)`;

const HIERARCHY_SCORE = `max(coalesce((
  SELECT nmg_memory_cosine(COALESCE(n.vector_blob,n.vector_json))
  FROM node_embeddings n WHERE n.node_id=m.node AND n.model=?
), 0), coalesce((
  SELECT max(nmg_memory_cosine(COALESCE(l.vector_blob,l.vector_json)))
  FROM memory_leaf_members member JOIN leaf_embeddings l ON l.block_id=member.block_id
  WHERE member.memory_id=m.id AND l.model=?
), 0))`;

function validateVectors(vectors: readonly number[][], expected: number): void {
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
