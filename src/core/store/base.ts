import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  ConsolidationEvent,
  EmbeddingDocument,
  ExternalEmbedding,
  ExternalLeafEmbedding,
  ExternalNodeEmbedding,
  HistoryRecord,
  MemoryActor,
  MemoryNode,
  LeafBlock,
  LeafEmbeddingDocument,
  NodeEmbeddingDocument,
  NodeRoute,
  NodeTransform,
  MemoryRecord,
  MemoryWriteEvent,
  MemorySearchResult,
  MemoryScope,
  MemoryTier,
  NodeRelation,
  NodeRelationType,
  RetrievalFilterUsage,
  PerfSnapshot,
  SearchOptions,
  TopologyProposal,
  VectorEmbedder,
} from "../types.ts";
import { histogramAdd } from "../perf.ts";
import { Router } from "../router.ts";
import { cosineSimilarity, HashingVectorEmbedder } from "../vector.ts";
import { Float32VectorCache } from "../vector-cache.ts";
import { migrate } from "./schema.ts";
import { parseNumberArray, parseStringArray } from "./row-parse.ts";
import { encodeVector, storedVector } from "./vector-codec.ts";
import { stableTaskId } from "./active-graph.ts";
import { updateRelationStrength } from "../edge-activation.ts";
import {
  ftsExpression,
  hybridScore,
  lexicalScore,
  memoryEmbeddingText,
  normalize,
  type StoreRow as Row,
} from "./search-ranking.ts";

import {
  identityTokens,
  mapConsolidationEvent,
  mapHistory,
  mapLeafBlock,
  mapNode,
  mapRelation,
  mapSearchResult,
  matchesScope,
  serializeScope,
} from "./rows.ts";

const MAX_SEARCH_CANDIDATES = 500;

export class NmgStoreBase {
  protected db: DatabaseSync;
  protected embedder: VectorEmbedder;
  protected router: Router;
  protected vectorCaches = new Map<string, Float32VectorCache>();

  constructor(databasePath: string, embedder: VectorEmbedder = new HashingVectorEmbedder()) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.embedder = embedder;
    this.router = new Router(embedder);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -64000;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
      PRAGMA busy_timeout = 5000;
    `);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }
  cascadeDerivedMemories(sourceMemoryId: string): void {
    const derivations = this.db
      .prepare("SELECT derived_memory_id FROM memory_derivations WHERE source_memory_id = ?")
      .all(sourceMemoryId) as Row[];
    this.db
      .prepare("DELETE FROM memory_derivations WHERE source_memory_id = ?")
      .run(sourceMemoryId);
    for (const row of derivations) {
      const derivedId = String(row.derived_memory_id);
      const remaining = this.db
        .prepare("SELECT 1 FROM memory_derivations WHERE derived_memory_id = ?")
        .get(derivedId);
      if (!remaining) {
        this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(derivedId);
        this.db.prepare("DELETE FROM memory_fts_registry WHERE memory_id = ?").run(derivedId);
        this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(derivedId);
        this.db.prepare("DELETE FROM memory_index_delta WHERE memory_id = ?").run(derivedId);
        this.db.prepare("DELETE FROM memory_evidence_links WHERE memory_id = ?").run(derivedId);
        this.db.prepare("DELETE FROM memory_leaf_members WHERE memory_id = ?").run(derivedId);
        this.db.prepare("UPDATE memory_records SET status = 'deleted' WHERE id = ?").run(derivedId);
        for (const key of this.vectorCaches.keys()) {
          this.vectorCaches.get(key)?.remove(derivedId);
        }
        this.cascadeDerivedMemories(derivedId);
      }
    }
  }
  recordPerfAggregates(timings: PerfSnapshot | undefined): void {
    if (!timings) return;
    const createdAt = new Date().toISOString();
    const read = this.db.prepare(`SELECT buckets_json FROM perf_aggregates WHERE section = ?`);
    const upsert = this.db.prepare(
      `INSERT INTO perf_aggregates (section, count, sum, sum_sq, buckets_json, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(section) DO UPDATE SET
         count = count + 1,
         sum = sum + excluded.sum,
         sum_sq = sum_sq + excluded.sum_sq,
         buckets_json = excluded.buckets_json,
         updated_at = excluded.updated_at`,
    );
    for (const [section, ms] of Object.entries(timings.timings)) {
      const previous = read.get(section) as Row | undefined;
      const buckets = histogramAdd(parseNumberArray(previous?.buckets_json ?? null), ms);
      upsert.run(section, ms, ms * ms, JSON.stringify(buckets), createdAt);
    }
    if (timings.totalMs > 0) {
      const previous = read.get("total") as Row | undefined;
      const buckets = histogramAdd(
        parseNumberArray(previous?.buckets_json ?? null),
        timings.totalMs,
      );
      upsert.run(
        "total",
        timings.totalMs,
        timings.totalMs ** 2,
        JSON.stringify(buckets),
        createdAt,
      );
    }
  }
  recordActiveGraphUseInner(
    activeGraphId: string,
    input: {
      usedMemoryIds: readonly string[];
      contradictedMemoryIds?: readonly string[];
      rejectedMemoryIds?: readonly string[];
    },
    sessionId?: string,
  ): void {
    const row = this.db
      .prepare("SELECT * FROM retrieval_traces WHERE id = ?")
      .get(activeGraphId) as Row | undefined;
    if (!row) throw new Error(`active graph ${activeGraphId} does not exist`);
    this.assertTraceOwner(row, sessionId);
    const resultMemoryIds = new Set(parseStringArray(row.result_memory_ids_json));
    const observedUsedMemoryIds = [...new Set(input.usedMemoryIds)].filter((id) =>
      resultMemoryIds.has(id),
    );
    const observedContradictedMemoryIds = [...new Set(input.contradictedMemoryIds ?? [])].filter(
      (id) => resultMemoryIds.has(id),
    );
    const observedRejectedMemoryIds = [...new Set(input.rejectedMemoryIds ?? [])].filter((id) =>
      resultMemoryIds.has(id),
    );
    const usedMemoryIds = [
      ...new Set([...parseStringArray(row.useful_memory_ids_json), ...observedUsedMemoryIds]),
    ];
    const contradictedMemoryIds = [
      ...new Set([
        ...parseStringArray(row.contradicted_memory_ids_json),
        ...observedContradictedMemoryIds,
      ]),
    ];
    const rejectedMemoryIds = [
      ...new Set([...parseStringArray(row.rejected_memory_ids_json), ...observedRejectedMemoryIds]),
    ];
    const usedNodeIds = new Set(this.nodeIdsForMemories(usedMemoryIds));
    const contradictedNodeIds = new Set(this.nodeIdsForMemories(contradictedMemoryIds));
    const observedUsedNodeIds = new Set(this.nodeIdsForMemories(observedUsedMemoryIds));
    const observedContradictedNodeIds = new Set(
      this.nodeIdsForMemories(observedContradictedMemoryIds),
    );
    const observedRejectedNodeIds = new Set(this.nodeIdsForMemories(observedRejectedMemoryIds));
    const resultNodeIds = parseStringArray(row.result_node_ids_json).sort();
    const relationIds = parseStringArray(row.relation_ids_json);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE retrieval_traces SET useful_memory_ids_json = ?,
           contradicted_memory_ids_json = ?, rejected_memory_ids_json = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(usedMemoryIds),
          JSON.stringify(contradictedMemoryIds),
          JSON.stringify(rejectedMemoryIds),
          activeGraphId,
        );
      this.recordNodeOutcomes(
        observedUsedNodeIds,
        observedContradictedNodeIds,
        observedRejectedNodeIds,
        now,
      );
      this.recordEdgeOutcomes(
        relationIds,
        observedUsedNodeIds,
        observedContradictedNodeIds,
        observedRejectedNodeIds,
        now,
      );
      const taskId = String(row.task_id) || stableTaskId(String(row.query));
      for (let left = 0; left < resultNodeIds.length; left += 1) {
        for (let right = left + 1; right < resultNodeIds.length; right += 1) {
          const pair = [resultNodeIds[left]!, resultNodeIds[right]!] as const;
          this.db
            .prepare(
              `UPDATE edge_task_observations
               SET useful = MAX(useful, ?), contradicted = MAX(contradicted, ?)
               WHERE left_node_id = ? AND right_node_id = ? AND task_id = ?`,
            )
            .run(
              usedNodeIds.has(pair[0]) && usedNodeIds.has(pair[1]) ? 1 : 0,
              contradictedNodeIds.has(pair[0]) || contradictedNodeIds.has(pair[1]) ? 1 : 0,
              ...pair,
              taskId,
            );
          this.refreshPairUsefulness(pair[0], pair[1]);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordUsage(observedUsedMemoryIds);
    if (usedNodeIds.size > 0) this.trainRouter(String(row.query), [...usedNodeIds]);
  }
  protected assertTraceOwner(row: Row, sessionId?: string): void {
    const owner = row.session_id === null || row.session_id === undefined
      ? null
      : String(row.session_id);
    if (owner !== null && owner !== sessionId?.trim()) {
      throw new Error(`active graph ${String(row.id)} belongs to another session`);
    }
  }
  embeddingDocuments(afterMemoryId = "", limit = 256, missingModel?: string): EmbeddingDocument[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.statement, n.canonical_name, n.summary
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.id > ?
         AND m.storage_state = 'indexed'
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = ?
         ))
       ORDER BY m.id LIMIT ?`,
      )
      .all(
        afterMemoryId,
        missingModel ?? null,
        missingModel ?? null,
        Math.max(1, Math.min(limit, 2_048)),
      ) as Row[];
    return rows.map((row) => ({
      memoryId: String(row.id),
      text: memoryEmbeddingText(row.statement, row.canonical_name),
    }));
  }
  nodeEmbeddingDocuments(
    afterNodeId = "",
    limit = 256,
    missingModel?: string,
  ): NodeEmbeddingDocument[] {
    const rows = this.db
      .prepare(
        `SELECT n.id, n.canonical_name, n.kind, n.summary
       FROM memory_nodes n
       WHERE n.id > ? AND n.status = 'active'
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM node_embeddings e WHERE e.node_id = n.id AND e.model = ?
             AND e.updated_at >= n.updated_at
         ))
       ORDER BY n.id LIMIT ?`,
      )
      .all(
        afterNodeId,
        missingModel ?? null,
        missingModel ?? null,
        Math.max(1, Math.min(limit, 2_048)),
      ) as Row[];
    return rows.map((row) => ({
      nodeId: String(row.id),
      text: `${row.canonical_name} ${row.kind} ${row.summary}`,
    }));
  }
  upsertExternalNodeEmbeddings(model: string, embeddings: ExternalNodeEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.db.prepare(
      `INSERT INTO node_embeddings
        (node_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of embeddings) {
        upsert.run(
          item.nodeId,
          model,
          dimensions,
          JSON.stringify(item.vector),
          encodeVector(item.vector),
          now,
        );
      }
      this.db.exec("COMMIT");
      for (const item of embeddings) {
        this.updateVectorCache("node", model, item.nodeId, item.vector);
      }
      return embeddings.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  storedNodeEmbeddings(model: string, afterNodeId = "", limit = 256): ExternalNodeEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT node_id, vector_blob, vector_json FROM node_embeddings
       WHERE model = ? AND node_id > ? ORDER BY node_id LIMIT ?`,
      )
      .all(model, afterNodeId, Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      nodeId: String(row.node_id),
      vector: storedVector(row),
    }));
  }
  leafEmbeddingDocuments(
    afterBlockId = "",
    limit = 256,
    missingModel?: string,
  ): LeafEmbeddingDocument[] {
    const rows = this.db
      .prepare(
        `SELECT b.id, b.node_id, b.summary, n.canonical_name, n.summary AS node_summary
       FROM memory_leaf_blocks b JOIN memory_nodes n ON n.id = b.node_id
       WHERE b.id > ?
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM leaf_embeddings e WHERE e.block_id = b.id AND e.model = ?
             AND e.updated_at >= b.updated_at
         ))
       ORDER BY b.id LIMIT ?`,
      )
      .all(
        afterBlockId,
        missingModel ?? null,
        missingModel ?? null,
        Math.max(1, Math.min(limit, 2_048)),
      ) as Row[];
    return rows.map((row) => ({
      blockId: String(row.id),
      nodeId: String(row.node_id),
      text: `${row.canonical_name}: ${row.summary}`,
    }));
  }
  upsertExternalLeafEmbeddings(model: string, embeddings: ExternalLeafEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.db.prepare(
      `INSERT INTO leaf_embeddings
        (block_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(block_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of embeddings) {
        upsert.run(
          item.blockId,
          model,
          dimensions,
          JSON.stringify(item.vector),
          encodeVector(item.vector),
          now,
        );
      }
      this.db.exec("COMMIT");
      for (const item of embeddings) {
        this.updateVectorCache("leaf", model, item.blockId, item.vector);
      }
      return embeddings.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  storedLeafEmbeddings(model: string, afterBlockId = "", limit = 256): ExternalLeafEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT block_id, vector_blob, vector_json FROM leaf_embeddings
       WHERE model = ? AND block_id > ? ORDER BY block_id LIMIT ?`,
      )
      .all(model, afterBlockId, Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      blockId: String(row.block_id),
      vector: storedVector(row),
    }));
  }
  routeLeafBlocksByVector(
    queryVector: readonly number[],
    model: string,
    nodeIds: string[] = [],
    limit = 8,
    candidateBlockIds: string[] = [],
  ): Array<{ block: LeafBlock; score: number }> {
    const nodes = [...new Set(nodeIds)].slice(0, 50);
    const blocks = [...new Set(candidateBlockIds)].slice(0, 2_000);
    const nodeClause =
      nodes.length > 0 ? `AND b.node_id IN (${nodes.map(() => "?").join(",")})` : "";
    const blockClause = blocks.length > 0 ? `AND b.id IN (${blocks.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(
        `SELECT b.* FROM memory_leaf_blocks b
       JOIN memory_nodes n ON n.id = b.node_id AND n.status = 'active'
       JOIN leaf_embeddings e ON e.block_id = b.id AND e.model = ?
       WHERE 1 = 1 ${nodeClause} ${blockClause}`,
      )
      .all(model, ...nodes, ...blocks) as Row[];
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const cache = this.embeddingCache("leaf", model);
    if (!cache) return [];
    return cache
      .score(queryVector, new Set(byId.keys()))
      .map(({ id, score }) => ({ block: mapLeafBlock(byId.get(id)!), score }))
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }
  upsertExternalEmbeddings(model: string, embeddings: ExternalEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.db.prepare(
      `INSERT INTO memory_embeddings
        (memory_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of embeddings) {
        upsert.run(
          item.memoryId,
          model,
          dimensions,
          JSON.stringify(item.vector),
          encodeVector(item.vector),
          now,
        );
      }
      this.db.exec("COMMIT");
      return embeddings.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  storedEmbeddings(model: string, afterMemoryId = "", limit = 256): ExternalEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT memory_id, vector_blob, vector_json FROM memory_embeddings
       WHERE model = ? AND memory_id > ? ORDER BY memory_id LIMIT ?`,
      )
      .all(model, afterMemoryId, Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      memoryId: String(row.memory_id),
      vector: storedVector(row),
    }));
  }
  searchWithVector(
    query: string,
    queryVector: readonly number[],
    vectorModel: string,
    options: SearchOptions,
    forcedCandidateIds: string[] = [],
    filterUsage?: RetrievalFilterUsage,
  ): MemorySearchResult[] {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return [];

    const maxTier = options.maxTier ?? 1;
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const nodeName = options.nodeName ? this.resolveActiveNodeName(options.nodeName) : null;
    const retrievalMode = options.retrievalMode ?? "legacy";
    const ftsIds =
      retrievalMode === "fts5" || retrievalMode === "hybrid"
        ? this.ftsCandidates(query, MAX_SEARCH_CANDIDATES)
        : [];
    if (retrievalMode === "fts5" && ftsIds.length === 0 && forcedCandidateIds.length === 0) {
      return [];
    }
    const candidateIds = forcedCandidateIds.length > 0 ? forcedCandidateIds : ftsIds;
    const candidateClause =
      forcedCandidateIds.length > 0
        ? `AND m.id IN (${forcedCandidateIds.map(() => "?").join(",")})`
        : retrievalMode === "qwen3"
          ? "AND ve.vector_json IS NOT NULL"
          : retrievalMode === "fts5"
            ? `AND m.id IN (${ftsIds.map(() => "?").join(",")})`
            : retrievalMode === "hybrid" && ftsIds.length > 0
              ? `AND (m.id IN (${ftsIds.map(() => "?").join(",")}) OR m.id IN (
           SELECT id FROM memory_records ORDER BY tier ASC, importance DESC,
             access_count DESC, created_at DESC LIMIT ${MAX_SEARCH_CANDIDATES}
         ))`
              : "";
    const candidateOrder =
      forcedCandidateIds.length === 0 && retrievalMode === "hybrid" && ftsIds.length > 0
        ? `CASE WHEN m.id IN (${ftsIds.map(() => "?").join(",")}) THEN 0 ELSE 1 END,`
        : "";
    const rowLimit =
      forcedCandidateIds.length > 0
        ? forcedCandidateIds.length
        : retrievalMode === "qwen3"
          ? 1_000_000
          : retrievalMode === "fts5"
            ? ftsIds.length
            : MAX_SEARCH_CANDIDATES + ftsIds.length;
    // Scope filtering is pushed into SQL so scoring runs only on matching
    // rows (filter-then-score, not score-then-filter). One json_extract per
    // requested scope key; keys are emitted as quoted path segments
    // ($."key" — safe for dots and other JSON-legal key characters), values
    // parameterized — no injection surface.
    const scopeEntries = Object.entries(options.scope ?? {});
    const scopeClause =
      scopeEntries.length > 0
        ? `AND ${scopeEntries
            .map(([key]) => `json_extract(m.scope_json, '$."${key.replace(/["\\]/g, "")}"') = ?`)
            .join(" AND ")}`
        : "";
    const scopeParams = scopeEntries.map(([, value]) => value);
    const rows = this.db
      .prepare(
        `SELECT
           m.id AS m_id, m.node_id AS m_node_id,
           m.evidence_id AS m_evidence_id, m.statement AS m_statement,
           m.memory_type AS m_memory_type, m.state_key AS m_state_key,
           m.event_time AS m_event_time, m.source_actor AS m_source_actor,
           m.truth_status AS m_truth_status,
           m.confidence AS m_confidence,
           m.polarity AS m_polarity,
           m.predicate_key AS m_predicate_key, m.extract_method AS m_extract_method, m.claims_json AS m_claims_json,
           m.markers_json AS m_markers_json,
           m.scope_json AS m_scope_json, m.valid_from AS m_valid_from,
           m.valid_until AS m_valid_until, m.status AS m_status,
           m.residence AS m_residence, m.promoted_at AS m_promoted_at,
           m.expires_at AS m_expires_at,
           m.evidence_role AS m_evidence_role,
           m.supersedes_id AS m_supersedes_id,
           m.tier AS m_tier, m.importance AS m_importance,
           m.access_count AS m_access_count,
           m.last_accessed_at AS m_last_accessed_at,
           m.write_reason AS m_write_reason,
           m.write_source AS m_write_source,
           m.created_at AS m_created_at,
           n.id AS n_id, n.canonical_name AS n_canonical_name,
           n.kind AS n_kind, n.summary AS n_summary,
           n.created_at AS n_created_at, n.updated_at AS n_updated_at,
           n.status AS n_status, n.residence AS n_residence,
           ve.vector_json AS ve_vector_json,
           ve.vector_blob AS ve_vector_blob,
           h.id AS h_id, h.session_id AS h_session_id, h.role AS h_role,
           h.content AS h_content, h.source_message_id AS h_source_message_id,
           h.source_ref AS h_source_ref,
           h.created_at AS h_created_at
         FROM memory_records m
         JOIN memory_nodes n ON n.id = m.node_id
         JOIN history_records h ON h.id = m.evidence_id
         LEFT JOIN memory_embeddings ve ON ve.memory_id = m.id AND ve.model = ?
         WHERE m.tier <= ?
           AND m.storage_state = 'indexed'
           ${candidateClause}
           AND n.status = 'active'
           AND (? IS NULL OR n.canonical_name = ?)
           AND (? IS NULL OR m.source_actor = ?)
           AND (? = 1 OR m.status IN ('active', 'disputed'))
           AND (m.expires_at IS NULL OR m.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           ${scopeClause}
         ORDER BY ${candidateOrder} m.tier ASC, m.importance DESC,
                  m.access_count DESC, m.created_at DESC
         LIMIT ?`,
      )
      .all(
        vectorModel,
        maxTier,
        ...candidateIds,
        nodeName,
        nodeName,
        options.sourceActor ?? null,
        options.sourceActor ?? null,
        options.includeHistorical ? 1 : 0,
        ...(forcedCandidateIds.length === 0 && retrievalMode === "hybrid" ? ftsIds : []),
        ...scopeParams,
        rowLimit,
      ) as Row[];

    const routes =
      retrievalMode === "fts5" || retrievalMode === "hashing" || retrievalMode === "qwen3"
        ? new Map<string, number>()
        : new Map(this.routeNodes(query, 20).map((route) => [route.node.id, route.score]));
    const filtered = rows
      .map((row) => {
        const lexical = lexicalScore(normalizedQuery, row);
        const vector = cosineSimilarity(queryVector, storedVector(row, "ve_"));
        const route = routes.get(String(row.m_node_id)) ?? 0;
        const result = mapSearchResult(row, lexical);
        result.vectorScore = retrievalMode === "fts5" ? 0 : vector;
        result.routeScore = route;
        result.combinedScore =
          retrievalMode === "fts5"
            ? lexical > 0
              ? lexical
              : forcedCandidateIds.length > 0
                ? 0.001
                : 0
            : retrievalMode === "hashing" || retrievalMode === "qwen3"
              ? vector
              : hybridScore(lexical, vector, route);
        return result;
      })
      .filter((result) => matchesScope(result.memory.scope, options.scope))
      .filter((result) => result.combinedScore > 0)
      .sort(
        (left, right) =>
          right.combinedScore - left.combinedScore ||
          left.memory.tier - right.memory.tier ||
          right.memory.importance - left.memory.importance,
      );
    if (filterUsage) {
      // Measure before LIMIT: after = what survived scope+score filtering, not
      // what the limit truncated to.
      filterUsage.candidatesBefore = rows.length;
      filterUsage.candidatesAfter = filtered.length;
      filterUsage.selectivity = rows.length > 0 ? 1 - filtered.length / rows.length : 0;
    }
    const results = filtered.slice(0, limit);
    for (const result of results) {
      result.memory.evidenceIds = this.evidenceIds(result.memory.id);
      result.evidenceRecords = this.evidenceRecords(result.memory.evidenceIds);
    }
    return results;
  }
  requireActiveMemory(memoryId: string): MemoryRecord {
    const row = this.db.prepare("SELECT node_id FROM memory_records WHERE id = ?").get(memoryId) as
      Row | undefined;
    if (!row) throw new Error(`memory ${memoryId} does not exist`);
    const result = this.resultsForNode(String(row.node_id), 3, 1, memoryId)[0];
    if (!result) throw new Error(`memory ${memoryId} is not active`);
    return result.memory;
  }
  refreshNodeResidence(nodeId: string, updatedAt: string): void {
    const hasLongTermMemory = this.db
      .prepare(
        `SELECT 1 FROM memory_records
         WHERE node_id = ? AND residence = 'ltg'
           AND status IN ('active', 'disputed') LIMIT 1`,
      )
      .get(nodeId);
    const hasLongTermRelation = this.db
      .prepare(
        `SELECT 1 FROM node_relations
         WHERE status = 'consolidated'
           AND (source_node_id = ? OR target_node_id = ?) LIMIT 1`,
      )
      .get(nodeId, nodeId);
    this.db
      .prepare("UPDATE memory_nodes SET residence = ?, updated_at = ? WHERE id = ?")
      .run(hasLongTermMemory || hasLongTermRelation ? "ltg" : "stg", updatedAt, nodeId);
  }
  recordNodeSelections(nodeIds: string[], expandedNodeIds: string[], updatedAt: string): void {
    const selected = new Set(nodeIds);
    const expanded = new Set(expandedNodeIds);
    const upsert = this.db.prepare(
      `INSERT INTO node_activation_signals
        (node_id, selected_count, expanded_count, used_count,
         contradicted_count, rejected_count, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         selected_count = selected_count + excluded.selected_count,
         expanded_count = expanded_count + excluded.expanded_count,
         updated_at = excluded.updated_at`,
    );
    for (const nodeId of new Set([...selected, ...expanded])) {
      upsert.run(nodeId, selected.has(nodeId) ? 1 : 0, expanded.has(nodeId) ? 1 : 0, updatedAt);
    }
  }
  recordEdgeSelections(relationIds: readonly string[], updatedAt: string): void {
    const upsert = this.db.prepare(
      `INSERT INTO edge_activation_signals
        (relation_id, selected_count, used_count, contradicted_count,
         rejected_count, updated_at)
       VALUES (?, 1, 0, 0, 0, ?)
       ON CONFLICT(relation_id) DO UPDATE SET
         selected_count = selected_count + 1,
         updated_at = excluded.updated_at`,
    );
    for (const relationId of new Set(relationIds)) upsert.run(relationId, updatedAt);
  }
  recordNodeOutcomes(
    used: Set<string>,
    contradicted: Set<string>,
    rejected: Set<string>,
    updatedAt: string,
  ): void {
    const upsert = this.db.prepare(
      `INSERT INTO node_activation_signals
        (node_id, selected_count, expanded_count, used_count,
         contradicted_count, rejected_count, updated_at)
       VALUES (?, 0, 0, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         used_count = used_count + excluded.used_count,
         contradicted_count = contradicted_count + excluded.contradicted_count,
         rejected_count = rejected_count + excluded.rejected_count,
         updated_at = excluded.updated_at`,
    );
    for (const nodeId of new Set([...used, ...contradicted, ...rejected])) {
      upsert.run(
        nodeId,
        used.has(nodeId) ? 1 : 0,
        contradicted.has(nodeId) ? 1 : 0,
        rejected.has(nodeId) ? 1 : 0,
        updatedAt,
      );
    }
  }
  recordEdgeOutcomes(
    relationIds: readonly string[],
    used: Set<string>,
    contradicted: Set<string>,
    rejected: Set<string>,
    updatedAt: string,
  ): void {
    const find = this.db.prepare("SELECT * FROM node_relations WHERE id = ?");
    const rows = [...new Set(relationIds)]
      .map((relationId) => find.get(relationId) as Row | undefined)
      .filter((row): row is Row => Boolean(row));
    const totalPrediction = Math.min(
      1,
      rows.reduce((total, row) => total + Number(row.strength ?? 0.5), 0),
    );
    const updateStrength = this.db.prepare("UPDATE node_relations SET strength = ? WHERE id = ?");
    const upsert = this.db.prepare(
      `INSERT INTO edge_activation_signals
        (relation_id, selected_count, used_count, contradicted_count,
         rejected_count, updated_at)
       VALUES (?, 0, ?, ?, ?, ?)
       ON CONFLICT(relation_id) DO UPDATE SET
         used_count = used_count + excluded.used_count,
         contradicted_count = contradicted_count + excluded.contradicted_count,
         rejected_count = rejected_count + excluded.rejected_count,
         updated_at = excluded.updated_at`,
    );
    for (const row of rows) {
      const relation = mapRelation(row);
      const relationId = relation.id;
      const endpoints = [relation.sourceNodeId, relation.targetNodeId];
      const usedTogether = endpoints.every((nodeId) => used.has(nodeId));
      const negative = endpoints.some(
        (nodeId) => contradicted.has(nodeId) || rejected.has(nodeId),
      );
      upsert.run(
        relationId,
        usedTogether ? 1 : 0,
        endpoints.some((nodeId) => contradicted.has(nodeId)) ? 1 : 0,
        endpoints.some((nodeId) => rejected.has(nodeId)) ? 1 : 0,
        updatedAt,
      );
      if (usedTogether || negative) {
        updateStrength.run(
          updateRelationStrength(
            relation.strength,
            usedTogether && !negative ? 1 : 0,
            totalPrediction,
            1,
          ),
          relationId,
        );
      }
    }
  }
  refreshPairUsefulness(leftNodeId: string, rightNodeId: string): void {
    this.db
      .prepare(
        `UPDATE node_pair_signals SET useful_count = (
           SELECT COUNT(*) FROM edge_task_observations
           WHERE left_node_id = ? AND right_node_id = ? AND useful = 1
         ) WHERE left_node_id = ? AND right_node_id = ?`,
      )
      .run(leftNodeId, rightNodeId, leftNodeId, rightNodeId);
  }
  edgeEvidenceTraceIds(leftNodeId: string, rightNodeId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT trace_id FROM edge_task_observations
           WHERE left_node_id = ? AND right_node_id = ? AND useful = 1
           ORDER BY created_at DESC LIMIT 32`,
        )
        .all(leftNodeId, rightNodeId) as Row[]
    ).map((row) => String(row.trace_id));
  }
  recordMemoryWriteEvent(input: Omit<MemoryWriteEvent, "createdAt" | "id">): MemoryWriteEvent {
    const event: MemoryWriteEvent = {
      id: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO memory_write_events
          (id, memory_id, history_id, session_id, decision, policy_reason,
           write_reason, write_source, memory_type, requested_residence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.memoryId,
        event.historyId,
        event.sessionId,
        event.decision,
        event.policyReason,
        event.writeReason,
        event.writeSource,
        event.memoryType,
        event.requestedResidence,
        event.createdAt,
      );
    return event;
  }
  requireConsolidationEvent(id: string): ConsolidationEvent {
    const row = this.db.prepare("SELECT * FROM consolidation_events WHERE id = ?").get(id) as
      Row | undefined;
    if (!row) throw new Error(`consolidation event ${id} does not exist`);
    return mapConsolidationEvent(row);
  }
  consolidationCoolingDown(targetId: string, cooldownMs: number): boolean {
    const row = this.db
      .prepare(
        `SELECT created_at FROM consolidation_events
         WHERE target_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(targetId) as Row | undefined;
    return Boolean(row) && Date.now() - Date.parse(String(row!.created_at)) < cooldownMs;
  }
  requireHistory(historyId: string): HistoryRecord {
    const row = this.db.prepare("SELECT * FROM history_records WHERE id = ?").get(historyId) as
      Row | undefined;
    if (!row) throw new Error(`history ${historyId} does not exist`);
    return mapHistory(row);
  }
  upsertFts(memoryId: string, statement: string, nodeId: string, evidenceId: string): void {
    const node = this.requireNode(nodeId);
    const evidence = this.requireHistory(evidenceId);
    this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
    this.db
      .prepare(
        "INSERT INTO memory_fts(memory_id, statement, node_name, evidence) VALUES (?, ?, ?, ?)",
      )
      .run(memoryId, statement, node.canonicalName, evidence.content);
    this.db
      .prepare("INSERT OR IGNORE INTO memory_fts_registry(memory_id) VALUES (?)")
      .run(memoryId);
  }
  ftsCandidates(query: string, limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression) return [];
    const rows = this.db
      .prepare(
        "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?",
      )
      .all(expression, limit) as Row[];
    return rows.map((row) => String(row.memory_id));
  }
  ftsCandidatesInNodes(query: string, nodeIds: string[], limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression || nodeIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT f.memory_id FROM memory_fts f
       JOIN memory_records m ON m.id = f.memory_id
       WHERE memory_fts MATCH ? AND m.node_id IN (${nodeIds.map(() => "?").join(",")})
       ORDER BY bm25(memory_fts) LIMIT ?`,
      )
      .all(expression, ...nodeIds, limit) as Row[];
    return rows.map((row) => String(row.memory_id));
  }
  requireNode(nodeId: string): MemoryNode {
    const row = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(nodeId) as
      Row | undefined;
    if (!row) throw new Error(`node ${nodeId} does not exist`);
    return mapNode(row);
  }
  resolveActiveNodeName(canonicalName: string): string {
    const row = this.db
      .prepare("SELECT * FROM memory_nodes WHERE canonical_name = ?")
      .get(canonicalName) as Row | undefined;
    if (!row) return canonicalName;
    const node = mapNode(row);
    if (node.status === "active") return node.canonicalName;
    const targets = this.db
      .prepare(
        `SELECT DISTINCT n.canonical_name FROM node_redirects r
       JOIN memory_nodes n ON n.id = r.target_node_id
       WHERE r.source_node_id = ? AND n.status = 'active'`,
      )
      .all(node.id) as Row[];
    if (targets.length === 1) return String(targets[0]!.canonical_name);
    if (targets.length > 1) {
      throw new Error(`node ${canonicalName} was split; choose a more specific node`);
    }
    return canonicalName;
  }
  resolveStateKey(requestedKey: string, scope: MemoryScope, node: MemoryNode): string {
    const scopeJson = serializeScope(scope);
    const alias = this.db
      .prepare(
        `SELECT canonical_key FROM state_key_aliases
       WHERE alias_key = ? AND scope_json = ?`,
      )
      .get(requestedKey, scopeJson) as Row | undefined;
    if (alias) return String(alias.canonical_key);

    const exact = this.db
      .prepare(
        `SELECT state_key FROM memory_records
       WHERE memory_type = 'state' AND state_key = ? AND scope_json = ?
         AND status = 'active' LIMIT 1`,
      )
      .get(requestedKey, scopeJson) as Row | undefined;
    if (exact) return requestedKey;

    const candidates = this.db
      .prepare(
        `SELECT m.state_key, n.canonical_name
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.memory_type = 'state' AND m.scope_json = ?
         AND m.status = 'active' AND m.state_key IS NOT NULL`,
      )
      .all(scopeJson) as Row[];
    const requestedIdentity = `${node.canonicalName} ${requestedKey}`;
    const requestedTokens = identityTokens(requestedIdentity);
    const matches = candidates
      .map((candidate) => {
        const identity = `${candidate.canonical_name} ${candidate.state_key}`;
        const candidateTokens = identityTokens(identity);
        const overlap =
          requestedTokens.size === 0
            ? 0
            : [...requestedTokens].filter((token) => candidateTokens.has(token)).length /
              requestedTokens.size;
        return {
          key: String(candidate.state_key),
          score: cosineSimilarity(
            this.embedder.embed(requestedIdentity),
            this.embedder.embed(identity),
          ),
          overlap,
        };
      })
      .filter((candidate) => candidate.score >= 0.65 && candidate.overlap >= 0.7)
      .sort((left, right) => right.score - left.score);
    if (matches.length === 0) return requestedKey;

    const canonicalKey = matches[0]!.key;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO state_key_aliases
        (alias_key, scope_json, canonical_key, created_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(requestedKey, scopeJson, canonicalKey, new Date().toISOString());
    return canonicalKey;
  }
  memoryIdsForNodes(nodeIds: string[]): string[] {
    const select = this.db.prepare("SELECT id FROM memory_records WHERE node_id = ?");
    return nodeIds.flatMap((nodeId) => (select.all(nodeId) as Row[]).map((row) => String(row.id)));
  }
  createTransform(
    type: NodeTransform["type"],
    sourceNodeIds: string[],
    targetNodeIds: string[],
    movedMemoryIds: string[],
  ): NodeTransform {
    const transform: NodeTransform = {
      id: randomUUID(),
      type,
      sourceNodeIds,
      targetNodeIds,
      movedMemoryIds,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO node_transforms
        (id, transform_type, source_node_ids_json, target_node_ids_json,
         moved_memory_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transform.id,
        transform.type,
        JSON.stringify(transform.sourceNodeIds),
        JSON.stringify(transform.targetNodeIds),
        JSON.stringify(transform.movedMemoryIds),
        transform.createdAt,
      );
    return transform;
  }
  redirectRelations(sourceNodeId: string, targetNodeId: string): void {
    const rows = this.db
      .prepare(
        `SELECT * FROM node_relations
       WHERE source_node_id = ? OR target_node_id = ?`,
      )
      .all(sourceNodeId, sourceNodeId) as Row[];
    const remove = this.db.prepare("DELETE FROM node_relations WHERE id = ?");
    for (const row of rows) {
      const relation = mapRelation(row);
      remove.run(relation.id);
      const nextSource =
        relation.sourceNodeId === sourceNodeId ? targetNodeId : relation.sourceNodeId;
      const nextTarget =
        relation.targetNodeId === sourceNodeId ? targetNodeId : relation.targetNodeId;
      if (nextSource !== nextTarget) {
        this.linkNodes({
          sourceNodeId: nextSource,
          targetNodeId: nextTarget,
          type: relation.type,
          evidenceIds: relation.evidenceIds,
        });
      }
    }
  }
  memoryText(memory: Pick<MemoryRecord, "statement">, nodeId: string): string {
    const node = this.requireNode(nodeId);
    return memoryEmbeddingText(memory.statement, node.canonicalName);
  }
  upsertEmbedding(memoryId: string, text: string): void {
    const vector = this.embedder.embed(text);
    this.db
      .prepare(
        `INSERT INTO memory_embeddings
        (memory_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET
         dimensions = excluded.dimensions, vector_json = excluded.vector_json,
         vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
      )
      .run(
        memoryId,
        this.embedder.model,
        this.embedder.dimensions,
        JSON.stringify(vector),
        encodeVector(vector),
        new Date().toISOString(),
      );
  }
  refreshEmbeddings(memoryIds: string[]): void {
    const select = this.db.prepare(
      `SELECT m.id, m.statement, m.node_id, n.canonical_name, n.summary
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id WHERE m.id = ?`,
    );
    for (const memoryId of memoryIds) {
      const row = select.get(memoryId) as Row | undefined;
      if (row)
        this.upsertEmbedding(memoryId, memoryEmbeddingText(row.statement, row.canonical_name));
    }
  }
  nodeIdsForMemories(memoryIds: readonly string[]): string[] {
    const ids = [...new Set(memoryIds)];
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT DISTINCT node_id FROM memory_records
       WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids) as Row[]
    ).map((row) => String(row.node_id));
  }
  proposalCoolingDown(proposalKey: string, cooldownMs: number): boolean {
    const row = this.db
      .prepare(
        `SELECT created_at FROM topology_proposals
       WHERE proposal_key = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(proposalKey) as Row | undefined;
    return Boolean(row) && Date.now() - Date.parse(String(row!.created_at)) < cooldownMs;
  }
  candidatePartitions(nodeId: string): Array<{ label: string; memoryIds: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT id, memory_type, scope_json FROM memory_records
       WHERE node_id = ?
       ORDER BY memory_type, scope_json, id`,
      )
      .all(nodeId) as Row[];
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const key = `${row.memory_type}|${row.scope_json}`;
      const group = groups.get(key) ?? [];
      group.push(String(row.id));
      groups.set(key, group);
    }
    return [...groups].map(([label, memoryIds]) => ({ label, memoryIds }));
  }
  insertTopologyProposal(
    proposal: Omit<TopologyProposal, "createdAt" | "id" | "status">,
  ): TopologyProposal {
    const result: TopologyProposal = {
      ...proposal,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO topology_proposals
        (id, proposal_key, proposal_type, source_node_ids_json, relation_type,
         partitions_json, evidence_trace_ids_json, observations,
         estimated_gain, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        result.proposalKey,
        result.type,
        JSON.stringify(result.sourceNodeIds),
        result.relationType,
        JSON.stringify(result.partitions),
        JSON.stringify(result.evidenceTraceIds),
        result.observations,
        result.estimatedGain,
        result.status,
        result.createdAt,
      );
    return result;
  }
  embeddingCache(kind: "leaf" | "node", model: string): Float32VectorCache | null {
    const key = `${kind}:${model}`;
    const existing = this.vectorCaches.get(key);
    if (existing) return existing;
    const table = kind === "node" ? "node_embeddings" : "leaf_embeddings";
    const idColumn = kind === "node" ? "node_id" : "block_id";
    const rows = this.db
      .prepare(
        `SELECT ${idColumn} AS id, dimensions, vector_blob, vector_json
       FROM ${table} WHERE model = ? ORDER BY ${idColumn}`,
      )
      .all(model) as Row[];
    if (rows.length === 0) return null;
    const dimensions = Number(rows[0]!.dimensions);
    const cache = new Float32VectorCache(dimensions, rows.length);
    for (const row of rows) cache.upsert(String(row.id), storedVector(row));
    this.vectorCaches.set(key, cache);
    return cache;
  }
  updateVectorCache(
    kind: "leaf" | "node",
    model: string,
    id: string,
    vector: readonly number[],
  ): void {
    this.vectorCaches.get(`${kind}:${model}`)?.upsert(id, vector);
  }
  invalidateVectorCaches(kind: "leaf" | "node"): void {
    for (const key of this.vectorCaches.keys()) {
      if (key.startsWith(`${kind}:`)) this.vectorCaches.delete(key);
    }
  }
  markIndexDelta(
    memoryId: string,
    nodeId: string,
    operation: "move" | "upsert",
    createdAt = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_index_delta
        (memory_id, node_id, operation, compacted, created_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(memory_id) DO UPDATE SET node_id = excluded.node_id,
         operation = excluded.operation, compacted = 0,
         created_at = excluded.created_at`,
      )
      .run(memoryId, nodeId, operation, createdAt);
    this.db
      .prepare(
        `INSERT INTO leaf_block_status (node_id, dirty, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
      )
      .run(nodeId, createdAt);
  }
  evidenceIds(memoryId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT history_id FROM memory_evidence_links
         WHERE memory_id = ? ORDER BY history_id`,
        )
        .all(memoryId) as Row[]
    ).map((row) => String(row.history_id));
  }
  resultsForNode(
    nodeId: string,
    maxTier: MemoryTier,
    limit: number,
    memoryId?: string,
    sourceActor?: MemoryActor,
  ): MemorySearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT
         m.id AS m_id, m.node_id AS m_node_id,
         m.evidence_id AS m_evidence_id, m.statement AS m_statement,
         m.memory_type AS m_memory_type, m.state_key AS m_state_key,
         m.event_time AS m_event_time, m.source_actor AS m_source_actor,
         m.truth_status AS m_truth_status,
         m.confidence AS m_confidence,
         m.polarity AS m_polarity,
         m.predicate_key AS m_predicate_key, m.extract_method AS m_extract_method, m.claims_json AS m_claims_json,
         m.markers_json AS m_markers_json,
         m.scope_json AS m_scope_json, m.valid_from AS m_valid_from,
         m.valid_until AS m_valid_until, m.status AS m_status,
         m.residence AS m_residence, m.promoted_at AS m_promoted_at,
         m.expires_at AS m_expires_at,
         m.evidence_role AS m_evidence_role,
         m.supersedes_id AS m_supersedes_id,
         m.tier AS m_tier, m.importance AS m_importance,
         m.access_count AS m_access_count,
         m.last_accessed_at AS m_last_accessed_at,
         m.write_reason AS m_write_reason,
         m.write_source AS m_write_source,
         m.created_at AS m_created_at,
         n.id AS n_id, n.canonical_name AS n_canonical_name,
         n.kind AS n_kind, n.summary AS n_summary,
         n.created_at AS n_created_at, n.updated_at AS n_updated_at,
         n.status AS n_status, n.residence AS n_residence,
         h.id AS h_id, h.session_id AS h_session_id, h.role AS h_role,
         h.content AS h_content, h.source_message_id AS h_source_message_id,
         h.source_ref AS h_source_ref,
         h.created_at AS h_created_at
       FROM memory_records m
       JOIN memory_nodes n ON n.id = m.node_id
       JOIN history_records h ON h.id = m.evidence_id
       WHERE m.node_id = ? AND m.tier <= ? AND n.status = 'active'
         AND (m.storage_state = 'indexed' OR ? IS NOT NULL)
         AND (? IS NULL OR m.id = ?)
         AND (? IS NULL OR m.source_actor = ?)
         AND m.status IN ('active', 'disputed')
         AND (m.expires_at IS NULL OR m.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ORDER BY m.tier ASC, m.importance DESC, m.created_at DESC
       LIMIT ?`,
      )
      .all(
        nodeId,
        maxTier,
        memoryId ?? null,
        memoryId ?? null,
        memoryId ?? null,
        sourceActor ?? null,
        sourceActor ?? null,
        limit,
      ) as Row[];
    return rows.map((row) => {
      const result = mapSearchResult(row, 0);
      result.memory.evidenceIds = this.evidenceIds(result.memory.id);
      result.evidenceRecords = this.evidenceRecords(result.memory.evidenceIds);
      return result;
    });
  }
  evidenceRecords(ids: string[]): HistoryRecord[] {
    const statement = this.db.prepare("SELECT * FROM history_records WHERE id = ?");
    return ids.flatMap((id) => {
      const row = statement.get(id) as Row | undefined;
      return row ? [mapHistory(row)] : [];
    });
  }

  // ── cluster-method stubs ─────────────────────────────────────────
  // Base methods call these; the cluster mixins override them on the
  // assembled NmgStore. Stubs throw if ever reached (mixin absent = bug).

  linkNodes(input: {
    sourceNodeId: string;
    targetNodeId: string;
    type: NodeRelationType;
    evidenceIds?: string[];
    stability?: number;
    consolidationSource?: NodeRelation["consolidationSource"];
  }): NodeRelation {
    void input;
    throw new Error("linkNodes stub: cluster mixin did not override it");
  }

  routeNodes(query: string, limit = 5): NodeRoute[] {
    void query;
    void limit;
    throw new Error("routeNodes stub: cluster mixin did not override it");
  }

  recordUsage(memoryIds: string[]): void {
    void memoryIds;
    throw new Error("recordUsage stub: cluster mixin did not override it");
  }

  trainRouter(query: string, usefulNodeIds: string[], learningRate = 0.2): void {
    void query;
    void usefulNodeIds;
    void learningRate;
    throw new Error("trainRouter stub: cluster mixin did not override it");
  }
}
