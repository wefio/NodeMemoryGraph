import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  ActivationSignal,
  ActiveGraph,
  ActiveGraphBudget,
  ActiveGraphBudgetUsage,
  ActiveGraphSelection,
  ConsolidationEvent,
  ConsolidationResult,
  EdgeStability,
  EmbeddingDocument,
  ExternalEmbedding,
  ExternalLeafEmbedding,
  ExternalNodeEmbedding,
  DeriveMemoryInput,
  EmbeddingIndexHealth,
  HistoryRecord,
  HistoryRole,
  MemoryContext,
  MemoryActor,
  MemoryMarker,
  MemoryNode,
  MemoryNodeKind,
  LeafBlock,
  LeafEmbeddingDocument,
  NodeEmbeddingDocument,
  NodeRoute,
  NodeTransform,
  MemoryRecord,
  MemoryResidence,
  MemoryStorageState,
  MemoryWriteEvent,
  MemorySearchResult,
  MemoryScope,
  MemoryStatus,
  MemoryTier,
  NodeRelation,
  NodeRelationType,
  RememberInput,
  RememberResult,
  RetentionCandidate,
  RetentionPolicy,
  QppTriggerDecision,
  RebalanceResult,
  RetrievalTraceInput,
  RetrievalTrace,
  RecallCue,
  RecallIndex,
  SearchOptions,
  SessionArchive,
  TopologyProposal,
  VectorEmbedder,
} from "./types.ts";
import { blockTiers, huffmanDepths } from "./hierarchy.ts";
import { Router } from "./router.ts";
import { cosineSimilarity, HashingVectorEmbedder } from "./vector.ts";
import { Float32VectorCache } from "./vector-cache.ts";
import { migrate } from "./store/schema.ts";
import { parseStringArray } from "./store/row-parse.ts";
import { encodeVector, parseVector, storedVector } from "./store/vector-codec.ts";
import {
  beginEmbeddingIndex,
  completeEmbeddingIndex,
  embeddingIndexHealth,
  failEmbeddingIndex,
} from "./store/embedding-index.ts";
import { normalizeClaims } from "./claims.ts";
import {
  activeGraphBudget,
  activeGraphBudgetLedger,
  activeGraphExpansions,
  estimateResultTokens,
  expandActiveGraphBudget,
  fibonacciEvidenceBudgets,
  queryAssociationEdges,
  stableTaskId,
} from "./store/active-graph.ts";
import {
  contextUsefulness,
  ftsExpression,
  hierarchyWeight,
  hybridScore,
  lexicalNodeScore,
  lexicalScore,
  memoryEmbeddingText,
  mergeSemanticCandidates,
  normalize,
  recallReason,
  type StoreRow as Row,
} from "./store/search-ranking.ts";
import { qppCandidates, shouldTriggerSecondPass } from "./qpp.ts";

const MAX_SEARCH_CANDIDATES = 500;
export class NmgStore {
  readonly #db: DatabaseSync;
  readonly #embedder: VectorEmbedder;
  readonly #router: Router;
  readonly #vectorCaches = new Map<string, Float32VectorCache>();

  constructor(databasePath: string, embedder: VectorEmbedder = new HashingVectorEmbedder()) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath);
    this.#embedder = embedder;
    this.#router = new Router(embedder);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -64000;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
    `);
    migrate(this.#db);
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Soft-delete a memory and all its dependent artifacts.
   *
   * Marks the memory record as deleted so every existing query filters it out
   * automatically. Removes FTS, embeddings, leaf-block membership, index
   * deltas and vector cache entries so stale data does not leak through
   * alternative lookup paths. History records are left intact: raw evidence
   * is immutable regardless of whether the interpreted memories built on it
   * are retained.
   */
  deleteMemory(memoryId: string): MemoryRecord | null {
    const row = this.#db
      .prepare(
        "SELECT id, node_id, status, statement, memory_type, state_key, event_time, " +
          "source_actor, truth_status, confidence, polarity, predicate_key, extract_method, claims_json, markers_json, scope_json, valid_from, valid_until, " +
          "residence, promoted_at, expires_at, evidence_role, supersedes_id, " +
          "tier, importance, access_count, last_accessed_at, evidence_id, " +
          "write_reason, write_source, created_at " +
          "FROM memory_records WHERE id = ?",
      )
      .get(memoryId) as Row | undefined;
    if (!row) return null;
    const memory: MemoryRecord = {
      id: String(row.id),
      nodeId: String(row.node_id),
      evidenceId: String(row.evidence_id),
      evidenceIds: [String(row.evidence_id)],
      statement: String(row.statement),
      memoryType: String(row.memory_type) as MemoryRecord["memoryType"],
      stateKey: row.state_key ? String(row.state_key) : null,
      eventTime: row.event_time ? String(row.event_time) : null,
      sourceActor: String(row.source_actor) as MemoryRecord["sourceActor"],
      truthStatus: String(row.truth_status) as MemoryRecord["truthStatus"],
      confidence:
        row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
      polarity: row.polarity ? (String(row.polarity) as MemoryRecord["polarity"]) : null,
      predicateKey: row.predicate_key ? String(row.predicate_key) : null,
      extractMethod: row.extract_method
        ? (String(row.extract_method) as MemoryRecord["extractMethod"])
        : null,
      claims: parseClaims(row.claims_json),
      markers: parseMarkers(row.markers_json),
      scope: parseScope(row.scope_json),
      validFrom: row.valid_from ? String(row.valid_from) : null,
      validUntil: row.valid_until ? String(row.valid_until) : null,
      status: String(row.status) as MemoryStatus,
      residence: String(row.residence ?? "ltg") as MemoryResidence,
      promotedAt: row.promoted_at ? String(row.promoted_at) : null,
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      evidenceRole: String(row.evidence_role) as MemoryRecord["evidenceRole"],
      supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
      tier: Number(row.tier) as MemoryTier,
      importance: Number(row.importance),
      accessCount: Number(row.access_count),
      lastAccessedAt: row.last_accessed_at ? String(row.last_accessed_at) : null,
      writeReason: String(row.write_reason ?? "legacy_write"),
      writeSource: String(row.write_source ?? "core") as MemoryRecord["writeSource"],
      createdAt: String(row.created_at),
    };
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE memory_records SET status = 'deleted' WHERE id = ?").run(memoryId);
      this.#db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
      this.#db.prepare("DELETE FROM memory_fts_registry WHERE memory_id = ?").run(memoryId);
      this.#db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
      this.#db.prepare("DELETE FROM memory_index_delta WHERE memory_id = ?").run(memoryId);
      this.#db.prepare("DELETE FROM memory_evidence_links WHERE memory_id = ?").run(memoryId);
      this.#db.prepare("DELETE FROM memory_leaf_members WHERE memory_id = ?").run(memoryId);
      this.#db
        .prepare(
          `INSERT INTO leaf_block_status (node_id, dirty, updated_at)
           VALUES (?, 1, ?)
           ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
        )
        .run(memory.nodeId, now);
      for (const key of this.#vectorCaches.keys()) {
        this.#vectorCaches.get(key)?.remove(memoryId);
      }
      this.#cascadeDerivedMemories(memoryId);
      this.#db.exec("COMMIT");
      return memory;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Move retained LTG content between the indexed tier, the unindexed L4
   * archive, and the recoverable L5 quarantine. STG is session-private and is
   * intentionally outside this long-term retention lifecycle.
   */
  setMemoryStorageState(
    memoryId: string,
    target: MemoryStorageState,
    recoveryDays = 30,
  ): MemoryStorageState {
    const row = this.#db
      .prepare(
        `SELECT id, node_id, evidence_id, statement, residence, storage_state
         FROM memory_records WHERE id = ?`,
      )
      .get(memoryId) as Row | undefined;
    if (!row) throw new Error(`memory ${memoryId} does not exist`);
    if (String(row.residence) !== "ltg") {
      throw new Error("L4/L5 retention applies only to shared LTG memories");
    }
    const current = String(row.storage_state ?? "indexed") as MemoryStorageState;
    if (current === target) return current;
    const now = new Date();
    const quarantineUntil =
      target === "quarantine"
        ? new Date(now.getTime() + Math.max(0, recoveryDays) * 86_400_000).toISOString()
        : null;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `UPDATE memory_records
           SET storage_state = ?, retention_changed_at = ?, quarantine_until = ?
           WHERE id = ?`,
        )
        .run(target, now.toISOString(), quarantineUntil, memoryId);
      if (target === "indexed") {
        this.#upsertFts(
          memoryId,
          String(row.statement),
          String(row.node_id),
          String(row.evidence_id),
        );
        this.#markIndexDelta(memoryId, String(row.node_id), "upsert", now.toISOString());
      } else {
        this.#db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
        this.#db.prepare("DELETE FROM memory_fts_registry WHERE memory_id = ?").run(memoryId);
        this.#db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
        this.#db.prepare("DELETE FROM memory_index_delta WHERE memory_id = ?").run(memoryId);
        this.#db.prepare("DELETE FROM memory_leaf_members WHERE memory_id = ?").run(memoryId);
        this.#db
          .prepare(
            `INSERT INTO leaf_block_status (node_id, dirty, updated_at)
             VALUES (?, 1, ?)
             ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
          )
          .run(row.node_id, now.toISOString());
        for (const cache of this.#vectorCaches.values()) cache.remove(memoryId);
      }
      this.#db.exec("COMMIT");
      return target;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Produce a conservative dry-run report. Callers must explicitly apply the
   * returned transitions; this method never archives or deletes content.
   */
  retentionCandidates(policy: RetentionPolicy = {}): RetentionCandidate[] {
    const now = policy.now ?? new Date();
    const dormantAfterDays = Math.max(1, policy.dormantAfterDays ?? 365);
    const quarantineAfterDays = Math.max(1, policy.quarantineAfterDays ?? 365);
    const maximumImportance = clamp(policy.maximumImportance ?? 0.25, 0, 1);
    const maximumAccessCount = Math.max(0, policy.maximumAccessCount ?? 1);
    const rows = this.#db
      .prepare(
        `SELECT m.id, m.node_id, m.statement, m.memory_type, m.evidence_role,
                m.markers_json, m.storage_state, m.retention_changed_at,
                m.created_at, m.last_accessed_at, m.importance, m.access_count
         FROM memory_records m
         WHERE m.residence = 'ltg'
           AND m.status IN ('active', 'inactive', 'superseded')
           AND m.storage_state IN ('indexed', 'dormant')
           AND m.importance <= ?
           AND m.access_count <= ?
           AND m.memory_type NOT IN ('constraint', 'preference', 'state')
           AND m.evidence_role NOT IN ('contradict', 'exception')
           AND NOT EXISTS (
             SELECT 1 FROM memory_derivations d WHERE d.source_memory_id = m.id
           )`,
      )
      .all(maximumImportance, maximumAccessCount) as Row[];
    return rows.flatMap((row) => {
      const markers = parseMarkers(row.markers_json);
      if (
        markers.some((marker) =>
          ["critical", "pinned", "protected", "safety_constraint", "user_defined"].includes(
            marker.kind,
          ),
        )
      ) {
        return [];
      }
      const storageState = String(row.storage_state) as MemoryStorageState;
      const createdAt = Date.parse(String(row.created_at));
      const lastUsedAt = row.last_accessed_at
        ? Date.parse(String(row.last_accessed_at))
        : createdAt;
      const ageDays = Math.max(0, (now.getTime() - createdAt) / 86_400_000);
      const idleDays = Math.max(0, (now.getTime() - lastUsedAt) / 86_400_000);
      const retentionChangedAt = row.retention_changed_at
        ? Date.parse(String(row.retention_changed_at))
        : createdAt;
      const dormantDays = Math.max(0, (now.getTime() - retentionChangedAt) / 86_400_000);
      const recommendedState =
        storageState === "indexed" && ageDays >= dormantAfterDays && idleDays >= dormantAfterDays
          ? "dormant"
          : storageState === "dormant" && dormantDays >= quarantineAfterDays
            ? "quarantine"
            : null;
      return recommendedState
        ? [
            {
              memoryId: String(row.id),
              nodeId: String(row.node_id),
              statement: String(row.statement),
              storageState,
              recommendedState,
              ageDays,
              idleDays,
              importance: Number(row.importance),
              accessCount: Number(row.access_count),
            },
          ]
        : [];
    });
  }

  #cascadeDerivedMemories(sourceMemoryId: string): void {
    const derivations = this.#db
      .prepare("SELECT derived_memory_id FROM memory_derivations WHERE source_memory_id = ?")
      .all(sourceMemoryId) as Row[];
    this.#db
      .prepare("DELETE FROM memory_derivations WHERE source_memory_id = ?")
      .run(sourceMemoryId);
    for (const row of derivations) {
      const derivedId = String(row.derived_memory_id);
      const remaining = this.#db
        .prepare("SELECT 1 FROM memory_derivations WHERE derived_memory_id = ?")
        .get(derivedId);
      if (!remaining) {
        this.#db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(derivedId);
        this.#db.prepare("DELETE FROM memory_fts_registry WHERE memory_id = ?").run(derivedId);
        this.#db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(derivedId);
        this.#db.prepare("DELETE FROM memory_index_delta WHERE memory_id = ?").run(derivedId);
        this.#db.prepare("DELETE FROM memory_evidence_links WHERE memory_id = ?").run(derivedId);
        this.#db.prepare("DELETE FROM memory_leaf_members WHERE memory_id = ?").run(derivedId);
        this.#db
          .prepare("UPDATE memory_records SET status = 'deleted' WHERE id = ?")
          .run(derivedId);
        for (const key of this.#vectorCaches.keys()) {
          this.#vectorCaches.get(key)?.remove(derivedId);
        }
        this.#cascadeDerivedMemories(derivedId);
      }
    }
  }

  appendHistory(input: {
    content: string;
    role: HistoryRole;
    sessionId?: string;
    sourceMessageId?: string;
    sourceRef?: string;
  }): HistoryRecord {
    const content = requireText(input.content, "history content");
    const sourceMessageId = input.sourceMessageId?.trim() || null;
    if (sourceMessageId) {
      if (!input.sessionId?.trim()) {
        throw new Error("sourceMessageId requires sessionId");
      }
      const existing = this.#db
        .prepare("SELECT * FROM history_records WHERE session_id = ? AND source_message_id = ?")
        .get(input.sessionId, sourceMessageId) as Row | undefined;
      if (existing) {
        const record = mapHistory(existing);
        if (record.content !== content || record.role !== input.role) {
          throw new Error(
            `source message ${sourceMessageId} already exists with different content`,
          );
        }
        return record;
      }
    }
    const record: HistoryRecord = {
      id: randomUUID(),
      sessionId: input.sessionId ?? null,
      sourceMessageId,
      role: input.role,
      content,
      sourceRef: input.sourceRef ?? null,
      createdAt: new Date().toISOString(),
    };

    this.#db
      .prepare(
        `INSERT INTO history_records
          (id, session_id, source_message_id, role, content, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.sourceMessageId,
        record.role,
        record.content,
        record.sourceRef,
        record.createdAt,
      );

    return record;
  }

  getHistoryBySourceMessage(sessionId: string, sourceMessageId: string): HistoryRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM history_records
         WHERE session_id = ? AND source_message_id = ?`,
      )
      .get(
        requireText(sessionId, "session id"),
        requireText(sourceMessageId, "source message id"),
      ) as Row | undefined;
    return row ? mapHistory(row) : null;
  }

  upsertNode(input: {
    canonicalName: string;
    kind?: MemoryNodeKind;
    summary?: string;
  }): MemoryNode {
    const canonicalName = requireText(input.canonicalName, "node name");
    const existing = this.#db
      .prepare("SELECT * FROM memory_nodes WHERE canonical_name = ?")
      .get(canonicalName) as Row | undefined;

    if (existing) {
      const node = mapNode(existing);
      if (node.status === "active") return node;
      const redirects = this.#db
        .prepare(
          `SELECT n.* FROM node_redirects r
         JOIN memory_nodes n ON n.id = r.target_node_id
         WHERE r.source_node_id = ? AND n.status = 'active'`,
        )
        .all(node.id) as Row[];
      const unique = [...new Map(redirects.map((row) => [String(row.id), row])).values()];
      if (unique.length === 1) return mapNode(unique[0]!);
      throw new Error(
        unique.length > 1
          ? `node ${canonicalName} was split; choose a more specific node`
          : `node ${canonicalName} is inactive and has no active redirect`,
      );
    }

    // Node identity is maintained automatically for spelling-only variants.
    // This deliberately does not attempt semantic merging: punctuation, case,
    // and whitespace are safe to canonicalise, while synonyms require evidence
    // and a reversible topology transform.
    const normalizedIdentity = canonicalNodeIdentity(canonicalName);
    const identityCandidates = (
      this.#db
        .prepare("SELECT * FROM memory_nodes WHERE kind = ? AND status = 'active'")
        .all(input.kind ?? "concept") as Row[]
    ).filter((row) => canonicalNodeIdentity(String(row.canonical_name)) === normalizedIdentity);
    if (identityCandidates.length === 1) return mapNode(identityCandidates[0]!);

    const now = new Date().toISOString();
    const node: MemoryNode = {
      id: randomUUID(),
      canonicalName,
      kind: input.kind ?? "concept",
      summary: input.summary?.trim() || canonicalName,
      createdAt: now,
      updatedAt: now,
      status: "active",
      residence: "stg",
    };

    this.#db
      .prepare(
        `INSERT INTO memory_nodes
          (id, canonical_name, kind, summary, created_at, updated_at, status, residence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.canonicalName,
        node.kind,
        node.summary,
        node.createdAt,
        node.updatedAt,
        node.status,
        node.residence,
      );

    return node;
  }

  addMemory(input: {
    nodeId: string;
    evidenceId: string;
    statement: string;
    memoryType?: MemoryRecord["memoryType"];
    stateKey?: string;
    eventTime?: string;
    sourceActor?: MemoryRecord["sourceActor"];
    truthStatus?: MemoryRecord["truthStatus"];
    confidence?: number;
    polarity?: MemoryRecord["polarity"];
    predicateKey?: string;
    extractMethod?: MemoryRecord["extractMethod"];
    claims?: MemoryRecord["claims"];
    markers?: MemoryMarker[];
    tier?: MemoryTier;
    importance?: number;
    scope?: MemoryScope;
    validFrom?: string;
    validUntil?: string;
    evidenceRole?: MemoryRecord["evidenceRole"];
    supersedesId?: string;
    residence?: MemoryResidence;
    expiresAt?: string;
    writeReason?: string;
    writeSource?: MemoryRecord["writeSource"];
  }): MemoryRecord {
    const createdAt = new Date().toISOString();
    const residence = input.residence ?? defaultResidence(input);
    const writeSource = input.writeSource ?? (input.memoryType === "derived" ? "derived" : "core");
    const writeReason = input.writeReason?.trim() || defaultWriteReason(input, residence);
    const claimRollup = normalizeClaims(input.claims);
    const memory: MemoryRecord = {
      id: randomUUID(),
      nodeId: input.nodeId,
      evidenceId: input.evidenceId,
      evidenceIds: [input.evidenceId],
      statement: requireText(input.statement, "memory statement"),
      memoryType: input.memoryType ?? "fact",
      stateKey: input.stateKey ?? null,
      eventTime: input.eventTime ?? null,
      sourceActor: input.sourceActor ?? "user",
      truthStatus: input.truthStatus ?? "asserted",
      confidence: claimRollup ? claimRollup.confidence : (input.confidence ?? null),
      polarity: claimRollup ? claimRollup.polarity : (input.polarity ?? null),
      predicateKey: claimRollup ? claimRollup.predicateKey : (input.predicateKey ?? null),
      extractMethod: claimRollup ? claimRollup.extractMethod : (input.extractMethod ?? null),
      claims: claimRollup ? claimRollup.claims : null,
      markers: normalizeMarkers(input.markers),
      scope: input.scope ?? {},
      validFrom: input.validFrom ?? createdAt,
      validUntil: input.validUntil ?? null,
      status: "active",
      residence,
      promotedAt: residence === "ltg" ? createdAt : null,
      expiresAt: input.expiresAt ?? null,
      evidenceRole: input.evidenceRole ?? "support",
      supersedesId: input.supersedesId ?? null,
      tier: input.tier ?? 1,
      importance: clamp(input.importance ?? 0.5, 0, 1),
      accessCount: 0,
      lastAccessedAt: null,
      writeReason,
      writeSource,
      createdAt,
    };

    this.#db
      .prepare(
        `INSERT INTO memory_records
          (id, node_id, evidence_id, statement, memory_type, state_key,
           event_time, source_actor, truth_status, confidence, polarity, predicate_key, extract_method, claims_json, markers_json, scope_json, valid_from,
           valid_until, status, residence, promoted_at, expires_at,
           evidence_role, supersedes_id, tier, importance,
           access_count, last_accessed_at, write_reason, write_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.nodeId,
        memory.evidenceId,
        memory.statement,
        memory.memoryType,
        memory.stateKey,
        memory.eventTime,
        memory.sourceActor,
        memory.truthStatus,
        memory.confidence,
        memory.polarity,
        memory.predicateKey,
        memory.extractMethod,
        serializeClaims(memory.claims),
        serializeMarkers(memory.markers),
        serializeScope(memory.scope),
        memory.validFrom,
        memory.validUntil,
        memory.status,
        memory.residence,
        memory.promotedAt,
        memory.expiresAt,
        memory.evidenceRole,
        memory.supersedesId,
        memory.tier,
        memory.importance,
        memory.writeReason,
        memory.writeSource,
        memory.createdAt,
      );
    if (memory.residence === "ltg") {
      this.#db
        .prepare("UPDATE memory_nodes SET residence = 'ltg', updated_at = ? WHERE id = ?")
        .run(createdAt, memory.nodeId);
    }
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
         VALUES (?, ?)`,
      )
      .run(memory.id, memory.evidenceId);
    this.#upsertEmbedding(memory.id, this.#memoryText(memory, input.nodeId));
    this.#upsertFts(memory.id, memory.statement, input.nodeId, input.evidenceId);
    this.#db
      .prepare(
        `INSERT INTO leaf_block_status (node_id, dirty, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
      )
      .run(input.nodeId, createdAt);
    this.#markIndexDelta(memory.id, input.nodeId, "upsert", createdAt);

    return memory;
  }

  remember(input: RememberInput): RememberResult {
    const memoryType = input.memoryType ?? "fact";
    if (memoryType === "state" && !input.stateKey?.trim()) {
      throw new Error("state memories require a stable stateKey");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const history = input.evidenceHistoryId
        ? this.#requireHistory(input.evidenceHistoryId)
        : this.appendHistory({
            content: input.evidence ?? input.statement,
            role: "explicit",
            sessionId: input.sessionId,
            sourceRef: input.sourceRef,
          });
      const node = this.upsertNode({
        canonicalName: input.nodeName,
        kind: input.nodeKind,
        summary: input.nodeSummary,
      });
      const stateKey =
        memoryType === "state" && input.stateKey
          ? this.#resolveStateKey(input.stateKey, input.scope ?? {}, node)
          : input.stateKey;
      const automaticPrevious =
        memoryType === "state" && stateKey
          ? (this.#db
              .prepare(
                `SELECT id FROM memory_records
               WHERE memory_type = 'state' AND state_key = ? AND scope_json = ?
                 AND status = 'active'
               ORDER BY created_at DESC LIMIT 1`,
              )
              .get(stateKey, serializeScope(input.scope ?? {})) as Row | undefined)
          : undefined;
      const supersedesId =
        input.supersedesId ?? (automaticPrevious ? String(automaticPrevious.id) : undefined);
      let supersededNodeId: string | undefined;
      if (supersedesId) {
        const previous = this.#db
          .prepare("SELECT node_id FROM memory_records WHERE id = ?")
          .get(supersedesId) as Row | undefined;
        if (!previous) throw new Error(`memory ${supersedesId} does not exist`);
        supersededNodeId = String(previous.node_id);
        this.#db
          .prepare(
            `UPDATE memory_records
             SET status = 'superseded', valid_until = ?
             WHERE id = ?`,
          )
          .run(input.validFrom ?? new Date().toISOString(), supersedesId);
      }
      const memory = this.addMemory({
        nodeId: node.id,
        evidenceId: history.id,
        statement: input.statement,
        memoryType,
        stateKey,
        eventTime: input.eventTime,
        sourceActor: input.sourceActor,
        truthStatus: input.truthStatus,
        confidence: input.confidence,
        polarity: input.polarity,
        predicateKey: input.predicateKey,
        extractMethod: input.extractMethod,
        claims: input.claims,
        markers: input.markers,
        tier: input.tier,
        importance: input.importance,
        scope: input.scope,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        evidenceRole: input.evidenceRole ?? (supersedesId ? "update" : undefined),
        supersedesId,
        residence: input.residence,
        expiresAt: input.expiresAt,
        writeReason: input.writeReason,
        writeSource: input.writeSource,
      });
      this.#recordMemoryWriteEvent({
        memoryId: memory.id,
        historyId: history.id,
        sessionId: input.sessionId ?? null,
        decision: "accepted",
        policyReason: "allowed",
        writeReason: memory.writeReason,
        writeSource: memory.writeSource,
        memoryType: memory.memoryType,
        requestedResidence: memory.residence,
      });
      if (memory.residence === "ltg") node.residence = "ltg";
      if (supersededNodeId && supersededNodeId !== node.id) {
        this.#refreshNodeResidence(supersededNodeId, memory.createdAt);
      }
      this.#db.exec("COMMIT");
      return { history, node, memory };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  recordRejectedWrite(input: {
    policyReason: string;
    writeReason: string;
    writeSource?: MemoryWriteEvent["writeSource"];
    memoryType?: MemoryRecord["memoryType"];
    requestedResidence?: MemoryResidence;
    sessionId?: string;
  }): MemoryWriteEvent {
    return this.#recordMemoryWriteEvent({
      memoryId: null,
      historyId: null,
      sessionId: input.sessionId ?? null,
      decision: "rejected",
      policyReason: requireText(input.policyReason, "write policy reason"),
      writeReason: requireText(input.writeReason, "write reason"),
      writeSource: input.writeSource ?? "agent",
      memoryType: input.memoryType ?? "fact",
      requestedResidence: input.requestedResidence ?? "ltg",
    });
  }

  memoryWriteEvents(memoryId?: string): MemoryWriteEvent[] {
    const rows = memoryId
      ? (this.#db
          .prepare(
            "SELECT * FROM memory_write_events WHERE memory_id = ? ORDER BY created_at, rowid",
          )
          .all(memoryId) as Row[])
      : (this.#db
          .prepare("SELECT * FROM memory_write_events ORDER BY created_at, rowid")
          .all() as Row[]);
    return rows.map(mapMemoryWriteEvent);
  }

  promoteMemory(
    memoryId: string,
    reason: string,
    evidenceTraceIds: readonly string[] = [],
  ): MemoryRecord {
    const memory = this.#requireActiveMemory(memoryId);
    if (memory.residence === "ltg") return memory;
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `UPDATE memory_records
           SET residence = 'ltg', promoted_at = ?, expires_at = NULL
           WHERE id = ?`,
        )
        .run(now, memoryId);
      this.#db
        .prepare("UPDATE memory_nodes SET residence = 'ltg', updated_at = ? WHERE id = ?")
        .run(now, memory.nodeId);
      this.#recordConsolidationEvent(
        "promote_memory",
        memoryId,
        "stg",
        "ltg",
        requireText(reason, "promotion reason"),
        evidenceTraceIds,
        now,
      );
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { ...memory, residence: "ltg", promotedAt: now, expiresAt: null };
  }

  demoteMemory(memoryId: string, reason: string, expiresAt?: string): MemoryRecord {
    const memory = this.#requireActiveMemory(memoryId);
    if (memory.residence === "stg") return memory;
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `UPDATE memory_records
           SET residence = 'stg', promoted_at = NULL, expires_at = ?
           WHERE id = ?`,
        )
        .run(expiresAt ?? null, memoryId);
      this.#refreshNodeResidence(memory.nodeId, now);
      this.#recordConsolidationEvent(
        "demote_memory",
        memoryId,
        "ltg",
        "stg",
        requireText(reason, "demotion reason"),
        [],
        now,
      );
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { ...memory, residence: "stg", promotedAt: null, expiresAt: expiresAt ?? null };
  }

  expireShortTermMemories(at = new Date().toISOString()): string[] {
    const rows = this.#db
      .prepare(
        `SELECT id, node_id FROM memory_records
         WHERE residence = 'stg' AND status IN ('active', 'disputed')
           AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(at) as Row[];
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.#db.prepare("UPDATE memory_records SET status = 'inactive' WHERE id = ?");
      for (const row of rows) {
        const id = String(row.id);
        update.run(id);
        this.#recordConsolidationEvent(
          "expire_memory",
          id,
          "stg:active",
          "stg:inactive",
          `expired at ${at}`,
          [],
          now,
        );
      }
      for (const nodeId of new Set(rows.map((row) => String(row.node_id)))) {
        this.#refreshNodeResidence(nodeId, now);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return rows.map((row) => String(row.id));
  }

  deriveMemory(input: DeriveMemoryInput): RememberResult {
    const sourceMemoryIds = [...new Set(input.sourceMemoryIds)];
    if (sourceMemoryIds.length < 2) {
      throw new Error("derived memories require at least two source memories");
    }
    const sources = sourceMemoryIds.map((id) => {
      const row = this.#db
        .prepare("SELECT id, node_id, evidence_id FROM memory_records WHERE id = ?")
        .get(id) as Row | undefined;
      if (!row) throw new Error(`source memory ${id} does not exist`);
      return row;
    });

    const result = this.remember({
      ...input,
      memoryType: "derived",
      evidence: input.derivation,
      sourceActor: input.sourceActor ?? "assistant",
      truthStatus: input.truthStatus ?? "inferred",
    });

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const linkEvidence = this.#db.prepare(
        `INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
         VALUES (?, ?)`,
      );
      const linkDerivation = this.#db.prepare(
        `INSERT INTO memory_derivations (derived_memory_id, source_memory_id)
         VALUES (?, ?)`,
      );
      for (const source of sources) {
        const evidenceIds = this.#evidenceIds(String(source.id));
        for (const evidenceId of evidenceIds) {
          linkEvidence.run(result.memory.id, evidenceId);
        }
        linkDerivation.run(result.memory.id, String(source.id));
        this.linkNodes({
          sourceNodeId: result.node.id,
          targetNodeId: String(source.node_id),
          type: "derived_from",
          evidenceIds,
        });
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    result.memory.evidenceIds = this.#evidenceIds(result.memory.id);
    return result;
  }

  linkNodes(input: {
    sourceNodeId: string;
    targetNodeId: string;
    type: NodeRelationType;
    evidenceIds?: string[];
    stability?: number;
    consolidationSource?: NodeRelation["consolidationSource"];
  }): NodeRelation {
    const existing = this.#db
      .prepare(
        `SELECT * FROM node_relations
         WHERE source_node_id = ? AND target_node_id = ? AND relation_type = ?`,
      )
      .get(input.sourceNodeId, input.targetNodeId, input.type) as Row | undefined;
    if (existing) {
      const relation = mapRelation(existing);
      const evidenceIds = [...new Set([...relation.evidenceIds, ...(input.evidenceIds ?? [])])];
      if (evidenceIds.length !== relation.evidenceIds.length) {
        this.#db
          .prepare("UPDATE node_relations SET evidence_ids_json = ? WHERE id = ?")
          .run(JSON.stringify(evidenceIds), relation.id);
        relation.evidenceIds = evidenceIds;
      }
      if (relation.status === "demoted") {
        const consolidatedAt = new Date().toISOString();
        this.#db
          .prepare(
            "UPDATE node_relations SET status = 'consolidated', stability = ?, consolidated_at = ? WHERE id = ?",
          )
          .run(clamp(input.stability ?? 1, 0, 1), consolidatedAt, relation.id);
        relation.status = "consolidated";
        relation.stability = clamp(input.stability ?? 1, 0, 1);
        relation.consolidatedAt = consolidatedAt;
        this.#db
          .prepare("UPDATE memory_nodes SET residence = 'ltg', updated_at = ? WHERE id IN (?, ?)")
          .run(consolidatedAt, relation.sourceNodeId, relation.targetNodeId);
      }
      return relation;
    }

    const now = new Date().toISOString();
    const relation: NodeRelation = {
      id: randomUUID(),
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      type: input.type,
      evidenceIds: [...new Set(input.evidenceIds ?? [])],
      residence: "ltg",
      status: "consolidated",
      stability: clamp(input.stability ?? 1, 0, 1),
      consolidationSource: input.consolidationSource ?? "explicit",
      consolidatedAt: now,
      createdAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO node_relations
          (id, source_node_id, target_node_id, relation_type,
           evidence_ids_json, residence, status, stability,
           consolidation_source, consolidated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        relation.id,
        relation.sourceNodeId,
        relation.targetNodeId,
        relation.type,
        JSON.stringify(relation.evidenceIds),
        relation.residence,
        relation.status,
        relation.stability,
        relation.consolidationSource,
        relation.consolidatedAt,
        relation.createdAt,
      );
    this.#db
      .prepare("UPDATE memory_nodes SET residence = 'ltg', updated_at = ? WHERE id IN (?, ?)")
      .run(now, relation.sourceNodeId, relation.targetNodeId);
    return relation;
  }

  getRelations(nodeIds: string[], maxHops = 1): NodeRelation[] {
    const visitedNodes = new Set(nodeIds);
    const relations = new Map<string, NodeRelation>();
    let frontier = [...visitedNodes];
    for (let hop = 0; hop < Math.max(0, maxHops) && frontier.length > 0; hop += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const rows = this.#db
          .prepare(
            `SELECT * FROM node_relations
             WHERE status = 'consolidated'
               AND (source_node_id = ? OR target_node_id = ?)`,
          )
          .all(nodeId, nodeId) as Row[];
        for (const row of rows) {
          const relation = mapRelation(row);
          relations.set(relation.id, relation);
          for (const related of [relation.sourceNodeId, relation.targetNodeId]) {
            if (!visitedNodes.has(related)) {
              visitedNodes.add(related);
              next.push(related);
            }
          }
        }
      }
      frontier = next;
    }
    return [...relations.values()];
  }

  mergeNodes(input: {
    sourceNodeIds: string[];
    targetName: string;
    targetKind?: MemoryNodeKind;
    summary?: string;
  }): NodeTransform {
    const sourceNodeIds = [...new Set(input.sourceNodeIds)];
    if (sourceNodeIds.length < 2) throw new Error("merge requires at least two nodes");
    const sources = sourceNodeIds.map((id) => this.#requireNode(id));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const target = this.upsertNode({
        canonicalName: input.targetName,
        kind: input.targetKind ?? sources[0]!.kind,
        summary: input.summary,
      });
      if (sourceNodeIds.includes(target.id)) {
        throw new Error("merge target must be distinct from every source node");
      }
      const movedMemoryIds = this.#memoryIdsForNodes(sourceNodeIds);
      const operation = this.#createTransform("merge", sourceNodeIds, [target.id], movedMemoryIds);
      for (const sourceId of sourceNodeIds) {
        this.#db
          .prepare("UPDATE memory_records SET node_id = ? WHERE node_id = ?")
          .run(target.id, sourceId);
        this.#redirectRelations(sourceId, target.id);
        this.#db
          .prepare("UPDATE memory_nodes SET status = 'merged', updated_at = ? WHERE id = ?")
          .run(operation.createdAt, sourceId);
        this.#db
          .prepare(
            `INSERT INTO node_redirects (source_node_id, target_node_id, transform_id)
           VALUES (?, ?, ?)`,
          )
          .run(sourceId, target.id, operation.id);
      }
      for (const memoryId of movedMemoryIds) {
        this.#markIndexDelta(memoryId, target.id, "move", operation.createdAt);
      }
      this.#refreshNodeResidence(target.id, operation.createdAt);
      this.#db.exec("COMMIT");
      this.#refreshEmbeddings(movedMemoryIds);
      return operation;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  splitNode(input: {
    sourceNodeId: string;
    partitions: Array<{
      nodeName: string;
      nodeKind?: MemoryNodeKind;
      summary?: string;
      memoryIds: string[];
    }>;
  }): NodeTransform {
    const source = this.#requireNode(input.sourceNodeId);
    if (input.partitions.length < 2) throw new Error("split requires at least two partitions");
    const assigned = input.partitions.flatMap((partition) => partition.memoryIds);
    if (new Set(assigned).size !== assigned.length) {
      throw new Error("a memory cannot belong to two split partitions");
    }
    const available = new Set(this.#memoryIdsForNodes([source.id]));
    if (assigned.some((id) => !available.has(id))) {
      throw new Error("split partitions may contain only memories from the source node");
    }
    if (assigned.length !== available.size) {
      throw new Error("split partitions must assign every source memory exactly once");
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const targets = input.partitions.map((partition) =>
        this.upsertNode({
          canonicalName: partition.nodeName,
          kind: partition.nodeKind ?? source.kind,
          summary: partition.summary,
        }),
      );
      if (
        new Set(targets.map((node) => node.id)).size !== targets.length ||
        targets.some((node) => node.id === source.id)
      ) {
        throw new Error("split targets must be new, distinct semantic nodes");
      }
      const operation = this.#createTransform(
        "split",
        [source.id],
        targets.map((node) => node.id),
        assigned,
      );
      for (let index = 0; index < input.partitions.length; index += 1) {
        const partition = input.partitions[index]!;
        const target = targets[index]!;
        const update = this.#db.prepare("UPDATE memory_records SET node_id = ? WHERE id = ?");
        for (const memoryId of partition.memoryIds) {
          update.run(target.id, memoryId);
          this.#markIndexDelta(memoryId, target.id, "move", operation.createdAt);
        }
        this.linkNodes({ sourceNodeId: target.id, targetNodeId: source.id, type: "is_a" });
        this.#db
          .prepare(
            `INSERT INTO node_redirects (source_node_id, target_node_id, transform_id)
           VALUES (?, ?, ?)`,
          )
          .run(source.id, target.id, operation.id);
      }
      this.#db
        .prepare("UPDATE memory_nodes SET status = 'split', updated_at = ? WHERE id = ?")
        .run(operation.createdAt, source.id);
      this.#db.exec("COMMIT");
      this.#refreshEmbeddings(assigned);
      return operation;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getNodeTransform(transformId: string): NodeTransform | null {
    const row = this.#db.prepare("SELECT * FROM node_transforms WHERE id = ?").get(transformId) as
      Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      type: String(row.transform_type) as NodeTransform["type"],
      sourceNodeIds: parseStringArray(row.source_node_ids_json),
      targetNodeIds: parseStringArray(row.target_node_ids_json),
      movedMemoryIds: parseStringArray(row.moved_memory_ids_json),
      createdAt: String(row.created_at),
    };
  }

  routeNodes(query: string, limit = 5): NodeRoute[] {
    const rows = this.#db
      .prepare(
        `SELECT n.*, r.weights_json
       FROM memory_nodes n LEFT JOIN router_weights r ON r.node_id = n.id
       WHERE n.status = 'active'`,
      )
      .all() as Row[];
    const normalized = normalize(query);
    return rows
      .map((row) => {
        const node = mapNode(row);
        const learned = this.#router.score(query, parseVector(row.weights_json));
        const lexical = lexicalNodeScore(normalized, node);
        return { node, score: learned * 0.7 + lexical * 0.3 };
      })
      .filter((route) => route.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }

  routeNodesByVector(
    queryVector: readonly number[],
    model: string,
    limit = 5,
    candidateNodeIds: string[] = [],
    activationMode: "cosine" | "hierarchical-activation" = "cosine",
  ): NodeRoute[] {
    if (!model.trim()) throw new Error("embedding model is required");
    if (queryVector.length === 0) throw new Error("query vector is required");
    const candidates = [...new Set(candidateNodeIds)].slice(0, 2_000);
    const clause =
      candidates.length > 0 ? `AND n.id IN (${candidates.map(() => "?").join(",")})` : "";
    const rows = this.#db
      .prepare(
        `SELECT n.*
       FROM memory_nodes n JOIN node_embeddings e ON e.node_id = n.id AND e.model = ?
       WHERE n.status = 'active' ${clause}`,
      )
      .all(model, ...candidates) as Row[];
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const cache = this.#embeddingCache("node", model);
    if (!cache) return [];

    // HA is a stateful experimental controller. It must not silently replace
    // deterministic retrieval before a trained state has passed rollout gates.
    if (activationMode === "hierarchical-activation" && byId.size > 0) {
      const candidateList: Array<{ id: string; vector: Float32Array }> = [];
      for (const id of byId.keys()) {
        const vec = cache.vector(id);
        if (vec) candidateList.push({ id, vector: vec });
      }
      if (candidateList.length > 0) {
        const ha = this.#router.ensureHA(queryVector.length);
        const out = ha.propagate(
          new Float32Array(queryVector),
          candidateList.map((c) => ({ nodeId: c.id, vector: c.vector })),
        );
        const scored = candidateList.map((c, i) => ({
          node: mapNode(byId.get(c.id)!),
          score: out.nodeScores[i]!,
        }));
        return scored
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(1, Math.min(limit, 50)));
      }
    }

    // Default: deterministic Float32VectorCache cosine scoring.
    return cache
      .score(queryVector, new Set(byId.keys()))
      .map(({ id, score }) => ({ node: mapNode(byId.get(id)!), score }))
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }

  trainRouter(query: string, usefulNodeIds: string[], learningRate = 0.2): void {
    const uniqueIds = [...new Set(usefulNodeIds)];
    const upsert = this.#db.prepare(
      `INSERT INTO router_weights (node_id, model, dimensions, weights_json, examples, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(node_id) DO UPDATE SET weights_json = excluded.weights_json,
         examples = router_weights.examples + 1, updated_at = excluded.updated_at`,
    );
    const select = this.#db.prepare("SELECT weights_json FROM router_weights WHERE node_id = ?");
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const nodeId of uniqueIds) {
        this.#requireNode(nodeId);
        const row = select.get(nodeId) as Row | undefined;
        const weights = this.#router.update(
          query,
          row ? parseVector(row.weights_json) : undefined,
          clamp(learningRate, 0.001, 1),
        );
        upsert.run(
          nodeId,
          this.#embedder.model,
          this.#embedder.dimensions,
          JSON.stringify(weights),
          now,
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  rebuildVectorIndex(): number {
    const rows = this.#db
      .prepare(
        `SELECT m.id, m.statement, m.node_id, n.canonical_name, n.summary
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.storage_state = 'indexed'`,
      )
      .all() as Row[];
    const upsert = this.#db.prepare(
      `INSERT INTO memory_embeddings
        (memory_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET
         dimensions = excluded.dimensions, vector_json = excluded.vector_json,
         vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const text = memoryEmbeddingText(row.statement, row.canonical_name);
        const vector = this.#embedder.embed(text);
        upsert.run(
          row.id,
          this.#embedder.model,
          this.#embedder.dimensions,
          JSON.stringify(vector),
          encodeVector(vector),
          now,
        );
      }
      this.#db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  rebalanceNode(
    nodeId: string,
    capacities: readonly [number, number, number] = [16, 64, 256],
  ): RebalanceResult {
    this.#requireNode(nodeId);
    const rows = this.#db
      .prepare(
        `SELECT id, tier, importance, access_count, pending_access_count,
              last_accessed_at, status
       FROM memory_records WHERE node_id = ? AND storage_state = 'indexed'`,
      )
      .all(nodeId) as Row[];
    const active = rows.filter((row) => ["active", "disputed"].includes(String(row.status)));
    const weighted = active.map((row) => ({
      id: String(row.id),
      weight: hierarchyWeight(row),
    }));
    const depths = huffmanDepths(weighted);
    const tiers = blockTiers(depths, capacities);
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0) || 1;
    const expectedDepth = weighted.reduce(
      (sum, item) => sum + (item.weight / totalWeight) * (depths.get(item.id) ?? 0),
      0,
    );
    const changedMemoryIds: string[] = [];
    const update = this.#db.prepare(
      "UPDATE memory_records SET tier = ?, pending_access_count = 0 WHERE id = ?",
    );
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of active) {
        const id = String(row.id);
        const tier = tiers.get(id) ?? 3;
        if (tier !== Number(row.tier)) changedMemoryIds.push(id);
        update.run(tier, id);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return {
      nodeId,
      changedMemoryIds,
      expectedDepth,
      pendingAccesses: rows.reduce((sum, row) => sum + Number(row.pending_access_count ?? 0), 0),
    };
  }

  rebalanceDueNodes(
    threshold = 32,
    capacities: readonly [number, number, number] = [16, 64, 256],
  ): RebalanceResult[] {
    const rows = this.#db
      .prepare(
        `SELECT node_id, SUM(pending_access_count) AS pending
       FROM memory_records GROUP BY node_id HAVING pending >= ?`,
      )
      .all(Math.max(1, threshold)) as Row[];
    return rows.map((row) => this.rebalanceNode(String(row.node_id), capacities));
  }

  searchContext(
    query: string,
    options: SearchOptions = {},
    semantic?: { queryVector: readonly number[]; model: string },
  ): MemoryContext {
    const startedAt = Date.now();
    const budget = activeGraphBudget(options);
    const limit = Math.max(1, Math.min(options.limit ?? 8, budget.maxEvidence, 50));
    const directOptions = {
      ...options,
      maxTier: Math.min(options.maxTier ?? budget.maxLocalTier, budget.maxLocalTier) as MemoryTier,
      limit: Math.min(50, Math.max(20, limit * 3)),
    };
    const direct = semantic
      ? options.vectorGranularity === "union"
        ? mergeSemanticCandidates(
            query,
            [
              ...this.searchHierarchyByVector(
                query,
                semantic.queryVector,
                semantic.model,
                directOptions,
              ),
              ...this.searchByVector(query, semantic.queryVector, semantic.model, {
                ...directOptions,
                retrievalMode: "qwen3",
              }),
            ],
            directOptions.limit,
          )
        : options.vectorGranularity === "records"
          ? this.searchByVector(query, semantic.queryVector, semantic.model, {
              ...directOptions,
              retrievalMode: "qwen3",
            })
          : this.searchHierarchyByVector(query, semantic.queryVector, semantic.model, directOptions)
      : this.search(query, directOptions);
    const graphHops = Math.min(options.graphHops ?? 1, budget.maxGraphHops);
    const relations = this.getRelations(
      direct.map((result) => result.node.id),
      graphHops,
    );
    const directNodeIds = new Set(direct.map((result) => result.node.id));
    const relatedNodeIds = [
      ...new Set(relations.flatMap((relation) => [relation.sourceNodeId, relation.targetNodeId])),
    ].filter((id) => !directNodeIds.has(id));
    const related = relatedNodeIds.flatMap((nodeId) =>
      this.#resultsForNode(
        nodeId,
        Math.min(options.maxTier ?? budget.maxLocalTier, budget.maxLocalTier) as MemoryTier,
        2,
        undefined,
        options.sourceActor,
      ),
    );
    const candidates = [...direct, ...related]
      .filter(
        (result, index, all) =>
          all.findIndex((candidate) => candidate.memory.id === result.memory.id) === index,
      )
      .sort((left, right) => contextUsefulness(query, right) - contextUsefulness(query, left));
    const selectWithinBudget = (
      bud: ActiveGraphBudget,
      lim: number,
    ): {
      results: MemorySearchResult[];
      selectedNodes: Set<string>;
      estimatedTokens: number;
      exhausted: Set<ActiveGraphBudgetUsage["exhausted"][number]>;
    } => {
      const nodes = new Set<string>();
      const res: MemorySearchResult[] = [];
      let tokens = 0;
      const ex = new Set<ActiveGraphBudgetUsage["exhausted"][number]>();
      for (const candidate of candidates) {
        if (res.length >= lim) {
          ex.add("evidence");
          break;
        }
        if (!nodes.has(candidate.node.id) && nodes.size >= bud.maxNodes) {
          ex.add("nodes");
          continue;
        }
        const candidateTokens = estimateResultTokens(candidate);
        if (res.length > 0 && tokens + candidateTokens > bud.maxTokens) {
          ex.add("tokens");
          continue;
        }
        res.push(candidate);
        nodes.add(candidate.node.id);
        tokens += candidateTokens;
      }
      return { results: res, selectedNodes: nodes, estimatedTokens: tokens, exhausted: ex };
    };
    const buildSelections = (res: readonly MemorySearchResult[]): ActiveGraphSelection[] =>
      res.map((result, index) => ({
        memoryId: result.memory.id,
        nodeId: result.node.id,
        source: direct.some((item) => item.memory.id === result.memory.id)
          ? "direct"
          : "graph_expansion",
        reason: recallReason(result),
        rank: index + 1,
        tier: result.memory.tier,
        estimatedTokens: estimateResultTokens(result),
        scores: {
          lexical: result.lexicalScore,
          vector: result.vectorScore,
          route: result.routeScore,
          combined: result.combinedScore,
          usefulness: contextUsefulness(query, result),
        },
      }));
    let selection = selectWithinBudget(budget, limit);
    let activeBudget = budget;
    let selections = buildSelections(selection.results);
    let qppDecision = shouldTriggerSecondPass(
      query,
      qppCandidates(selection.results, selections),
      options.qppThreshold,
    );
    if (options.secondPass) {
      const maximum = expandActiveGraphBudget(budget);
      const stages = [];
      let stoppedBecause: NonNullable<QppTriggerDecision["expansion"]>["stoppedBecause"] =
        "budget_exhausted";
      const fibonacciBudgets = fibonacciEvidenceBudgets(Math.min(50, maximum.maxEvidence));
      const requestedInitial = Math.max(
        1,
        Math.min(options.initialEvidenceTarget ?? 1, maximum.maxEvidence),
      );
      const initialTarget =
        fibonacciBudgets.find((target) => target >= requestedInitial) ?? maximum.maxEvidence;
      for (const targetEvidence of fibonacciBudgets.filter((target) => target >= initialTarget)) {
        // Relation expansion has already run at the original graph-hop budget.
        // Do not claim the extra hop from the hard envelope until graph routing
        // itself becomes progressive.
        activeBudget = {
          ...maximum,
          maxEvidence: targetEvidence,
          maxGraphHops: budget.maxGraphHops,
        };
        selection = selectWithinBudget(activeBudget, targetEvidence);
        selections = buildSelections(selection.results);
        qppDecision = shouldTriggerSecondPass(
          query,
          qppCandidates(selection.results, selections),
          options.qppThreshold,
        );
        stages.push({
          targetEvidence,
          selectedEvidence: selection.results.length,
          estimatedTokens: selection.estimatedTokens,
          qpp: qppDecision.qpp,
          trigger: qppDecision.trigger,
          reason: qppDecision.reason,
        });
        if (!qppDecision.trigger) {
          stoppedBecause = "sufficient";
          break;
        }
        if (selection.results.length >= candidates.length) {
          stoppedBecause = "candidate_pool_exhausted";
          break;
        }
      }
      qppDecision = {
        ...qppDecision,
        expansion: { strategy: "fibonacci", stages, stoppedBecause },
      };
    }
    const { results, selectedNodes, estimatedTokens, exhausted } = selection;
    const persistentEdges = relations
      .filter(
        (relation) =>
          selectedNodes.has(relation.sourceNodeId) && selectedNodes.has(relation.targetNodeId),
      )
      .slice(0, activeBudget.maxEdges)
      .map((relation) => ({
        id: relation.id,
        sourceNodeId: relation.sourceNodeId,
        targetNodeId: relation.targetNodeId,
        type: relation.type,
        persistence: "persistent" as const,
        stability: relation.stability,
      }));
    const directSelectedNodeIds = [
      ...new Set(
        results
          .filter((result) => direct.some((item) => item.memory.id === result.memory.id))
          .map((result) => result.node.id),
      ),
    ];
    const temporaryEdges = queryAssociationEdges(
      directSelectedNodeIds,
      persistentEdges,
      activeBudget.maxEdges - persistentEdges.length,
    );
    const edges = [...persistentEdges, ...temporaryEdges];
    if (relations.length > persistentEdges.length || edges.length >= activeBudget.maxEdges) {
      exhausted.add("edges");
    }
    const topScores = direct.slice(0, 2).map((result) => result.combinedScore);
    const ambiguity = topScores.length < 2 ? 0 : 1 - clamp(topScores[0]! - topScores[1]!, 0, 1);
    const latencyMs = Date.now() - startedAt;
    if (latencyMs > activeBudget.maxLatencyMs) exhausted.add("latency");
    const usage: ActiveGraphBudgetUsage = {
      nodes: selectedNodes.size,
      edges: edges.length,
      evidence: results.length,
      estimatedTokens,
      graphHops,
      deepestTier: results.reduce<MemoryTier>(
        (deepest, result) => Math.max(deepest, result.memory.tier) as MemoryTier,
        0,
      ),
      latencyMs,
      exhausted: [...exhausted].sort(),
    };
    const expansions = activeGraphExpansions(directSelectedNodeIds, persistentEdges, graphHops);
    const budgetLedger = activeGraphBudgetLedger(activeBudget, usage);
    const taskId = options.taskId?.trim() || stableTaskId(query);
    const traceInput: RetrievalTraceInput = {
      query,
      taskId,
      resultMemoryIds: results.map((result) => result.memory.id),
      resultNodeIds: results.map((result) => result.node.id),
      expandedNodeIds: relatedNodeIds,
      relationIds: persistentEdges.map((edge) => edge.id),
      ambiguity,
      fallbackUsed: direct.length === 0 || related.length > 0,
      conflictObserved:
        results.some((result) => result.memory.status === "disputed") ||
        relations.some((relation) => relation.type === "contradicts"),
      activeGraphBudget: budget,
      activeGraphUsage: usage,
      selections,
      expansions,
      budgetLedger,
      qpp: qppDecision,
    };
    // A controller probe is a private planning artifact, not an interaction the
    // model could have used. Persisting it would pollute online-learning labels
    // and steadily grow the trace table with duplicate searches.
    const traceId =
      options.persistTrace === false ? randomUUID() : this.recordRetrievalTrace(traceInput);
    const activeGraph: ActiveGraph = {
      id: traceId,
      query,
      taskId,
      nodeIds: [...selectedNodes],
      memoryIds: results.map((result) => result.memory.id),
      edges,
      selections,
      expansions,
      budgetLedger,
      budget: activeBudget,
      usage,
      qpp: qppDecision,
      createdAt: new Date().toISOString(),
    };
    return {
      results,
      relations: persistentEdges.flatMap((edge) =>
        relations.filter((relation) => relation.id === edge.id),
      ),
      activeGraph,
    };
  }

  /**
   * Convenience wrapper for {@link searchContext} with `secondPass` enabled.
   * The progressive logic lives inside `searchContext`: start with the complete
   * Top-1 memory, then walk cumulative Fibonacci evidence tiers while QPP still
   * requests expansion. Every tier re-selects from the same over-sampled pool;
   * no ANN or lexical re-search occurs. This wrapper only provides explicit
   * opt-in.
   *
   * See docs/retrieval-confidence-controller.md §2 Stage 0.
   */
  searchContextWithSecondPass(
    query: string,
    options: SearchOptions = {},
    semantic?: { queryVector: readonly number[]; model: string },
  ): MemoryContext {
    return this.searchContext(
      query,
      { ...options, secondPass: options.secondPass ?? true },
      semantic,
    );
  }

  getContext(memoryIds: readonly string[], graphHops = 0): MemoryContext {
    const ids = [...new Set(memoryIds)].slice(0, 50);
    const findNode = this.#db.prepare("SELECT node_id FROM memory_records WHERE id = ?");
    const results = ids.flatMap((memoryId) => {
      const row = findNode.get(memoryId) as Row | undefined;
      if (!row) return [];
      return this.#resultsForNode(String(row.node_id), 3, 1, memoryId);
    });
    return {
      results,
      relations: this.getRelations(
        [...new Set(results.map((result) => result.node.id))],
        graphHops,
      ),
    };
  }

  recordRetrievalTrace(input: RetrievalTraceInput): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const nodeIds = [...new Set(input.resultNodeIds)].sort();
    const usefulNodeIds = new Set(this.#nodeIdsForMemories(input.usefulMemoryIds ?? []));
    const contradictedNodeIds = new Set(
      this.#nodeIdsForMemories(input.contradictedMemoryIds ?? []),
    );
    const taskId = input.taskId?.trim() || stableTaskId(input.query);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO retrieval_traces
          (id, query, result_memory_ids_json, result_node_ids_json,
           expanded_node_ids_json, useful_memory_ids_json,
           contradicted_memory_ids_json, rejected_memory_ids_json,
           relation_ids_json, task_id, active_graph_budget_json,
           active_graph_usage_json, selections_json, expansions_json,
           budget_ledger_json, qpp_json, ambiguity,
           fallback_used, conflict_observed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.query,
          JSON.stringify([...new Set(input.resultMemoryIds)]),
          JSON.stringify(nodeIds),
          JSON.stringify([...new Set(input.expandedNodeIds ?? [])]),
          JSON.stringify([...new Set(input.usefulMemoryIds ?? [])]),
          JSON.stringify([...new Set(input.contradictedMemoryIds ?? [])]),
          JSON.stringify([...new Set(input.rejectedMemoryIds ?? [])]),
          JSON.stringify([...new Set(input.relationIds ?? [])]),
          taskId,
          JSON.stringify(input.activeGraphBudget ?? {}),
          JSON.stringify(input.activeGraphUsage ?? {}),
          JSON.stringify(input.selections ?? []),
          JSON.stringify(input.expansions ?? []),
          JSON.stringify(input.budgetLedger ?? []),
          JSON.stringify(input.qpp ?? null),
          clamp(input.ambiguity ?? 0, 0, 1),
          input.fallbackUsed ? 1 : 0,
          input.conflictObserved ? 1 : 0,
          createdAt,
        );
      const updateNode = this.#db.prepare(
        `INSERT INTO node_retrieval_signals
          (node_id, query_count, ambiguity_sum, fallback_count,
           conflict_count, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           query_count = query_count + 1,
           ambiguity_sum = ambiguity_sum + excluded.ambiguity_sum,
           fallback_count = fallback_count + excluded.fallback_count,
           conflict_count = conflict_count + excluded.conflict_count,
           updated_at = excluded.updated_at`,
      );
      for (const nodeId of nodeIds) {
        updateNode.run(
          nodeId,
          clamp(input.ambiguity ?? 0, 0, 1),
          input.fallbackUsed ? 1 : 0,
          input.conflictObserved ? 1 : 0,
          createdAt,
        );
      }
      this.#recordNodeSelections(nodeIds, input.expandedNodeIds ?? [], createdAt);
      this.#recordEdgeSelections(input.relationIds ?? [], createdAt);
      const updatePair = this.#db.prepare(
        `INSERT INTO node_pair_signals
          (left_node_id, right_node_id, co_retrieval_count, useful_count,
           evidence_trace_ids_json, updated_at)
         VALUES (?, ?, 1, 0, ?, ?)
         ON CONFLICT(left_node_id, right_node_id) DO UPDATE SET
           co_retrieval_count = co_retrieval_count + 1,
           evidence_trace_ids_json = excluded.evidence_trace_ids_json,
           updated_at = excluded.updated_at`,
      );
      const observeTask = this.#db.prepare(
        `INSERT INTO edge_task_observations
          (left_node_id, right_node_id, task_id, trace_id, useful,
           contradicted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(left_node_id, right_node_id, task_id) DO UPDATE SET
           useful = MAX(useful, excluded.useful),
           contradicted = MAX(contradicted, excluded.contradicted)`,
      );
      for (let left = 0; left < nodeIds.length; left += 1) {
        for (let right = left + 1; right < nodeIds.length; right += 1) {
          const pair = [nodeIds[left]!, nodeIds[right]!] as const;
          const previous = this.#db
            .prepare(
              `SELECT evidence_trace_ids_json FROM node_pair_signals
             WHERE left_node_id = ? AND right_node_id = ?`,
            )
            .get(...pair) as Row | undefined;
          const evidence = [
            ...parseStringArray(previous?.evidence_trace_ids_json ?? null),
            id,
          ].slice(-32);
          updatePair.run(...pair, JSON.stringify(evidence), createdAt);
          observeTask.run(
            ...pair,
            taskId,
            id,
            usefulNodeIds.has(pair[0]) && usefulNodeIds.has(pair[1]) ? 1 : 0,
            contradictedNodeIds.has(pair[0]) || contradictedNodeIds.has(pair[1]) ? 1 : 0,
            createdAt,
          );
          this.#refreshPairUsefulness(pair[0], pair[1]);
        }
      }
      this.#db.exec("COMMIT");
      return id;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  retrievalTrace(id: string): RetrievalTrace | null {
    const row = this.#db.prepare("SELECT * FROM retrieval_traces WHERE id = ?").get(id) as
      Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      query: String(row.query),
      taskId: String(row.task_id),
      resultMemoryIds: parseStringArray(row.result_memory_ids_json),
      resultNodeIds: parseStringArray(row.result_node_ids_json),
      expandedNodeIds: parseStringArray(row.expanded_node_ids_json),
      relationIds: parseStringArray(row.relation_ids_json),
      usefulMemoryIds: parseStringArray(row.useful_memory_ids_json),
      contradictedMemoryIds: parseStringArray(row.contradicted_memory_ids_json),
      rejectedMemoryIds: parseStringArray(row.rejected_memory_ids_json),
      ambiguity: Number(row.ambiguity),
      fallbackUsed: Boolean(row.fallback_used),
      conflictObserved: Boolean(row.conflict_observed),
      activeGraphBudget: parseStoredJson(row.active_graph_budget_json, activeGraphBudget({})),
      activeGraphUsage: parseStoredJson(row.active_graph_usage_json, {
        nodes: 0,
        edges: 0,
        evidence: 0,
        estimatedTokens: 0,
        graphHops: 0,
        deepestTier: 0,
        latencyMs: 0,
        exhausted: [],
      }),
      selections: parseStoredJson(row.selections_json, []),
      expansions: parseStoredJson(row.expansions_json, []),
      budgetLedger: parseStoredJson(row.budget_ledger_json, []),
      qpp: parseQppDecision(row.qpp_json),
      createdAt: String(row.created_at),
    };
  }

  recordActiveGraphUse(
    activeGraphId: string,
    input: {
      usedMemoryIds: readonly string[];
      contradictedMemoryIds?: readonly string[];
      rejectedMemoryIds?: readonly string[];
    },
  ): void {
    const row = this.#db
      .prepare("SELECT * FROM retrieval_traces WHERE id = ?")
      .get(activeGraphId) as Row | undefined;
    if (!row) throw new Error(`active graph ${activeGraphId} does not exist`);
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
    const usedNodeIds = new Set(this.#nodeIdsForMemories(usedMemoryIds));
    const contradictedNodeIds = new Set(this.#nodeIdsForMemories(contradictedMemoryIds));
    const observedUsedNodeIds = new Set(this.#nodeIdsForMemories(observedUsedMemoryIds));
    const observedContradictedNodeIds = new Set(
      this.#nodeIdsForMemories(observedContradictedMemoryIds),
    );
    const observedRejectedNodeIds = new Set(this.#nodeIdsForMemories(observedRejectedMemoryIds));
    const resultNodeIds = parseStringArray(row.result_node_ids_json).sort();
    const relationIds = parseStringArray(row.relation_ids_json);
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
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
      this.#recordNodeOutcomes(
        observedUsedNodeIds,
        observedContradictedNodeIds,
        observedRejectedNodeIds,
        now,
      );
      this.#recordEdgeOutcomes(
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
          this.#db
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
          this.#refreshPairUsefulness(pair[0], pair[1]);
        }
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.recordUsage(observedUsedMemoryIds);
    if (usedNodeIds.size > 0) this.trainRouter(String(row.query), [...usedNodeIds]);
  }

  edgeStability(leftNodeId: string, rightNodeId: string): EdgeStability {
    const [left, right] = [leftNodeId, rightNodeId].sort();
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS independent_tasks,
                SUM(useful) AS useful_tasks,
                SUM(contradicted) AS contradicted_tasks,
                MAX(created_at) AS updated_at
         FROM edge_task_observations
         WHERE left_node_id = ? AND right_node_id = ?`,
      )
      .get(left, right) as Row;
    const independentTasks = Number(row.independent_tasks ?? 0);
    const usefulTasks = Number(row.useful_tasks ?? 0);
    const contradictedTasks = Number(row.contradicted_tasks ?? 0);
    const updatedAt = row.updated_at ? String(row.updated_at) : new Date(0).toISOString();
    const ageDays = Math.max(0, (Date.now() - Date.parse(updatedAt)) / 86_400_000);
    const decay = Math.pow(0.5, ageDays / 180);
    const evidenceScore =
      independentTasks === 0
        ? 0
        : usefulTasks / independentTasks - (0.5 * contradictedTasks) / independentTasks;
    return {
      leftNodeId: left,
      rightNodeId: right,
      independentTasks,
      usefulTasks,
      contradictedTasks,
      score: clamp(evidenceScore * decay, 0, 1),
      updatedAt,
    };
  }

  nodeActivation(nodeId: string): ActivationSignal {
    const row = this.#db
      .prepare("SELECT * FROM node_activation_signals WHERE node_id = ?")
      .get(nodeId) as Row | undefined;
    return mapActivation(row, true);
  }

  relationActivation(relationId: string): ActivationSignal {
    const row = this.#db
      .prepare("SELECT * FROM edge_activation_signals WHERE relation_id = ?")
      .get(relationId) as Row | undefined;
    return mapActivation(row, false);
  }

  reconcileConsolidation(
    options: {
      minIndependentTasks?: number;
      promoteThreshold?: number;
      demoteThreshold?: number;
      cooldownMs?: number;
    } = {},
  ): ConsolidationResult {
    const minIndependentTasks = Math.max(2, options.minIndependentTasks ?? 3);
    const promoteThreshold = clamp(options.promoteThreshold ?? 0.75, 0, 1);
    const demoteThreshold = clamp(options.demoteThreshold ?? 0.45, 0, promoteThreshold);
    const cooldownMs = Math.max(0, options.cooldownMs ?? 7 * 24 * 60 * 60 * 1_000);
    const consolidatedRelations: NodeRelation[] = [];
    const demotedRelations: NodeRelation[] = [];
    const eventIds: string[] = [];
    const pairs = this.#db
      .prepare(
        `SELECT DISTINCT left_node_id, right_node_id FROM edge_task_observations
         ORDER BY left_node_id, right_node_id`,
      )
      .all() as Row[];
    for (const row of pairs) {
      const stability = this.edgeStability(String(row.left_node_id), String(row.right_node_id));
      const relationRow = this.#db
        .prepare(
          `SELECT * FROM node_relations WHERE consolidation_source = 'stability'
           AND ((source_node_id = ? AND target_node_id = ?)
             OR (source_node_id = ? AND target_node_id = ?))
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(
          stability.leftNodeId,
          stability.rightNodeId,
          stability.rightNodeId,
          stability.leftNodeId,
        ) as Row | undefined;
      const relation = relationRow ? mapRelation(relationRow) : null;
      if (
        stability.independentTasks >= minIndependentTasks &&
        stability.score >= promoteThreshold &&
        (!relation || relation.status === "demoted") &&
        !this.#consolidationCoolingDown(
          relation?.id ?? `pair:${stability.leftNodeId}:${stability.rightNodeId}`,
          cooldownMs,
        )
      ) {
        const evidenceTraceIds = this.#edgeEvidenceTraceIds(
          stability.leftNodeId,
          stability.rightNodeId,
        );
        const promoted = this.linkNodes({
          sourceNodeId: stability.leftNodeId,
          targetNodeId: stability.rightNodeId,
          type: "related_to",
          evidenceIds: [],
          stability: stability.score,
          consolidationSource: "stability",
        });
        this.#db
          .prepare("UPDATE node_relations SET consolidation_source = 'stability' WHERE id = ?")
          .run(promoted.id);
        promoted.consolidationSource = "stability";
        eventIds.push(
          this.#recordConsolidationEvent(
            "consolidate",
            promoted.id,
            relation?.status ?? "candidate",
            "consolidated",
            `stability=${stability.score.toFixed(3)} tasks=${stability.independentTasks}`,
            evidenceTraceIds,
          ),
        );
        consolidatedRelations.push(promoted);
      } else if (
        relation?.status === "consolidated" &&
        stability.score <= demoteThreshold &&
        !this.#consolidationCoolingDown(relation.id, cooldownMs)
      ) {
        this.#db
          .prepare("UPDATE node_relations SET status = 'demoted', stability = ? WHERE id = ?")
          .run(stability.score, relation.id);
        relation.status = "demoted";
        relation.stability = stability.score;
        const now = new Date().toISOString();
        this.#refreshNodeResidence(relation.sourceNodeId, now);
        this.#refreshNodeResidence(relation.targetNodeId, now);
        eventIds.push(
          this.#recordConsolidationEvent(
            "demote",
            relation.id,
            "consolidated",
            "demoted",
            `stability=${stability.score.toFixed(3)} threshold=${demoteThreshold}`,
            this.#edgeEvidenceTraceIds(stability.leftNodeId, stability.rightNodeId),
          ),
        );
        demotedRelations.push(relation);
      }
    }
    return {
      consolidatedRelations,
      demotedRelations,
      events: eventIds.map((id) => this.#requireConsolidationEvent(id)),
    };
  }

  consolidationEvents(): ConsolidationEvent[] {
    return (
      this.#db.prepare("SELECT * FROM consolidation_events ORDER BY rowid").all() as Row[]
    ).map(mapConsolidationEvent);
  }

  proposeTopologyChanges(
    options: {
      minObservations?: number;
      minGain?: number;
      cooldownMs?: number;
    } = {},
  ): TopologyProposal[] {
    const minObservations = Math.max(2, options.minObservations ?? 3);
    const minGain = clamp(options.minGain ?? 0.6, 0, 1);
    const cooldownMs = Math.max(0, options.cooldownMs ?? 7 * 24 * 60 * 60 * 1_000);
    const proposals: TopologyProposal[] = [];
    const pairRows = this.#db
      .prepare(
        `SELECT p.*, l.query_count AS left_queries, r.query_count AS right_queries
       FROM node_pair_signals p
       JOIN node_retrieval_signals l ON l.node_id = p.left_node_id
       JOIN node_retrieval_signals r ON r.node_id = p.right_node_id
       JOIN memory_nodes ln ON ln.id = p.left_node_id AND ln.status = 'active'
       JOIN memory_nodes rn ON rn.id = p.right_node_id AND rn.status = 'active'
       WHERE p.co_retrieval_count >= ?`,
      )
      .all(minObservations) as Row[];
    for (const row of pairRows) {
      const sourceNodeIds = [String(row.left_node_id), String(row.right_node_id)];
      const proposalKey = `link:${sourceNodeIds.join(":")}`;
      // Co-retrieval is only a candidate signal. Requiring both nodes to have
      // been marked useful avoids turning the retriever's own accidental
      // co-results into self-reinforcing graph edges.
      const gain =
        Number(row.useful_count) / Math.max(Number(row.left_queries), Number(row.right_queries), 1);
      if (gain < minGain || this.#proposalCoolingDown(proposalKey, cooldownMs)) continue;
      const relation = this.#db
        .prepare(
          `SELECT 1 FROM node_relations WHERE
         (source_node_id = ? AND target_node_id = ?) OR
         (source_node_id = ? AND target_node_id = ?) LIMIT 1`,
        )
        .get(sourceNodeIds[0], sourceNodeIds[1], sourceNodeIds[1], sourceNodeIds[0]);
      if (relation) continue;
      proposals.push(
        this.#insertTopologyProposal({
          proposalKey,
          type: "link",
          sourceNodeIds,
          relationType: "related_to",
          partitions: [],
          evidenceTraceIds: parseStringArray(row.evidence_trace_ids_json),
          observations: Number(row.co_retrieval_count),
          estimatedGain: gain,
        }),
      );
    }
    const nodeRows = this.#db
      .prepare(
        `SELECT s.* FROM node_retrieval_signals s
       JOIN memory_nodes n ON n.id = s.node_id AND n.status = 'active'
       WHERE s.query_count >= ?`,
      )
      .all(minObservations) as Row[];
    for (const row of nodeRows) {
      const nodeId = String(row.node_id);
      const ambiguity = Number(row.ambiguity_sum) / Math.max(Number(row.query_count), 1);
      const fallback = Number(row.fallback_count) / Math.max(Number(row.query_count), 1);
      const gain = Math.max(ambiguity, fallback);
      const proposalKey = `split:${nodeId}`;
      if (gain < minGain || this.#proposalCoolingDown(proposalKey, cooldownMs)) continue;
      const partitions = this.#candidatePartitions(nodeId);
      if (partitions.length < 2) continue;
      const traces = this.#db
        .prepare(
          `SELECT id FROM retrieval_traces
         WHERE result_node_ids_json LIKE ? ORDER BY created_at DESC LIMIT 16`,
        )
        .all(`%${nodeId}%`) as Row[];
      proposals.push(
        this.#insertTopologyProposal({
          proposalKey,
          type: "split",
          sourceNodeIds: [nodeId],
          relationType: null,
          partitions,
          evidenceTraceIds: traces.map((trace) => String(trace.id)),
          observations: Number(row.query_count),
          estimatedGain: gain,
        }),
      );
    }
    return proposals;
  }

  topologyProposals(status: TopologyProposal["status"] = "pending"): TopologyProposal[] {
    return (
      this.#db
        .prepare("SELECT * FROM topology_proposals WHERE status = ? ORDER BY created_at, id")
        .all(status) as Row[]
    ).map(mapTopologyProposal);
  }

  reviewTopologyProposal(proposalId: string, decision: "accept" | "reject"): TopologyProposal {
    const row = this.#db
      .prepare("SELECT * FROM topology_proposals WHERE id = ?")
      .get(proposalId) as Row | undefined;
    if (!row) throw new Error(`topology proposal ${proposalId} does not exist`);
    const proposal = mapTopologyProposal(row);
    if (proposal.status !== "pending") {
      throw new Error(`topology proposal ${proposalId} is already ${proposal.status}`);
    }
    if (decision === "reject") {
      this.#db
        .prepare("UPDATE topology_proposals SET status = 'rejected' WHERE id = ?")
        .run(proposalId);
      return { ...proposal, status: "rejected" };
    }
    if (proposal.type === "link") {
      this.linkNodes({
        sourceNodeId: proposal.sourceNodeIds[0]!,
        targetNodeId: proposal.sourceNodeIds[1]!,
        type: proposal.relationType ?? "related_to",
      });
    } else {
      const source = this.#requireNode(proposal.sourceNodeIds[0]!);
      this.splitNode({
        sourceNodeId: source.id,
        partitions: proposal.partitions.map((partition, index) => ({
          nodeName: `${source.canonicalName} / ${partitionLabel(partition.label, index)}`,
          memoryIds: partition.memoryIds,
        })),
      });
    }
    this.#db
      .prepare("UPDATE topology_proposals SET status = 'accepted' WHERE id = ?")
      .run(proposalId);
    return { ...proposal, status: "accepted" };
  }

  residentKernel(limit = 4): MemoryContext {
    const rows = this.#db
      .prepare(
        `SELECT m.id, m.node_id
       FROM memory_records m
       JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.memory_type = 'constraint'
         AND m.tier = 0
         AND m.storage_state = 'indexed'
         AND m.importance >= 0.8
         AND m.status = 'active'
         AND m.truth_status IN ('asserted', 'verified')
         AND m.source_actor IN ('user', 'tool', 'system')
         AND n.status = 'active'
       ORDER BY m.importance DESC, m.access_count DESC, m.created_at DESC
       LIMIT ?`,
      )
      .all(Math.max(0, Math.min(limit, 12))) as Row[];
    const byNode = new Map<string, MemorySearchResult[]>();
    const results = rows.flatMap((row) => {
      const nodeId = String(row.node_id);
      let nodeResults = byNode.get(nodeId);
      if (!nodeResults) {
        nodeResults = this.#resultsForNode(nodeId, 0, 50);
        byNode.set(nodeId, nodeResults);
      }
      return nodeResults.filter((result) => result.memory.id === String(row.id));
    });
    return { results, relations: [] };
  }

  recallCues(query: string, options: SearchOptions = {}): RecallIndex {
    const cueLimit = Math.max(1, Math.min(options.limit ?? 5, 12));
    const candidates = this.search(query, {
      ...options,
      maxTier: 3,
      limit: 50,
    });
    const nodeIds = [...new Set(candidates.map((result) => result.node.id))].slice(0, cueLimit);
    const aggregate = this.#db.prepare(
      `SELECT COUNT(*) AS active_count, MAX(created_at) AS newest_at,
              MAX(tier) AS deepest_tier,
              SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) AS conflicts,
              GROUP_CONCAT(DISTINCT memory_type) AS memory_types
       FROM memory_records
       WHERE node_id = ? AND status IN ('active', 'disputed')
         AND storage_state = 'indexed'`,
    );
    const cues: RecallCue[] = nodeIds.map((nodeId) => {
      const matches = candidates.filter((result) => result.node.id === nodeId);
      const best = matches[0]!;
      const row = aggregate.get(nodeId) as Row;
      const deepestTier = Number(row.deepest_tier ?? 0) as MemoryTier;
      return {
        nodeId,
        canonicalName: best.node.canonicalName,
        memoryTypes: String(row.memory_types ?? "")
          .split(",")
          .filter(Boolean) as MemoryRecord["memoryType"][],
        activeCount: Number(row.active_count ?? 0),
        newestAt: row.newest_at ? String(row.newest_at) : null,
        deepestTier,
        hasConflicts: Number(row.conflicts ?? 0) > 0,
        hasDeepMemory: deepestTier > 1,
        score: best.combinedScore,
        reason: recallReason(best),
      };
    });
    return { cues };
  }

  search(query: string, options: SearchOptions = {}): MemorySearchResult[] {
    return this.#searchWithVector(
      query,
      this.#embedder.embed(query),
      this.#embedder.model,
      options,
    );
  }

  searchByVector(
    query: string,
    queryVector: readonly number[],
    model: string,
    options: SearchOptions = {},
  ): MemorySearchResult[] {
    return this.#searchWithVector(query, queryVector, model, {
      ...options,
      retrievalMode: options.retrievalMode ?? "qwen3",
    });
  }

  searchByVectorCandidates(
    query: string,
    queryVector: readonly number[],
    model: string,
    candidateMemoryIds: string[],
    options: SearchOptions = {},
  ): MemorySearchResult[] {
    return this.#searchWithVector(
      query,
      queryVector,
      model,
      {
        ...options,
        retrievalMode: options.retrievalMode ?? "qwen3",
      },
      [...new Set(candidateMemoryIds)].slice(0, 2_000),
    );
  }

  embeddingDocuments(afterMemoryId = "", limit = 256, missingModel?: string): EmbeddingDocument[] {
    const rows = this.#db
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
    const rows = this.#db
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
    const upsert = this.#db.prepare(
      `INSERT INTO node_embeddings
        (node_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
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
      this.#db.exec("COMMIT");
      for (const item of embeddings) {
        this.#updateVectorCache("node", model, item.nodeId, item.vector);
      }
      return embeddings.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  storedNodeEmbeddings(model: string, afterNodeId = "", limit = 256): ExternalNodeEmbedding[] {
    const rows = this.#db
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

  rebuildLeafBlocks(nodeId?: string, blockSize = 32): LeafBlock[] {
    const size = Math.max(4, Math.min(blockSize, 128));
    if (!nodeId) {
      const rows = this.#db
        .prepare("SELECT id FROM memory_nodes WHERE status = 'active' ORDER BY id")
        .all() as Row[];
      return rows.flatMap((row) => this.rebuildLeafBlocks(String(row.id), size));
    }
    this.#requireNode(nodeId);
    const rows = this.#db
      .prepare(
        `SELECT m.id, m.node_id, m.statement, m.memory_type, m.scope_json, m.tier,
              m.event_time, m.valid_from, m.valid_until, m.status, n.canonical_name
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
       WHERE n.status = 'active' AND m.status IN ('active', 'disputed')
         AND m.storage_state = 'indexed' AND m.node_id = ?
       ORDER BY m.node_id, m.tier, m.memory_type, m.scope_json, m.created_at DESC`,
      )
      .all(nodeId) as Row[];
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row.node_id}\u0000${row.tier}\u0000${row.memory_type}\u0000${row.scope_json}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const blocks: LeafBlock[] = [];
    const now = new Date().toISOString();
    const existing = new Map(
      (
        this.#db
          .prepare("SELECT id, created_at, updated_at FROM memory_leaf_blocks WHERE node_id = ?")
          .all(nodeId) as Row[]
      ).map((row) => [
        String(row.id),
        { createdAt: String(row.created_at), updatedAt: String(row.updated_at) },
      ]),
    );
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += size) {
        const members = group.slice(offset, offset + size);
        const id = stableLeafBlockId(members);
        blocks.push({
          id,
          nodeId,
          tier: Number(members[0]!.tier) as MemoryTier,
          summary: leafBlockSummary(members),
          memoryCount: members.length,
          createdAt: existing.get(id)?.createdAt ?? now,
          updatedAt: existing.get(id)?.updatedAt ?? now,
        });
      }
    }
    const desiredIds = new Set(blocks.map((block) => block.id));
    const staleIds = [...existing.keys()].filter((id) => !desiredIds.has(id));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const insertBlock = this.#db.prepare(
        `INSERT INTO memory_leaf_blocks
          (id, node_id, tier, summary, memory_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tier = excluded.tier,
           summary = excluded.summary, memory_count = excluded.memory_count,
           updated_at = excluded.updated_at`,
      );
      const insertMember = this.#db.prepare(
        `INSERT OR IGNORE INTO memory_leaf_members
          (block_id, memory_id, ordinal) VALUES (?, ?, ?)`,
      );
      const membersById = new Map<string, Row[]>();
      for (const group of groups.values()) {
        for (let offset = 0; offset < group.length; offset += size) {
          const members = group.slice(offset, offset + size);
          membersById.set(stableLeafBlockId(members), members);
        }
      }
      for (const block of blocks) {
        insertBlock.run(
          block.id,
          block.nodeId,
          block.tier,
          block.summary,
          block.memoryCount,
          block.createdAt,
          block.updatedAt,
        );
        membersById
          .get(block.id)!
          .forEach((member, ordinal) => insertMember.run(block.id, member.id, ordinal));
      }
      const removeBlock = this.#db.prepare("DELETE FROM memory_leaf_blocks WHERE id = ?");
      for (const id of staleIds) removeBlock.run(id);
      this.#db
        .prepare(
          `INSERT INTO leaf_block_status (node_id, dirty, updated_at) VALUES (?, 0, ?)
         ON CONFLICT(node_id) DO UPDATE SET dirty = 0, updated_at = excluded.updated_at`,
        )
        .run(nodeId, now);
      this.#db.prepare("UPDATE memory_index_delta SET compacted = 1 WHERE node_id = ?").run(nodeId);
      this.#db.exec("COMMIT");
      if (staleIds.length > 0) this.#invalidateVectorCaches("leaf");
      return blocks;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  dirtyLeafNodeIds(): string[] {
    const rows = this.#db
      .prepare("SELECT node_id FROM leaf_block_status WHERE dirty = 1 ORDER BY node_id")
      .all() as Row[];
    return rows.map((row) => String(row.node_id));
  }

  pendingIndexDelta(nodeId?: string, limit = 512): string[] {
    const rows = nodeId
      ? (this.#db
          .prepare(
            `SELECT memory_id FROM memory_index_delta
           WHERE node_id = ? ORDER BY created_at, memory_id LIMIT ?`,
          )
          .all(nodeId, Math.max(1, Math.min(limit, 2_048))) as Row[])
      : (this.#db
          .prepare(
            `SELECT memory_id FROM memory_index_delta
           ORDER BY created_at, memory_id LIMIT ?`,
          )
          .all(Math.max(1, Math.min(limit, 2_048))) as Row[]);
    return rows.map((row) => String(row.memory_id));
  }

  beginEmbeddingIndex(input: {
    indexId: string;
    model: string;
    profile: string;
    targets: Array<"leaves" | "nodes" | "records">;
  }): void {
    beginEmbeddingIndex(this.#db, input);
  }

  completeEmbeddingIndex(indexId: string): void {
    completeEmbeddingIndex(this.#db, indexId);
  }

  failEmbeddingIndex(indexId: string, error: unknown): void {
    failEmbeddingIndex(this.#db, indexId, error);
  }

  embeddingIndexHealth(indexId: string): EmbeddingIndexHealth | null {
    return embeddingIndexHealth(this.#db, indexId);
  }

  /** Deterministic query-time contradiction lookup over claims: for each
   *  given memory id, find one claim pair sharing a canonical predicate_key
   *  with opposite polarity (earlier affirmation vs later denial, ordered by
   *  record rowid and claim index). Both records of the pair receive the
   *  note, since retrieval may surface only the later one. Returns a
   *  human-readable note per memory for the render layer; empty when no
   *  claims metadata exists. */
  contradictionNotes(memoryIds: readonly string[]): Map<string, string> {
    const notes = new Map<string, string>();
    if (memoryIds.length === 0) return notes;
    const stmt = this.#db.prepare(
      `SELECT c1.value ->> 'predicate_key' AS pred_key,
              c1.value ->> 'text' AS own_text,
              c2.value ->> 'text' AS other_text,
              m1.rowid AS own_rowid,
              m2.rowid AS other_rowid
         FROM memory_records m1
         JOIN json_each(m1.claims_json) c1
         JOIN memory_records m2
         JOIN json_each(m2.claims_json) c2
        WHERE m1.id = ?
          AND m2.status IN ('active', 'disputed')
          AND c1.value ->> 'predicate_key' = c2.value ->> 'predicate_key'
          AND c1.value ->> 'polarity' IN ('affirmative', 'negative')
          AND c2.value ->> 'polarity' IN ('affirmative', 'negative')
          AND c1.value ->> 'polarity' <> c2.value ->> 'polarity'
          AND NOT EXISTS (
            SELECT 1
              FROM json_each(m1.scope_json) s1
              JOIN json_each(m2.scope_json) s2 ON s1.key = s2.key
             WHERE CAST(s1.value AS TEXT) <> CAST(s2.value AS TEXT)
          )
          AND (m1.rowid <> m2.rowid OR c1.key < c2.key)
        ORDER BY m2.rowid
        LIMIT 1`,
    );
    for (const id of memoryIds) {
      const row = stmt.get(id) as
        | {
            pred_key: string;
            own_text: string;
            other_text: string;
            own_rowid: number;
            other_rowid: number;
          }
        | undefined;
      if (!row) continue;
      const ownIsEarlier = row.own_rowid <= row.other_rowid;
      const earlierText = ownIsEarlier ? row.own_text : row.other_text;
      const laterText = ownIsEarlier ? row.other_text : row.own_text;
      notes.set(
        id,
        `[NMG note: contradictory memories about '${row.pred_key}': ` +
          `"${earlierText}" vs later "${laterText}" -- flag this to the user.]`,
      );
    }
    return notes;
  }

  rebuildDueLeafBlocks(
    options: {
      deltaThreshold?: number;
      nodeLimit?: number;
      blockSize?: number;
    } = {},
  ): LeafBlock[] {
    const threshold = Math.max(1, options.deltaThreshold ?? 16);
    const nodeLimit = Math.max(1, Math.min(options.nodeLimit ?? 32, 256));
    const rows = this.#db
      .prepare(
        `SELECT d.node_id, COUNT(*) AS delta_count, MIN(d.created_at) AS oldest
       FROM memory_index_delta d
       JOIN memory_nodes n ON n.id = d.node_id
       WHERE n.status = 'active' AND d.compacted = 0
       GROUP BY d.node_id HAVING delta_count >= ?
       ORDER BY oldest, d.node_id LIMIT ?`,
      )
      .all(threshold, nodeLimit) as Row[];
    return rows.flatMap((row) =>
      this.rebuildLeafBlocks(String(row.node_id), options.blockSize ?? 32),
    );
  }

  acknowledgeIndexDelta(nodeIds: readonly string[]): number {
    const ids = [...new Set(nodeIds)];
    if (ids.length === 0) return 0;
    const result = this.#db
      .prepare(
        `DELETE FROM memory_index_delta
       WHERE node_id IN (${ids.map(() => "?").join(",")}) AND compacted = 1`,
      )
      .run(...ids);
    return Number(result.changes);
  }

  leafEmbeddingDocuments(
    afterBlockId = "",
    limit = 256,
    missingModel?: string,
  ): LeafEmbeddingDocument[] {
    const rows = this.#db
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
    const upsert = this.#db.prepare(
      `INSERT INTO leaf_embeddings
        (block_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(block_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
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
      this.#db.exec("COMMIT");
      for (const item of embeddings) {
        this.#updateVectorCache("leaf", model, item.blockId, item.vector);
      }
      return embeddings.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  storedLeafEmbeddings(model: string, afterBlockId = "", limit = 256): ExternalLeafEmbedding[] {
    const rows = this.#db
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
    const rows = this.#db
      .prepare(
        `SELECT b.* FROM memory_leaf_blocks b
       JOIN memory_nodes n ON n.id = b.node_id AND n.status = 'active'
       JOIN leaf_embeddings e ON e.block_id = b.id AND e.model = ?
       WHERE 1 = 1 ${nodeClause} ${blockClause}`,
      )
      .all(model, ...nodes, ...blocks) as Row[];
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const cache = this.#embeddingCache("leaf", model);
    if (!cache) return [];
    return cache
      .score(queryVector, new Set(byId.keys()))
      .map(({ id, score }) => ({ block: mapLeafBlock(byId.get(id)!), score }))
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }

  searchLeafBlocks(
    query: string,
    queryVector: readonly number[],
    model: string,
    blockIds: string[],
    options: SearchOptions = {},
    blockScores?: ReadonlyMap<string, number>,
  ): MemorySearchResult[] {
    const blocks = [...new Set(blockIds)].slice(0, 50);
    if (blocks.length === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT memory_id FROM memory_leaf_members
       WHERE block_id IN (${blocks.map(() => "?").join(",")})
       ORDER BY block_id, ordinal LIMIT 2000`,
      )
      .all(...blocks) as Row[];
    const requestedLimit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const results = this.#searchWithVector(
      query,
      queryVector,
      model,
      {
        ...options,
        limit: blockScores ? 50 : requestedLimit,
        retrievalMode: "fts5",
      },
      rows.map((row) => String(row.memory_id)),
    );
    if (!blockScores) return results;
    const memberships = this.#db
      .prepare(
        `SELECT memory_id, block_id FROM memory_leaf_members
       WHERE block_id IN (${blocks.map(() => "?").join(",")})`,
      )
      .all(...blocks) as Row[];
    const memoryScores = new Map(
      memberships.map((row) => [String(row.memory_id), blockScores.get(String(row.block_id)) ?? 0]),
    );
    for (const result of results) {
      const leafScore = memoryScores.get(result.memory.id) ?? 0;
      result.routeScore = leafScore;
      result.combinedScore = leafScore * 0.9 + result.lexicalScore * 0.1;
    }
    return results
      .sort((left, right) => right.combinedScore - left.combinedScore)
      .slice(0, requestedLimit);
  }

  searchHierarchyByVector(
    query: string,
    queryVector: readonly number[],
    model: string,
    options: SearchOptions = {},
  ): MemorySearchResult[] {
    const nodeLimit = Math.max(1, Math.min(options.nodeCandidateLimit ?? 5, 50));
    const blockLimit = Math.max(1, Math.min(options.leafCandidateLimit ?? 8, 50));
    const nodes = this.routeNodesByVector(queryVector, model, nodeLimit);
    const directLeaves = this.routeLeafBlocksByVector(queryVector, model, [], blockLimit);
    const routedLeaves = this.routeLeafBlocksByVector(
      queryVector,
      model,
      nodes.map((route) => route.node.id),
      blockLimit,
    );
    const leaves = [...directLeaves, ...routedLeaves]
      .filter(
        (route, index, all) =>
          all.findIndex((candidate) => candidate.block.id === route.block.id) === index,
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, blockLimit);
    const indexed = this.searchLeafBlocks(
      query,
      queryVector,
      model,
      leaves.map((route) => route.block.id),
      options,
      new Map(leaves.map((route) => [route.block.id, route.score])),
    );
    const lexical = this.#searchWithVector(query, queryVector, model, {
      ...options,
      limit: Math.min(50, Math.max(options.limit ?? 8, 20)),
      retrievalMode: "fts5",
    });
    return [...indexed, ...lexical]
      .filter(
        (result, index, all) =>
          all.findIndex((candidate) => candidate.memory.id === result.memory.id) === index,
      )
      .sort((left, right) => contextUsefulness(query, right) - contextUsefulness(query, left))
      .slice(0, Math.max(1, Math.min(options.limit ?? 8, 50)));
  }

  searchNodeFirst(
    query: string,
    queryVector: readonly number[],
    model: string,
    nodeIds: string[],
    options: SearchOptions = {},
  ): MemorySearchResult[] {
    const selected = [...new Set(nodeIds)].slice(0, 50);
    if (selected.length === 0) return [];
    const ftsIds = this.#ftsCandidatesInNodes(query, selected, MAX_SEARCH_CANDIDATES);
    const candidateIds =
      ftsIds.length > 0
        ? ftsIds
        : (
            this.#db
              .prepare(
                `SELECT id FROM memory_records
         WHERE node_id IN (${selected.map(() => "?").join(",")})
           AND tier <= ? AND status IN ('active', 'disputed')
           AND storage_state = 'indexed'
         ORDER BY tier ASC, importance DESC, access_count DESC, created_at DESC
         LIMIT ?`,
              )
              .all(...selected, options.maxTier ?? 1, MAX_SEARCH_CANDIDATES) as Row[]
          ).map((row) => String(row.id));
    return this.#searchWithVector(
      query,
      queryVector,
      model,
      {
        ...options,
        retrievalMode: "fts5",
      },
      candidateIds,
    );
  }

  upsertExternalEmbeddings(model: string, embeddings: ExternalEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.#db.prepare(
      `INSERT INTO memory_embeddings
        (memory_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
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
      this.#db.exec("COMMIT");
      return embeddings.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  storedEmbeddings(model: string, afterMemoryId = "", limit = 256): ExternalEmbedding[] {
    const rows = this.#db
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

  #searchWithVector(
    query: string,
    queryVector: readonly number[],
    vectorModel: string,
    options: SearchOptions,
    forcedCandidateIds: string[] = [],
  ): MemorySearchResult[] {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return [];

    const maxTier = options.maxTier ?? 1;
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const nodeName = options.nodeName ? this.#resolveActiveNodeName(options.nodeName) : null;
    const retrievalMode = options.retrievalMode ?? "legacy";
    const ftsIds =
      retrievalMode === "fts5" || retrievalMode === "hybrid"
        ? this.#ftsCandidates(query, MAX_SEARCH_CANDIDATES)
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
    const rows = this.#db
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
        rowLimit,
      ) as Row[];

    const routes =
      retrievalMode === "fts5" || retrievalMode === "hashing" || retrievalMode === "qwen3"
        ? new Map<string, number>()
        : new Map(this.routeNodes(query, 20).map((route) => [route.node.id, route.score]));
    const results = rows
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
      )
      .slice(0, limit);
    for (const result of results) {
      result.memory.evidenceIds = this.#evidenceIds(result.memory.id);
      result.evidenceRecords = this.#evidenceRecords(result.memory.evidenceIds);
    }
    return results;
  }

  recordUsage(memoryIds: string[]): void {
    const uniqueIds = [...new Set(memoryIds)];
    if (uniqueIds.length === 0) return;

    const statement = this.#db.prepare(
      `UPDATE memory_records
       SET access_count = access_count + 1,
           pending_access_count = pending_access_count + 1,
           last_accessed_at = ?
       WHERE id = ?`,
    );
    const now = new Date().toISOString();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of uniqueIds) statement.run(now, id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  archiveSession(input: {
    sessionId: string;
    transcript: string;
    sourceRef?: string;
  }): SessionArchive {
    const sessionId = requireText(input.sessionId, "session id");
    const existing = this.getSessionArchive(sessionId);
    if (existing) {
      const row = this.#db
        .prepare("SELECT content FROM history_records WHERE id = ?")
        .get(existing.historyId) as Row | undefined;
      if (row && String(row.content) === input.transcript) return existing;
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const history = this.appendHistory({
        content: input.transcript,
        role: "session",
        sessionId,
        sourceRef: input.sourceRef,
      });
      const archive: SessionArchive = {
        sessionId,
        historyId: history.id,
        createdAt: history.createdAt,
      };
      this.#db
        .prepare(
          `INSERT INTO session_archives (session_id, history_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           history_id = excluded.history_id,
           created_at = excluded.created_at`,
        )
        .run(archive.sessionId, archive.historyId, archive.createdAt);
      if (existing && existing.historyId !== archive.historyId) {
        this.#db
          .prepare(
            `DELETE FROM history_records
             WHERE id = ?
               AND role = 'session'
               AND NOT EXISTS (
                 SELECT 1 FROM session_archives WHERE history_id = history_records.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM memory_evidence_links WHERE history_id = history_records.id
               )`,
          )
          .run(existing.historyId);
      }
      this.#db.exec("COMMIT");
      return archive;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getSessionArchive(sessionId: string): SessionArchive | null {
    const row = this.#db
      .prepare("SELECT * FROM session_archives WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      historyId: String(row.history_id),
      createdAt: String(row.created_at),
    };
  }

  #requireActiveMemory(memoryId: string): MemoryRecord {
    const row = this.#db
      .prepare("SELECT node_id FROM memory_records WHERE id = ?")
      .get(memoryId) as Row | undefined;
    if (!row) throw new Error(`memory ${memoryId} does not exist`);
    const result = this.#resultsForNode(String(row.node_id), 3, 1, memoryId)[0];
    if (!result) throw new Error(`memory ${memoryId} is not active`);
    return result.memory;
  }

  #refreshNodeResidence(nodeId: string, updatedAt: string): void {
    const hasLongTermMemory = this.#db
      .prepare(
        `SELECT 1 FROM memory_records
         WHERE node_id = ? AND residence = 'ltg'
           AND status IN ('active', 'disputed') LIMIT 1`,
      )
      .get(nodeId);
    const hasLongTermRelation = this.#db
      .prepare(
        `SELECT 1 FROM node_relations
         WHERE status = 'consolidated'
           AND (source_node_id = ? OR target_node_id = ?) LIMIT 1`,
      )
      .get(nodeId, nodeId);
    this.#db
      .prepare("UPDATE memory_nodes SET residence = ?, updated_at = ? WHERE id = ?")
      .run(hasLongTermMemory || hasLongTermRelation ? "ltg" : "stg", updatedAt, nodeId);
  }

  #recordNodeSelections(nodeIds: string[], expandedNodeIds: string[], updatedAt: string): void {
    const selected = new Set(nodeIds);
    const expanded = new Set(expandedNodeIds);
    const upsert = this.#db.prepare(
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

  #recordEdgeSelections(relationIds: readonly string[], updatedAt: string): void {
    const upsert = this.#db.prepare(
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

  #recordNodeOutcomes(
    used: Set<string>,
    contradicted: Set<string>,
    rejected: Set<string>,
    updatedAt: string,
  ): void {
    const upsert = this.#db.prepare(
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

  #recordEdgeOutcomes(
    relationIds: readonly string[],
    used: Set<string>,
    contradicted: Set<string>,
    rejected: Set<string>,
    updatedAt: string,
  ): void {
    const find = this.#db.prepare("SELECT * FROM node_relations WHERE id = ?");
    const upsert = this.#db.prepare(
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
    for (const relationId of new Set(relationIds)) {
      const row = find.get(relationId) as Row | undefined;
      if (!row) continue;
      const relation = mapRelation(row);
      const endpoints = [relation.sourceNodeId, relation.targetNodeId];
      upsert.run(
        relationId,
        endpoints.every((nodeId) => used.has(nodeId)) ? 1 : 0,
        endpoints.some((nodeId) => contradicted.has(nodeId)) ? 1 : 0,
        endpoints.some((nodeId) => rejected.has(nodeId)) ? 1 : 0,
        updatedAt,
      );
    }
  }

  #refreshPairUsefulness(leftNodeId: string, rightNodeId: string): void {
    this.#db
      .prepare(
        `UPDATE node_pair_signals SET useful_count = (
           SELECT COUNT(*) FROM edge_task_observations
           WHERE left_node_id = ? AND right_node_id = ? AND useful = 1
         ) WHERE left_node_id = ? AND right_node_id = ?`,
      )
      .run(leftNodeId, rightNodeId, leftNodeId, rightNodeId);
  }

  #edgeEvidenceTraceIds(leftNodeId: string, rightNodeId: string): string[] {
    return (
      this.#db
        .prepare(
          `SELECT trace_id FROM edge_task_observations
           WHERE left_node_id = ? AND right_node_id = ? AND useful = 1
           ORDER BY created_at DESC LIMIT 32`,
        )
        .all(leftNodeId, rightNodeId) as Row[]
    ).map((row) => String(row.trace_id));
  }

  #recordConsolidationEvent(
    action: ConsolidationEvent["action"],
    targetId: string,
    previousState: string,
    nextState: string,
    reason: string,
    evidenceTraceIds: readonly string[],
    createdAt = new Date().toISOString(),
  ): string {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO consolidation_events
          (id, action, target_id, previous_state, next_state, reason,
           evidence_trace_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        action,
        targetId,
        previousState,
        nextState,
        reason,
        JSON.stringify([...new Set(evidenceTraceIds)]),
        createdAt,
      );
    return id;
  }

  #recordMemoryWriteEvent(input: Omit<MemoryWriteEvent, "createdAt" | "id">): MemoryWriteEvent {
    const event: MemoryWriteEvent = {
      id: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.#db
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

  #requireConsolidationEvent(id: string): ConsolidationEvent {
    const row = this.#db.prepare("SELECT * FROM consolidation_events WHERE id = ?").get(id) as
      Row | undefined;
    if (!row) throw new Error(`consolidation event ${id} does not exist`);
    return mapConsolidationEvent(row);
  }

  #consolidationCoolingDown(targetId: string, cooldownMs: number): boolean {
    const row = this.#db
      .prepare(
        `SELECT created_at FROM consolidation_events
         WHERE target_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(targetId) as Row | undefined;
    return Boolean(row) && Date.now() - Date.parse(String(row!.created_at)) < cooldownMs;
  }

  #requireHistory(historyId: string): HistoryRecord {
    const row = this.#db.prepare("SELECT * FROM history_records WHERE id = ?").get(historyId) as
      Row | undefined;
    if (!row) throw new Error(`history ${historyId} does not exist`);
    return mapHistory(row);
  }

  #upsertFts(memoryId: string, statement: string, nodeId: string, evidenceId: string): void {
    const node = this.#requireNode(nodeId);
    const evidence = this.#requireHistory(evidenceId);
    this.#db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
    this.#db
      .prepare(
        "INSERT INTO memory_fts(memory_id, statement, node_name, evidence) VALUES (?, ?, ?, ?)",
      )
      .run(memoryId, statement, node.canonicalName, evidence.content);
    this.#db
      .prepare("INSERT OR IGNORE INTO memory_fts_registry(memory_id) VALUES (?)")
      .run(memoryId);
  }

  #ftsCandidates(query: string, limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression) return [];
    const rows = this.#db
      .prepare(
        "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?",
      )
      .all(expression, limit) as Row[];
    return rows.map((row) => String(row.memory_id));
  }

  #ftsCandidatesInNodes(query: string, nodeIds: string[], limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression || nodeIds.length === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT f.memory_id FROM memory_fts f
       JOIN memory_records m ON m.id = f.memory_id
       WHERE memory_fts MATCH ? AND m.node_id IN (${nodeIds.map(() => "?").join(",")})
       ORDER BY bm25(memory_fts) LIMIT ?`,
      )
      .all(expression, ...nodeIds, limit) as Row[];
    return rows.map((row) => String(row.memory_id));
  }

  #requireNode(nodeId: string): MemoryNode {
    const row = this.#db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(nodeId) as
      Row | undefined;
    if (!row) throw new Error(`node ${nodeId} does not exist`);
    return mapNode(row);
  }

  #resolveActiveNodeName(canonicalName: string): string {
    const row = this.#db
      .prepare("SELECT * FROM memory_nodes WHERE canonical_name = ?")
      .get(canonicalName) as Row | undefined;
    if (!row) return canonicalName;
    const node = mapNode(row);
    if (node.status === "active") return node.canonicalName;
    const targets = this.#db
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

  #resolveStateKey(requestedKey: string, scope: MemoryScope, node: MemoryNode): string {
    const scopeJson = serializeScope(scope);
    const alias = this.#db
      .prepare(
        `SELECT canonical_key FROM state_key_aliases
       WHERE alias_key = ? AND scope_json = ?`,
      )
      .get(requestedKey, scopeJson) as Row | undefined;
    if (alias) return String(alias.canonical_key);

    const exact = this.#db
      .prepare(
        `SELECT state_key FROM memory_records
       WHERE memory_type = 'state' AND state_key = ? AND scope_json = ?
         AND status = 'active' LIMIT 1`,
      )
      .get(requestedKey, scopeJson) as Row | undefined;
    if (exact) return requestedKey;

    const candidates = this.#db
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
            this.#embedder.embed(requestedIdentity),
            this.#embedder.embed(identity),
          ),
          overlap,
        };
      })
      .filter((candidate) => candidate.score >= 0.65 && candidate.overlap >= 0.7)
      .sort((left, right) => right.score - left.score);
    if (matches.length === 0) return requestedKey;

    const canonicalKey = matches[0]!.key;
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO state_key_aliases
        (alias_key, scope_json, canonical_key, created_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(requestedKey, scopeJson, canonicalKey, new Date().toISOString());
    return canonicalKey;
  }

  #memoryIdsForNodes(nodeIds: string[]): string[] {
    const select = this.#db.prepare("SELECT id FROM memory_records WHERE node_id = ?");
    return nodeIds.flatMap((nodeId) => (select.all(nodeId) as Row[]).map((row) => String(row.id)));
  }

  #createTransform(
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
    this.#db
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

  #redirectRelations(sourceNodeId: string, targetNodeId: string): void {
    const rows = this.#db
      .prepare(
        `SELECT * FROM node_relations
       WHERE source_node_id = ? OR target_node_id = ?`,
      )
      .all(sourceNodeId, sourceNodeId) as Row[];
    const remove = this.#db.prepare("DELETE FROM node_relations WHERE id = ?");
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

  #memoryText(memory: Pick<MemoryRecord, "statement">, nodeId: string): string {
    const node = this.#requireNode(nodeId);
    return memoryEmbeddingText(memory.statement, node.canonicalName);
  }

  #upsertEmbedding(memoryId: string, text: string): void {
    const vector = this.#embedder.embed(text);
    this.#db
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
        this.#embedder.model,
        this.#embedder.dimensions,
        JSON.stringify(vector),
        encodeVector(vector),
        new Date().toISOString(),
      );
  }

  #refreshEmbeddings(memoryIds: string[]): void {
    const select = this.#db.prepare(
      `SELECT m.id, m.statement, m.node_id, n.canonical_name, n.summary
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id WHERE m.id = ?`,
    );
    for (const memoryId of memoryIds) {
      const row = select.get(memoryId) as Row | undefined;
      if (row)
        this.#upsertEmbedding(memoryId, memoryEmbeddingText(row.statement, row.canonical_name));
    }
  }

  #nodeIdsForMemories(memoryIds: readonly string[]): string[] {
    const ids = [...new Set(memoryIds)];
    if (ids.length === 0) return [];
    return (
      this.#db
        .prepare(
          `SELECT DISTINCT node_id FROM memory_records
       WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids) as Row[]
    ).map((row) => String(row.node_id));
  }

  #proposalCoolingDown(proposalKey: string, cooldownMs: number): boolean {
    const row = this.#db
      .prepare(
        `SELECT created_at FROM topology_proposals
       WHERE proposal_key = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(proposalKey) as Row | undefined;
    return Boolean(row) && Date.now() - Date.parse(String(row!.created_at)) < cooldownMs;
  }

  #candidatePartitions(nodeId: string): Array<{ label: string; memoryIds: string[] }> {
    const rows = this.#db
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

  #insertTopologyProposal(
    proposal: Omit<TopologyProposal, "createdAt" | "id" | "status">,
  ): TopologyProposal {
    const result: TopologyProposal = {
      ...proposal,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.#db
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

  #embeddingCache(kind: "leaf" | "node", model: string): Float32VectorCache | null {
    const key = `${kind}:${model}`;
    const existing = this.#vectorCaches.get(key);
    if (existing) return existing;
    const table = kind === "node" ? "node_embeddings" : "leaf_embeddings";
    const idColumn = kind === "node" ? "node_id" : "block_id";
    const rows = this.#db
      .prepare(
        `SELECT ${idColumn} AS id, dimensions, vector_blob, vector_json
       FROM ${table} WHERE model = ? ORDER BY ${idColumn}`,
      )
      .all(model) as Row[];
    if (rows.length === 0) return null;
    const dimensions = Number(rows[0]!.dimensions);
    const cache = new Float32VectorCache(dimensions, rows.length);
    for (const row of rows) cache.upsert(String(row.id), storedVector(row));
    this.#vectorCaches.set(key, cache);
    return cache;
  }

  #updateVectorCache(
    kind: "leaf" | "node",
    model: string,
    id: string,
    vector: readonly number[],
  ): void {
    this.#vectorCaches.get(`${kind}:${model}`)?.upsert(id, vector);
  }

  #invalidateVectorCaches(kind: "leaf" | "node"): void {
    for (const key of this.#vectorCaches.keys()) {
      if (key.startsWith(`${kind}:`)) this.#vectorCaches.delete(key);
    }
  }

  #markIndexDelta(
    memoryId: string,
    nodeId: string,
    operation: "move" | "upsert",
    createdAt = new Date().toISOString(),
  ): void {
    this.#db
      .prepare(
        `INSERT INTO memory_index_delta
        (memory_id, node_id, operation, compacted, created_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(memory_id) DO UPDATE SET node_id = excluded.node_id,
         operation = excluded.operation, compacted = 0,
         created_at = excluded.created_at`,
      )
      .run(memoryId, nodeId, operation, createdAt);
    this.#db
      .prepare(
        `INSERT INTO leaf_block_status (node_id, dirty, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
      )
      .run(nodeId, createdAt);
  }

  #evidenceIds(memoryId: string): string[] {
    return (
      this.#db
        .prepare(
          `SELECT history_id FROM memory_evidence_links
         WHERE memory_id = ? ORDER BY history_id`,
        )
        .all(memoryId) as Row[]
    ).map((row) => String(row.history_id));
  }

  #resultsForNode(
    nodeId: string,
    maxTier: MemoryTier,
    limit: number,
    memoryId?: string,
    sourceActor?: MemoryActor,
  ): MemorySearchResult[] {
    const rows = this.#db
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
      result.memory.evidenceIds = this.#evidenceIds(result.memory.id);
      result.evidenceRecords = this.#evidenceRecords(result.memory.evidenceIds);
      return result;
    });
  }

  #evidenceRecords(ids: string[]): HistoryRecord[] {
    const statement = this.#db.prepare("SELECT * FROM history_records WHERE id = ?");
    return ids.flatMap((id) => {
      const row = statement.get(id) as Row | undefined;
      return row ? [mapHistory(row)] : [];
    });
  }
}

function mapNode(row: Row, prefix = ""): MemoryNode {
  return {
    id: String(row[`${prefix}id`]),
    canonicalName: String(row[`${prefix}canonical_name`]),
    kind: String(row[`${prefix}kind`]) as MemoryNodeKind,
    summary: String(row[`${prefix}summary`]),
    createdAt: String(row[`${prefix}created_at`]),
    updatedAt: String(row[`${prefix}updated_at`]),
    status: String(row[`${prefix}status`] ?? "active") as MemoryNode["status"],
    residence: String(row[`${prefix}residence`] ?? "ltg") as MemoryResidence,
  };
}

function canonicalNodeIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function mapLeafBlock(row: Row): LeafBlock {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    tier: Number(row.tier) as MemoryTier,
    summary: String(row.summary),
    memoryCount: Number(row.memory_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTopologyProposal(row: Row): TopologyProposal {
  let partitions: TopologyProposal["partitions"] = [];
  try {
    const parsed = JSON.parse(String(row.partitions_json)) as unknown;
    if (Array.isArray(parsed)) {
      partitions = parsed.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const candidate = item as { label?: unknown; memoryIds?: unknown };
        return typeof candidate.label === "string" && Array.isArray(candidate.memoryIds)
          ? [
              {
                label: candidate.label,
                memoryIds: candidate.memoryIds.filter((id): id is string => typeof id === "string"),
              },
            ]
          : [];
      });
    }
  } catch {
    partitions = [];
  }
  return {
    id: String(row.id),
    proposalKey: String(row.proposal_key),
    type: String(row.proposal_type) as TopologyProposal["type"],
    sourceNodeIds: parseStringArray(row.source_node_ids_json),
    relationType: row.relation_type ? (String(row.relation_type) as NodeRelationType) : null,
    partitions,
    evidenceTraceIds: parseStringArray(row.evidence_trace_ids_json),
    observations: Number(row.observations),
    estimatedGain: Number(row.estimated_gain),
    status: String(row.status) as TopologyProposal["status"],
    createdAt: String(row.created_at),
  };
}

function partitionLabel(label: string, index: number): string {
  const [memoryType, scope = ""] = label.split("|", 2);
  try {
    const parsed = JSON.parse(scope) as Record<string, unknown>;
    const scopeLabel = Object.values(parsed)
      .filter((value) => typeof value === "string")
      .join(" ");
    return [memoryType, scopeLabel].filter(Boolean).join(" ") || `partition ${index + 1}`;
  } catch {
    return memoryType || `partition ${index + 1}`;
  }
}

function leafBlockSummary(rows: Row[]): string {
  const first = rows[0]!;
  const scope = parseScope(first.scope_json);
  const scopeText = Object.entries(scope)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const times = rows
    .flatMap((row) => [row.event_time, row.valid_from, row.valid_until])
    .filter((value): value is string | number => value !== null)
    .map(String)
    .sort();
  const sample = rows
    .slice(0, 8)
    .map((row) => String(row.statement).trim())
    .filter(Boolean)
    .join("; ")
    .slice(0, 1_500);
  return [
    `node=${first.canonical_name}`,
    `type=${first.memory_type}`,
    `tier=${first.tier}`,
    scopeText ? `scope=${scopeText}` : "",
    times.length > 0 ? `time=${times[0]}..${times[times.length - 1]}` : "",
    `count=${rows.length}`,
    `examples=${sample}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

function stableLeafBlockId(rows: Row[]): string {
  const identity = rows
    .map((row) => [
      row.id,
      row.statement,
      row.memory_type,
      row.scope_json,
      row.tier,
      row.event_time,
      row.valid_from,
      row.valid_until,
    ])
    .join("\u0000");
  return `leaf_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function mapSearchResult(row: Row, score: number): MemorySearchResult {
  return {
    memory: {
      id: String(row.m_id),
      nodeId: String(row.m_node_id),
      evidenceId: String(row.m_evidence_id),
      evidenceIds: [String(row.m_evidence_id)],
      statement: String(row.m_statement),
      memoryType: String(row.m_memory_type) as MemoryRecord["memoryType"],
      stateKey: row.m_state_key ? String(row.m_state_key) : null,
      eventTime: row.m_event_time ? String(row.m_event_time) : null,
      sourceActor: String(row.m_source_actor) as MemoryRecord["sourceActor"],
      truthStatus: String(row.m_truth_status) as MemoryRecord["truthStatus"],
      confidence:
        row.m_confidence === null || row.m_confidence === undefined
          ? null
          : Number(row.m_confidence),
      polarity: row.m_polarity ? (String(row.m_polarity) as MemoryRecord["polarity"]) : null,
      predicateKey: row.m_predicate_key ? String(row.m_predicate_key) : null,
      extractMethod: row.m_extract_method
        ? (String(row.m_extract_method) as MemoryRecord["extractMethod"])
        : null,
      claims: parseClaims(row.m_claims_json),
      markers: parseMarkers(row.m_markers_json),
      scope: parseScope(row.m_scope_json),
      validFrom: row.m_valid_from ? String(row.m_valid_from) : null,
      validUntil: row.m_valid_until ? String(row.m_valid_until) : null,
      status: String(row.m_status) as MemoryStatus,
      residence: String(row.m_residence ?? "ltg") as MemoryResidence,
      promotedAt: row.m_promoted_at ? String(row.m_promoted_at) : null,
      expiresAt: row.m_expires_at ? String(row.m_expires_at) : null,
      evidenceRole: String(row.m_evidence_role) as MemoryRecord["evidenceRole"],
      supersedesId: row.m_supersedes_id ? String(row.m_supersedes_id) : null,
      tier: Number(row.m_tier) as MemoryTier,
      importance: Number(row.m_importance),
      accessCount: Number(row.m_access_count),
      lastAccessedAt: row.m_last_accessed_at ? String(row.m_last_accessed_at) : null,
      writeReason: String(row.m_write_reason ?? "legacy_write"),
      writeSource: String(row.m_write_source ?? "core") as MemoryRecord["writeSource"],
      createdAt: String(row.m_created_at),
    },
    node: mapNode(row, "n_"),
    evidence: {
      id: String(row.h_id),
      sessionId: row.h_session_id ? String(row.h_session_id) : null,
      sourceMessageId: row.h_source_message_id ? String(row.h_source_message_id) : null,
      role: String(row.h_role) as HistoryRole,
      content: String(row.h_content),
      sourceRef: row.h_source_ref ? String(row.h_source_ref) : null,
      createdAt: String(row.h_created_at),
    },
    evidenceRecords: [],
    lexicalScore: score,
    vectorScore: 0,
    routeScore: 0,
    combinedScore: score,
  };
}

function mapHistory(row: Row): HistoryRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id ? String(row.session_id) : null,
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
    role: String(row.role) as HistoryRole,
    content: String(row.content),
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    createdAt: String(row.created_at),
  };
}

function mapRelation(row: Row): NodeRelation {
  return {
    id: String(row.id),
    sourceNodeId: String(row.source_node_id),
    targetNodeId: String(row.target_node_id),
    type: String(row.relation_type) as NodeRelationType,
    evidenceIds: parseStringArray(row.evidence_ids_json),
    residence: "ltg",
    status: String(row.status ?? "consolidated") as NodeRelation["status"],
    stability: Number(row.stability ?? 1),
    consolidationSource: String(
      row.consolidation_source ?? "explicit",
    ) as NodeRelation["consolidationSource"],
    consolidatedAt: String(row.consolidated_at ?? row.created_at),
    createdAt: String(row.created_at),
  };
}

function mapConsolidationEvent(row: Row): ConsolidationEvent {
  return {
    id: String(row.id),
    action: String(row.action) as ConsolidationEvent["action"],
    targetId: String(row.target_id),
    previousState: String(row.previous_state),
    nextState: String(row.next_state),
    reason: String(row.reason),
    evidenceTraceIds: parseStringArray(row.evidence_trace_ids_json),
    createdAt: String(row.created_at),
  };
}

function mapMemoryWriteEvent(row: Row): MemoryWriteEvent {
  return {
    id: String(row.id),
    memoryId: row.memory_id ? String(row.memory_id) : null,
    historyId: row.history_id ? String(row.history_id) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    decision: String(row.decision) as MemoryWriteEvent["decision"],
    policyReason: String(row.policy_reason),
    writeReason: String(row.write_reason),
    writeSource: String(row.write_source) as MemoryWriteEvent["writeSource"],
    memoryType: String(row.memory_type) as MemoryWriteEvent["memoryType"],
    requestedResidence: String(row.requested_residence) as MemoryWriteEvent["requestedResidence"],
    createdAt: String(row.created_at),
  };
}

function mapActivation(row: Row | undefined, hasExpanded: boolean): ActivationSignal {
  const selectedCount = Number(row?.selected_count ?? 0);
  const expandedCount = hasExpanded ? Number(row?.expanded_count ?? 0) : 0;
  const usedCount = Number(row?.used_count ?? 0);
  const contradictedCount = Number(row?.contradicted_count ?? 0);
  const rejectedCount = Number(row?.rejected_count ?? 0);
  const updatedAt = row?.updated_at ? String(row.updated_at) : new Date(0).toISOString();
  const positive = selectedCount * 0.1 + expandedCount * 0.15 + usedCount;
  const negative = contradictedCount * 0.8 + rejectedCount * 0.4;
  const normalized = clamp((positive - negative) / (1 + positive + negative), 0, 1);
  const ageDays = Math.max(0, (Date.now() - Date.parse(updatedAt)) / 86_400_000);
  const score = normalized * 0.5 ** (ageDays / 30);
  return {
    selectedCount,
    expandedCount,
    usedCount,
    contradictedCount,
    rejectedCount,
    score,
    updatedAt,
  };
}

function identityTokens(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2 && token !== "time"),
  );
}

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function defaultResidence(input: {
  memoryType?: MemoryRecord["memoryType"];
  sourceActor?: MemoryRecord["sourceActor"];
  truthStatus?: MemoryRecord["truthStatus"];
}): MemoryResidence {
  const type = input.memoryType ?? "fact";
  if (type === "derived" || input.truthStatus === "inferred") return "stg";
  if (input.sourceActor === "assistant" && input.truthStatus === "unverified") return "stg";
  return "ltg";
}

function defaultWriteReason(
  input: { memoryType?: MemoryRecord["memoryType"]; truthStatus?: MemoryRecord["truthStatus"] },
  residence: MemoryResidence,
): string {
  const type = input.memoryType ?? "fact";
  if (residence === "stg") return `provisional_${type}:${input.truthStatus ?? "asserted"}`;
  return `governed_durable_${type}`;
}

function parseScope(value: string | number | Uint8Array | null): MemoryScope {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value) as MemoryScope;
  } catch {
    return {};
  }
}

function parseStoredJson<T>(value: string | number | Uint8Array | null, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Read the shadow QPP decision; undefined for pre-QPP or empty rows. */
function parseQppDecision(
  value: string | number | Uint8Array | null,
): QppTriggerDecision | undefined {
  const parsed = parseStoredJson<QppTriggerDecision | null>(value, null);
  return parsed && typeof (parsed as { qpp?: unknown }).qpp === "number" ? parsed : undefined;
}

type StoredClaim = {
  text: string;
  polarity: MemoryRecord["polarity"];
  predicate_key: string | null;
  confidence: number | null;
  extract_method: NonNullable<MemoryRecord["extractMethod"]>;
};

/** On-disk claims format is snake_case (shared with the Python extraction
 *  worker); the in-memory MemoryClaim shape is camelCase. */
function serializeClaims(claims: MemoryRecord["claims"]): string | null {
  if (!claims) return null;
  const stored: StoredClaim[] = claims.map((claim) => ({
    text: claim.text,
    polarity: claim.polarity,
    predicate_key: claim.predicateKey,
    confidence: claim.confidence,
    extract_method: claim.extractMethod,
  }));
  return JSON.stringify(stored);
}

function parseClaims(value: string | number | Uint8Array | null): MemoryRecord["claims"] {
  const stored = parseStoredJson<StoredClaim[] | null>(value, null);
  if (!stored) return null;
  return stored.map((claim) => ({
    text: claim.text,
    polarity: claim.polarity ?? null,
    predicateKey: claim.predicate_key ?? null,
    confidence: claim.confidence ?? null,
    extractMethod: claim.extract_method,
  }));
}

function normalizeMarkers(markers: readonly MemoryMarker[] | undefined): MemoryMarker[] {
  if (!markers) return [];
  const normalized = markers.flatMap((marker) => {
    const kind = marker.kind?.trim();
    if (!kind) return [];
    const attributes = marker.attributes
      ? Object.fromEntries(
          Object.entries(marker.attributes)
            .filter(
              ([, value]) =>
                value === null ||
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean",
            )
            .sort(([left], [right]) => left.localeCompare(right)),
        )
      : undefined;
    return [{ kind, ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}) }];
  });
  return [...new Map(normalized.map((marker) => [JSON.stringify(marker), marker])).values()];
}

function serializeMarkers(markers: readonly MemoryMarker[]): string {
  return JSON.stringify(normalizeMarkers(markers));
}

function parseMarkers(value: string | number | Uint8Array | null): MemoryMarker[] {
  const stored = parseStoredJson<unknown>(value, []);
  if (!Array.isArray(stored)) return [];
  return normalizeMarkers(
    stored.filter(
      (marker): marker is MemoryMarker =>
        Boolean(marker) &&
        typeof marker === "object" &&
        typeof (marker as { kind?: unknown }).kind === "string",
    ),
  );
}

function matchesScope(memory: MemoryScope, requested?: MemoryScope): boolean {
  if (!requested) return true;
  return Object.entries(requested).every(([key, value]) => memory[key] === value);
}

function serializeScope(scope: MemoryScope): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))),
  );
}
