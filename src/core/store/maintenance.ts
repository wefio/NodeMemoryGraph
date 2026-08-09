/**
 * maintenance cluster of NmgStore methods — official TypeScript mixin pattern
 * (docs/store-cluster-split.md, cluster-dag.test.ts).
 *
 * The mixin adds the cluster's methods to any base class; store.ts assembles
 * NmgStore = withGraph(withRetrieval(withWrites(withMaintenance(Base)))).
 * Method bodies use `this.` exactly as they did in the monolith: the final
 * class's prototype chain resolves cross-cluster and base-helper calls.
 * Cluster files import no store code — types and utilities only, so the
 * module graph stays acyclic (DAG).
 */
import { randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";
import type {
  ClaimOutcomeEvent,
  ClaimPosterior,
  ConsolidationEvent,
  EmbeddingIndexHealth,
  HistoryRecord,
  LeafBlock,
  MaintenanceBatchResult,
  MemoryNode,
  MemoryNodeKind,
  MemoryRecord,
  MemoryResidence,
  MemoryStatus,
  MemoryStorageState,
  MemoryTier,
  MemoryWriteEvent,
  PerfAggregate,
  RebalanceResult,
  RecordClaimOutcomesInput,
  RetentionCandidate,
  RetentionPolicy,
  RetrievalTrace,
  RetrievalTraceInput,
  VectorEmbedder,
} from "../types.ts";
import { PerfTimer, SECTION, nowMs } from "../perf.ts";
import { DEFAULT_RETENTION_POLICY } from "./graph-policy.ts";

import { blockTiers, huffmanDepths } from "../hierarchy.ts";
import { Float32VectorCache } from "../vector-cache.ts";

import { activeGraphBudget, stableTaskId } from "./active-graph.ts";
import {
  beginEmbeddingIndex,
  completeEmbeddingIndex,
  embeddingIndexHealth,
  failEmbeddingIndex,
} from "./embedding-index.ts";
import { parseNumberArray, parseStringArray } from "./row-parse.ts";
import {
  canonicalNodeIdentity,
  clamp,
  leafBlockSummary,
  mapHistory,
  mapMemoryWriteEvent,
  mapNode,
  parseClaims,
  parseMarkers,
  parseQppDecision,
  parseScope,
  parseStoredJson,
  requireText,
  stableLeafBlockId,
} from "./rows.ts";
import { hierarchyWeight, memoryEmbeddingText, type StoreRow as Row } from "./search-ranking.ts";
import { encodeVector } from "./vector-codec.ts";

import type { Constructor } from "./store-ctor.ts";

export function withMaintenance<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    declare protected recordPerfAggregates: (
      timings: import("../types.ts").PerfSnapshot | undefined,
    ) => void;
    // Base-class members (provided by constructor)
    declare protected db: DatabaseSync;
    declare protected embedder: VectorEmbedder;
    declare protected vectorCaches: Map<string, Float32VectorCache>;

    // base-helper / cross-cluster members (resolved at assembly time)
    declare protected cascadeDerivedMemories: (sourceMemoryId: string) => void;
    declare protected upsertFts: (
      memoryId: string,
      statement: string,
      nodeId: string,
      evidenceId: string,
    ) => void;
    declare protected markIndexDelta: (
      memoryId: string,
      nodeId: string,
      operation: string,
      createdAt: string,
    ) => void;
    declare protected requireActiveMemory: (memoryId: string) => MemoryRecord;
    declare protected refreshNodeResidence: (nodeId: string, updatedAt: string) => void;
    declare protected requireNode: (nodeId: string) => MemoryNode;
    declare protected invalidateVectorCaches: (kind: "leaf" | "node") => void;
    declare protected nodeIdsForMemories: (memoryIds: readonly string[]) => string[];
    declare protected recordNodeSelections: (
      nodeIds: string[],
      expandedNodeIds: string[],
      updatedAt: string,
    ) => void;
    declare protected recordEdgeSelections: (
      relationIds: readonly string[],
      updatedAt: string,
    ) => void;
    declare protected refreshPairUsefulness: (leftNodeId: string, rightNodeId: string) => void;
    declare protected assertTraceOwner: (row: Row, sessionId?: string) => void;
    declare protected recordNodeOutcomes: (
      used: Set<string>,
      contradicted: Set<string>,
      rejected: Set<string>,
      updatedAt: string,
    ) => void;
    declare protected recordEdgeOutcomes: (
      relationIds: readonly string[],
      used: Set<string>,
      contradicted: Set<string>,
      rejected: Set<string>,
      updatedAt: string,
    ) => void;
    // cross-cluster (writes / graph)
    declare recordUsage: (memoryIds: string[]) => void;
    declare trainRouter: (query: string, usefulNodeIds: string[], learningRate?: number) => void;
    declare reconcileConsolidation: (options?: {
      pairs?: readonly (readonly [string, string])[];
    }) => unknown;

    /**
     * Record strong, independently attributable outcomes for atomic claims.
     *
     * Retrieval and rendering are deliberately insufficient: callers must
     * provide an explicit supported/contradicted result and semantic task ID.
     * The UNIQUE task key prevents repeated turns from self-reinforcing the
     * same claim. Posteriors are shadow metadata until a calibrated retrieval
     * policy explicitly consumes them.
     */
    recordClaimOutcomes(input: RecordClaimOutcomesInput): {
      events: ClaimOutcomeEvent[];
      posteriors: ClaimPosterior[];
    } {
      const semanticTaskId = requireText(input.semanticTaskId, "semanticTaskId");
      if (input.votes.length === 0) return { events: [], posteriors: [] };
      let permittedMemoryIds: Set<string> | null = null;
      if (input.activeGraphId) {
        const trace = this.db
          .prepare("SELECT * FROM retrieval_traces WHERE id = ?")
          .get(input.activeGraphId) as Row | undefined;
        if (!trace) throw new Error(`active graph ${input.activeGraphId} does not exist`);
        this.assertTraceOwner(trace, input.sessionId);
        permittedMemoryIds = new Set(parseStringArray(trace.result_memory_ids_json));
      }

      const seen = new Map<string, string>();
      const prepared: Array<{
        memoryId: string;
        claimIndex: number;
        claimText: string;
        priorConfidence: number;
        outcome: "supported" | "contradicted";
        source: ClaimOutcomeEvent["source"];
        sourceLineage: string;
        weight: number;
      }> = [];
      for (const vote of input.votes) {
        if (permittedMemoryIds && !permittedMemoryIds.has(vote.memoryId)) {
          throw new Error(
            `memory ${vote.memoryId} was not exposed by active graph ${input.activeGraphId}`,
          );
        }
        const row = this.db
          .prepare("SELECT statement, confidence, claims_json FROM memory_records WHERE id = ?")
          .get(vote.memoryId) as Row | undefined;
        if (!row) throw new Error(`memory ${vote.memoryId} does not exist`);
        const claims = parseClaims(row.claims_json) ?? [
          {
            text: String(row.statement),
            confidence: row.confidence == null ? null : Number(row.confidence),
            polarity: null,
            predicateKey: null,
            extractMethod: "rule" as const,
          },
        ];
        const indexes = vote.claimIndexes ?? claims.map((_, index) => index);
        if (indexes.length === 0) throw new Error("claimIndexes must not be empty");
        const weight = vote.weight ?? 1;
        if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
          throw new Error("claim outcome weight must be in (0,1]");
        }
        const sourceLineage = requireText(vote.sourceLineage, "sourceLineage");
        for (const claimIndex of [...new Set(indexes)]) {
          const claim = claims[claimIndex];
          if (!claim || !Number.isInteger(claimIndex) || claimIndex < 0) {
            throw new Error(`claim index ${claimIndex} does not exist on memory ${vote.memoryId}`);
          }
          const key = `${vote.memoryId}\0${claimIndex}`;
          const previous = seen.get(key);
          if (previous && previous !== vote.outcome) {
            throw new Error(`conflicting claim outcomes in one task for memory ${vote.memoryId}`);
          }
          seen.set(key, vote.outcome);
          prepared.push({
            memoryId: vote.memoryId,
            claimIndex,
            claimText: claim.text,
            priorConfidence: clamp(claim.confidence ?? Number(row.confidence ?? 0.5), 0, 1),
            outcome: vote.outcome,
            source: vote.source,
            sourceLineage,
            weight,
          });
        }
      }

      const events: ClaimOutcomeEvent[] = [];
      const touched = new Set<string>();
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of prepared) {
          const id = randomUUID();
          const inserted = this.db
            .prepare(
              `INSERT OR IGNORE INTO claim_outcome_events
                (id, memory_id, claim_index, semantic_task_id, source,
                 source_lineage, outcome, weight, active_graph_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              item.memoryId,
              item.claimIndex,
              semanticTaskId,
              item.source,
              item.sourceLineage,
              item.outcome,
              item.weight,
              input.activeGraphId ?? null,
              now,
            );
          if (Number(inserted.changes) === 0) continue;
          const priorStrength = 2;
          this.db
            .prepare(
              `INSERT OR IGNORE INTO claim_posteriors
                (memory_id, claim_index, claim_text, prior_confidence, alpha,
                 beta, independent_vote_count, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
            )
            .run(
              item.memoryId,
              item.claimIndex,
              item.claimText,
              item.priorConfidence,
              1 + priorStrength * item.priorConfidence,
              1 + priorStrength * (1 - item.priorConfidence),
              now,
            );
          this.db
            .prepare(
              `UPDATE claim_posteriors
               SET alpha = alpha + ?, beta = beta + ?,
                   independent_vote_count = independent_vote_count + 1,
                   updated_at = ?
               WHERE memory_id = ? AND claim_index = ?`,
            )
            .run(
              item.outcome === "supported" ? item.weight : 0,
              item.outcome === "contradicted" ? item.weight : 0,
              now,
              item.memoryId,
              item.claimIndex,
            );
          events.push({
            id,
            memoryId: item.memoryId,
            claimIndex: item.claimIndex,
            semanticTaskId,
            source: item.source,
            sourceLineage: item.sourceLineage,
            outcome: item.outcome,
            weight: item.weight,
            activeGraphId: input.activeGraphId ?? null,
            createdAt: now,
          });
          touched.add(item.memoryId);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return {
        events,
        posteriors: [...touched].flatMap((memoryId) => this.claimPosteriors(memoryId)),
      };
    }

    claimPosteriors(memoryId: string): ClaimPosterior[] {
      return (
        this.db
          .prepare(`SELECT * FROM claim_posteriors WHERE memory_id = ? ORDER BY claim_index`)
          .all(memoryId) as Row[]
      ).map(mapClaimPosterior);
    }

    claimOutcomeEvents(memoryId: string): ClaimOutcomeEvent[] {
      return (
        this.db
          .prepare(
            `SELECT * FROM claim_outcome_events WHERE memory_id = ?
             ORDER BY created_at, rowid`,
          )
          .all(memoryId) as Row[]
      ).map((row) => ({
        id: String(row.id),
        memoryId: String(row.memory_id),
        claimIndex: Number(row.claim_index),
        semanticTaskId: String(row.semantic_task_id),
        source: String(row.source) as ClaimOutcomeEvent["source"],
        sourceLineage: String(row.source_lineage),
        outcome: String(row.outcome) as ClaimOutcomeEvent["outcome"],
        weight: Number(row.weight),
        activeGraphId: row.active_graph_id ? String(row.active_graph_id) : null,
        createdAt: String(row.created_at),
      }));
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
      const row = this.db
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
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE memory_records SET status = 'deleted' WHERE id = ?").run(memoryId);
        this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
        this.db.prepare("DELETE FROM memory_fts_registry WHERE memory_id = ?").run(memoryId);
        this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
        this.db.prepare("DELETE FROM memory_index_delta WHERE memory_id = ?").run(memoryId);
        this.db.prepare("DELETE FROM claim_outcome_events WHERE memory_id = ?").run(memoryId);
        this.db.prepare("DELETE FROM claim_posteriors WHERE memory_id = ?").run(memoryId);
        this.db.prepare("DELETE FROM memory_evidence_links WHERE memory_id = ?").run(memoryId);
        this.db.prepare("DELETE FROM memory_leaf_members WHERE memory_id = ?").run(memoryId);
        const traceRows = this.db
          .prepare(
            `SELECT id, result_memory_ids_json, useful_memory_ids_json,
                    contradicted_memory_ids_json, rejected_memory_ids_json
             FROM retrieval_traces`,
          )
          .all() as Row[];
        const updateTrace = this.db.prepare(
          `UPDATE retrieval_traces
           SET result_memory_ids_json = ?, useful_memory_ids_json = ?,
               contradicted_memory_ids_json = ?, rejected_memory_ids_json = ?
           WHERE id = ?`,
        );
        for (const trace of traceRows) {
          const withoutDeleted = (value: unknown) =>
            JSON.stringify(
              parseStringArray(value as string | null).filter((id) => id !== memoryId),
            );
          updateTrace.run(
            withoutDeleted(trace.result_memory_ids_json),
            withoutDeleted(trace.useful_memory_ids_json),
            withoutDeleted(trace.contradicted_memory_ids_json),
            withoutDeleted(trace.rejected_memory_ids_json),
            String(trace.id),
          );
        }
        const proposalRows = this.db
          .prepare(
            `SELECT id, evidence_memory_ids_json FROM topology_proposals
             WHERE status = 'pending'`,
          )
          .all() as Row[];
        const rejectProposal = this.db.prepare(
          "UPDATE topology_proposals SET status = 'rejected' WHERE id = ?",
        );
        for (const proposal of proposalRows) {
          if (
            parseStringArray(proposal.evidence_memory_ids_json as string | null).includes(memoryId)
          ) {
            rejectProposal.run(String(proposal.id));
          }
        }
        this.db
          .prepare(
            `INSERT INTO leaf_block_status (node_id, dirty, updated_at)
             VALUES (?, 1, ?)
             ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
          )
          .run(memory.nodeId, now);
        for (const key of this.vectorCaches.keys()) {
          this.vectorCaches.get(key)?.remove(memoryId);
        }
        this.cascadeDerivedMemories(memoryId);
        this.db.exec("COMMIT");
        return memory;
      } catch (error) {
        this.db.exec("ROLLBACK");
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
      const row = this.db
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
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE memory_records
             SET storage_state = ?, retention_changed_at = ?, quarantine_until = ?
             WHERE id = ?`,
          )
          .run(target, now.toISOString(), quarantineUntil, memoryId);
        if (target === "indexed") {
          this.upsertFts(
            memoryId,
            String(row.statement),
            String(row.node_id),
            String(row.evidence_id),
          );
          this.markIndexDelta(memoryId, String(row.node_id), "upsert", now.toISOString());
        } else {
          this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
          this.db.prepare("DELETE FROM memory_fts_registry WHERE memory_id = ?").run(memoryId);
          this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
          this.db.prepare("DELETE FROM memory_index_delta WHERE memory_id = ?").run(memoryId);
          this.db.prepare("DELETE FROM memory_leaf_members WHERE memory_id = ?").run(memoryId);
          this.db
            .prepare(
              `INSERT INTO leaf_block_status (node_id, dirty, updated_at)
               VALUES (?, 1, ?)
               ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
            )
            .run(row.node_id, now.toISOString());
          for (const cache of this.vectorCaches.values()) cache.remove(memoryId);
        }
        this.db.exec("COMMIT");
        return target;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    /**
     * Produce a conservative dry-run report. Callers must explicitly apply the
     * returned transitions; this method never archives or deletes content.
     */
    retentionCandidates(policy: RetentionPolicy = {}): RetentionCandidate[] {
      const now = policy.now ?? new Date();
      const dormantAfterDays = Math.max(
        1,
        policy.dormantAfterDays ?? DEFAULT_RETENTION_POLICY.dormantAfterDays,
      );
      const quarantineAfterDays = Math.max(
        1,
        policy.quarantineAfterDays ?? DEFAULT_RETENTION_POLICY.quarantineAfterDays,
      );
      const maximumImportance = clamp(
        policy.maximumImportance ?? DEFAULT_RETENTION_POLICY.maximumImportance,
        0,
        1,
      );
      const maximumAccessCount = Math.max(
        0,
        policy.maximumAccessCount ?? DEFAULT_RETENTION_POLICY.maximumAccessCount,
      );
      const rows = this.db
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

    promoteMemory(
      memoryId: string,
      reason: string,
      evidenceTraceIds: readonly string[] = [],
    ): MemoryRecord {
      const memory = this.requireActiveMemory(memoryId);
      if (memory.residence === "ltg") return memory;
      // Loop guard (docs/stg-isolated-store.md §3): a cached_from_ltg memory is
      // already LTG content — promoting it would create a copy cycle. Refuse.
      if (memory.markers.some((marker) => marker.kind === "cached_from_ltg")) {
        throw new Error(
          `memory ${memoryId} is cached_from_ltg and cannot be promoted (already LTG content)`,
        );
      }
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE memory_records
             SET residence = 'ltg', promoted_at = ?, expires_at = NULL
             WHERE id = ?`,
          )
          .run(now, memoryId);
        this.db
          .prepare("UPDATE memory_nodes SET residence = 'ltg', updated_at = ? WHERE id = ?")
          .run(now, memory.nodeId);
        this.recordConsolidationEvent(
          "promote_memory",
          memoryId,
          "stg",
          "ltg",
          requireText(reason, "promotion reason"),
          evidenceTraceIds,
          now,
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return { ...memory, residence: "ltg", promotedAt: now, expiresAt: null };
    }

    demoteMemory(memoryId: string, reason: string, expiresAt?: string): MemoryRecord {
      const memory = this.requireActiveMemory(memoryId);
      if (memory.residence === "stg") return memory;
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE memory_records
             SET residence = 'stg', promoted_at = NULL, expires_at = ?
             WHERE id = ?`,
          )
          .run(expiresAt ?? null, memoryId);
        this.refreshNodeResidence(memory.nodeId, now);
        this.recordConsolidationEvent(
          "demote_memory",
          memoryId,
          "ltg",
          "stg",
          requireText(reason, "demotion reason"),
          [],
          now,
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return { ...memory, residence: "stg", promotedAt: null, expiresAt: expiresAt ?? null };
    }

    expireShortTermMemories(at = new Date().toISOString(), limit = 256): string[] {
      const rows = this.db
        .prepare(
          `SELECT id, node_id FROM memory_records
           WHERE residence = 'stg' AND status IN ('active', 'disputed')
             AND expires_at IS NOT NULL AND expires_at <= ?
           ORDER BY expires_at, id LIMIT ?`,
        )
        .all(at, Math.max(1, Math.min(limit, 2_048))) as Row[];
      if (rows.length === 0) return [];
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const update = this.db.prepare(
          "UPDATE memory_records SET status = 'inactive' WHERE id = ?",
        );
        for (const row of rows) {
          const id = String(row.id);
          update.run(id);
          this.recordConsolidationEvent(
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
          this.refreshNodeResidence(nodeId, now);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return rows.map((row) => String(row.id));
    }

    memoryWriteEvents(memoryId?: string): MemoryWriteEvent[] {
      const rows = memoryId
        ? (this.db
            .prepare(
              "SELECT * FROM memory_write_events WHERE memory_id = ? ORDER BY created_at, rowid",
            )
            .all(memoryId) as Row[])
        : (this.db
            .prepare("SELECT * FROM memory_write_events ORDER BY created_at, rowid")
            .all() as Row[]);
      return rows.map(mapMemoryWriteEvent);
    }

    getHistoryBySourceMessage(sessionId: string, sourceMessageId: string): HistoryRecord | null {
      const row = this.db
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
      const existing = this.db
        .prepare("SELECT * FROM memory_nodes WHERE canonical_name = ?")
        .get(canonicalName) as Row | undefined;

      if (existing) {
        const node = mapNode(existing);
        if (node.status === "active") return node;
        const redirects = this.db
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
        this.db
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

      this.db
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

    rebuildVectorIndex(): number {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.statement, m.node_id, n.canonical_name, n.summary
         FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
         WHERE m.storage_state = 'indexed'`,
        )
        .all() as Row[];
      const upsert = this.db.prepare(
        `INSERT INTO memory_embeddings
          (memory_id, model, dimensions, vector_json, vector_blob, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, model) DO UPDATE SET
           dimensions = excluded.dimensions, vector_json = excluded.vector_json,
           vector_blob = excluded.vector_blob,
           updated_at = excluded.updated_at`,
      );
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const text = memoryEmbeddingText(row.statement, row.canonical_name);
          const vector = this.embedder.embed(text);
          upsert.run(
            row.id,
            this.embedder.model,
            this.embedder.dimensions,
            JSON.stringify(vector),
            encodeVector(vector),
            now,
          );
        }
        this.db.exec("COMMIT");
        return rows.length;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    rebalanceNode(
      nodeId: string,
      capacities: readonly [number, number, number] = [16, 64, 256],
    ): RebalanceResult {
      this.requireNode(nodeId);
      const rows = this.db
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
      const update = this.db.prepare(
        "UPDATE memory_records SET tier = ?, pending_access_count = 0 WHERE id = ?",
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of active) {
          const id = String(row.id);
          const tier = tiers.get(id) ?? 3;
          if (tier !== Number(row.tier)) changedMemoryIds.push(id);
          update.run(tier, id);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return {
        nodeId,
        changedMemoryIds,
        processedMemoryCount: active.length,
        expectedDepth,
        pendingAccesses: rows.reduce((sum, row) => sum + Number(row.pending_access_count ?? 0), 0),
      };
    }

    rebalanceDueNodes(
      threshold = 32,
      capacities: readonly [number, number, number] = [16, 64, 256],
    ): RebalanceResult[] {
      const rows = this.db
        .prepare(
          `SELECT node_id, SUM(pending_access_count) AS pending
         FROM memory_records GROUP BY node_id HAVING pending >= ?`,
        )
        .all(Math.max(1, threshold)) as Row[];
      return rows.map((row) => this.rebalanceNode(String(row.node_id), capacities));
    }

    /**
     * Execute one bounded maintenance slice over nodes whose accumulated write
     * Delta or access counter crossed a threshold. The counters already live on
     * the write/read paths, so ordinary remember/get calls only enqueue work.
     */
    runDueMaintenance(
      options: {
        writeThreshold?: number;
        accessThreshold?: number;
        nodeLimit?: number;
        blockSize?: number;
        capacities?: readonly [number, number, number];
      } = {},
    ): MaintenanceBatchResult {
      const writeThreshold = Math.max(1, options.writeThreshold ?? 16);
      const accessThreshold = Math.max(1, options.accessThreshold ?? 32);
      const nodeLimit = Math.max(1, Math.min(options.nodeLimit ?? 4, 64));
      const rows = this.db
        .prepare(
          `SELECT n.id AS node_id,
                  (SELECT COUNT(*) FROM memory_index_delta d
                    WHERE d.node_id = n.id AND d.compacted = 0) AS pending_writes,
                  (SELECT COALESCE(SUM(m.pending_access_count), 0)
                     FROM memory_records m WHERE m.node_id = n.id) AS pending_accesses,
                  COALESCE((SELECT MIN(d.created_at) FROM memory_index_delta d
                    WHERE d.node_id = n.id AND d.compacted = 0), n.updated_at) AS oldest
             FROM memory_nodes n
            WHERE n.status = 'active'
              AND ((SELECT COUNT(*) FROM memory_index_delta d
                     WHERE d.node_id = n.id AND d.compacted = 0) >= ?
                OR (SELECT COALESCE(SUM(m.pending_access_count), 0)
                      FROM memory_records m WHERE m.node_id = n.id) >= ?)
            ORDER BY oldest, n.id LIMIT ?`,
        )
        .all(writeThreshold, accessThreshold, nodeLimit) as Row[];

      const startedAt = nowMs();
      const timer = new PerfTimer();
      const rebalancedNodeIds: string[] = [];
      const compactedNodeIds: string[] = [];
      const changedMemoryIds: string[] = [];
      let rebuiltLeafBlocks = 0;
      let acknowledgedDeltas = 0;
      let rowsTouched = 0;
      timer.measure(SECTION.maintenance, () => {
        for (const row of rows) {
          const nodeId = String(row.node_id);
          if (Number(row.pending_accesses) >= accessThreshold) {
            const result = this.rebalanceNode(nodeId, options.capacities);
            rebalancedNodeIds.push(nodeId);
            changedMemoryIds.push(...result.changedMemoryIds);
            rowsTouched += result.processedMemoryCount;
          }
          if (Number(row.pending_writes) >= writeThreshold) {
            const blocks = this.rebuildLeafBlocks(nodeId, options.blockSize ?? 32);
            const acknowledged = this.acknowledgeIndexDelta([nodeId]);
            compactedNodeIds.push(nodeId);
            rebuiltLeafBlocks += blocks.length;
            acknowledgedDeltas += acknowledged;
            rowsTouched += blocks.reduce((sum, block) => sum + block.memoryCount, 0) + acknowledged;
          }
        }
      });
      timer.setTotal(nowMs() - startedAt);
      this.recordPerfAggregates(timer.snapshot());
      const result: MaintenanceBatchResult = {
        id: randomUUID(),
        consideredNodes: rows.length,
        rebalancedNodeIds,
        compactedNodeIds,
        changedMemoryIds: [...new Set(changedMemoryIds)],
        rebuiltLeafBlocks,
        acknowledgedDeltas,
        rowsTouched,
        durationMs: timer.totalMs,
        createdAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          `INSERT INTO maintenance_runs
            (id, phase, considered_nodes, rows_touched, details_json, duration_ms, created_at)
           VALUES (?, 'local', ?, ?, ?, ?, ?)`,
        )
        .run(
          result.id,
          result.consideredNodes,
          result.rowsTouched,
          JSON.stringify({
            rebalancedNodeIds: result.rebalancedNodeIds,
            compactedNodeIds: result.compactedNodeIds,
            changedMemoryIds: result.changedMemoryIds,
            rebuiltLeafBlocks: result.rebuiltLeafBlocks,
            acknowledgedDeltas: result.acknowledgedDeltas,
          }),
          result.durationMs,
          result.createdAt,
        );
      return result;
    }

    maintenanceRuns(limit = 100): MaintenanceBatchResult[] {
      const rows = this.db
        .prepare(
          `SELECT * FROM maintenance_runs
           WHERE phase = 'local' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(limit, 1_000))) as Row[];
      return rows.map((row) => {
        const details = parseStoredJson<Record<string, unknown>>(row.details_json, {});
        return {
          id: String(row.id),
          consideredNodes: Number(row.considered_nodes),
          rebalancedNodeIds: detailStringArray(details.rebalancedNodeIds),
          compactedNodeIds: detailStringArray(details.compactedNodeIds),
          changedMemoryIds: detailStringArray(details.changedMemoryIds),
          rebuiltLeafBlocks: Number(details.rebuiltLeafBlocks ?? 0),
          acknowledgedDeltas: Number(details.acknowledgedDeltas ?? 0),
          rowsTouched: Number(row.rows_touched),
          durationMs: Number(row.duration_ms),
          createdAt: String(row.created_at),
        };
      });
    }

    recordRetrievalTrace(input: RetrievalTraceInput): string {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const nodeIds = [...new Set(input.resultNodeIds)].sort();
      // Prefer precomputed node IDs (the retrieval path knows them); fall
      // back to mapping the memory IDs for callers that only pass memories.
      const usefulNodeIds = new Set(
        input.usefulNodeIds ?? this.nodeIdsForMemories(input.usefulMemoryIds ?? []),
      );
      const contradictedNodeIds = new Set(
        input.contradictedNodeIds ?? this.nodeIdsForMemories(input.contradictedMemoryIds ?? []),
      );
      const taskId = input.taskId?.trim() || stableTaskId(input.query);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `INSERT INTO retrieval_traces
            (id, session_id, query, result_memory_ids_json, result_node_ids_json,
             expanded_node_ids_json, useful_memory_ids_json,
             contradicted_memory_ids_json, rejected_memory_ids_json,
             relation_ids_json, task_id, active_graph_budget_json,
             active_graph_usage_json, selections_json, expansions_json,
             budget_ledger_json, qpp_json, timings_json, filter_usage_json,
             ambiguity, fallback_used, conflict_observed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.sessionId?.trim() || null,
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
            JSON.stringify(input.timings ?? {}),
            JSON.stringify(input.filterUsage ?? {}),
            clamp(input.ambiguity ?? 0, 0, 1),
            input.fallbackUsed ? 1 : 0,
            input.conflictObserved ? 1 : 0,
            createdAt,
          );
        const updateNode = this.db.prepare(
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
        this.recordNodeSelections(nodeIds, input.expandedNodeIds ?? [], createdAt);
        this.recordEdgeSelections(input.relationIds ?? [], createdAt);
        const updatePair = this.db.prepare(
          `INSERT INTO node_pair_signals
            (left_node_id, right_node_id, co_retrieval_count, useful_count,
             evidence_trace_ids_json, updated_at)
           VALUES (?, ?, 1, 0, ?, ?)
           ON CONFLICT(left_node_id, right_node_id) DO UPDATE SET
             co_retrieval_count = co_retrieval_count + 1,
             evidence_trace_ids_json = excluded.evidence_trace_ids_json,
             updated_at = excluded.updated_at`,
        );
        const observeTask = this.db.prepare(
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
            const previous = this.db
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
            // useful_count is now derived on read (proposeTopologyChanges
            // computes it from edge_task_observations); no per-pair refresh.
          }
        }
        this.db.exec("COMMIT");
        return id;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    /** Long-term per-section aggregates (never pruned). */
    perfAggregates(): PerfAggregate[] {
      const rows = this.db
        .prepare(
          `SELECT section, count, sum, sum_sq, buckets_json, updated_at
           FROM perf_aggregates ORDER BY section`,
        )
        .all() as Row[];
      return rows.map((row) => ({
        section: String(row.section),
        count: Number(row.count),
        sum: Number(row.sum),
        sumSq: Number(row.sum_sq),
        buckets: parseNumberArray(row.buckets_json),
        updatedAt: String(row.updated_at),
      }));
    }

    /** Number of raw retrieval traces (for pruning window checks/tests). */
    retrievalTracesCount(): number {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM retrieval_traces`).get() as Row;
      return Number(row.n);
    }

    /**
     * Prune raw retrieval traces beyond the retention window. The window is
     * defined by age (default 30 days) and row count (default 10 000) — the
     * larger of the two bounds wins, whichever is breached first. Aggregates
     * are never touched: perf_aggregates survives pruning by design.
     *
     * Runs as a maintenance action (retention lifecycle), never automatically
     * per-query, matching the repo's "explicit maintenance, no background
     * scheduler" discipline.
     */
    pruneRetrievalTraces(options: { maxDays?: number; maxRows?: number } = {}): number {
      const maxDays = options.maxDays ?? 30;
      const maxRows = options.maxRows ?? 10_000;
      const cutoff = new Date(Date.now() - maxDays * 86_400_000).toISOString();
      // One atomic statement: delete rows older than the window OR beyond the
      // row-count ceiling (keep the newest maxRows). A LIMIT caps a single call
      // so a huge backlog is drained across maintenance runs, not one shot.
      const deleted = this.db
        .prepare(
          `DELETE FROM retrieval_traces
           WHERE id IN (
             SELECT id FROM retrieval_traces
             WHERE created_at < ?
                OR id NOT IN (
                  SELECT id FROM retrieval_traces
                  ORDER BY created_at DESC LIMIT ?
                )
             LIMIT 5000
           )`,
        )
        .run(cutoff, maxRows);
      return Number(deleted.changes);
    }

    retrievalTrace(id: string, sessionId?: string): RetrievalTrace | null {
      const row = this.db.prepare("SELECT * FROM retrieval_traces WHERE id = ?").get(id) as
        Row | undefined;
      if (!row) return null;
      this.assertTraceOwner(row, sessionId);
      return {
        id: String(row.id),
        sessionId: row.session_id === null ? null : String(row.session_id),
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
          tiersOpened: 1,
          deepEvidence: 0,
          latencyMs: 0,
          exhausted: [],
        }),
        selections: parseStoredJson(row.selections_json, []),
        expansions: parseStoredJson(row.expansions_json, []),
        budgetLedger: parseStoredJson(row.budget_ledger_json, []),
        qpp: parseQppDecision(row.qpp_json),
        timings: parseStoredJson(row.timings_json, null) ?? undefined,
        filterUsage: parseStoredJson(row.filter_usage_json, null) ?? undefined,
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
      sessionId?: string,
    ): void {
      const startedAt = nowMs();
      this.recordActiveGraphUseInner(activeGraphId, input, sessionId);
      // Record the use-attribution span on the same trace row (best-effort —
      // the span is diagnostic, never a reason to fail the call).
      try {
        this.db
          .prepare(
            `UPDATE retrieval_traces SET timings_json = json_patch(timings_json, ?) WHERE id = ?`,
          )
          .run(JSON.stringify({ use: { totalMs: nowMs() - startedAt } }), activeGraphId);
      } catch {
        /* trace timing is diagnostic; ignore write failure */
      }
    }

    // Moved up from NmgStoreBase: its only caller is recordActiveGraphUse
    // (this cluster), and it calls recordUsage (writes) and trainRouter
    // (graph) — keeping it in base forced two upward stubs.
    protected recordActiveGraphUseInner(
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
        ...new Set([
          ...parseStringArray(row.rejected_memory_ids_json),
          ...observedRejectedMemoryIds,
        ]),
      ];
      const usedNodeIds = new Set(this.nodeIdsForMemories(usedMemoryIds));
      const contradictedNodeIds = new Set(this.nodeIdsForMemories(contradictedMemoryIds));
      const observedUsedNodeIds = new Set(this.nodeIdsForMemories(observedUsedMemoryIds));
      const observedContradictedNodeIds = new Set(
        this.nodeIdsForMemories(observedContradictedMemoryIds),
      );
      const observedRejectedNodeIds = new Set(this.nodeIdsForMemories(observedRejectedMemoryIds));
      const resultNodeIds = parseStringArray(row.result_node_ids_json).sort();
      const observedPairs: Array<readonly [string, string]> = [];
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
            observedPairs.push(pair);
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
      // Outcome attribution is the point where co-retrieval becomes evidence.
      // Reconciliation remains conservative (independent-task threshold and
      // hysteresis live in the graph layer), but it must be invoked by a real
      // production path rather than only by tests or manual maintenance.
      if (observedPairs.length > 0) this.reconcileConsolidation({ pairs: observedPairs });
    }

    recordConsolidationEvent(
      action: ConsolidationEvent["action"],
      targetId: string,
      previousState: string,
      nextState: string,
      reason: string,
      evidenceTraceIds: readonly string[],
      createdAt = new Date().toISOString(),
    ): string {
      const id = randomUUID();
      this.db
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

    rebuildLeafBlocks(nodeId?: string, blockSize = 32): LeafBlock[] {
      const size = Math.max(4, Math.min(blockSize, 128));
      if (!nodeId) {
        const rows = this.db
          .prepare("SELECT id FROM memory_nodes WHERE status = 'active' ORDER BY id")
          .all() as Row[];
        return rows.flatMap((row) => this.rebuildLeafBlocks(String(row.id), size));
      }
      this.requireNode(nodeId);
      const rows = this.db
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
        const key = `${row.node_id}\0${row.tier}\0${row.memory_type}\0${row.scope_json}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
      const blocks: LeafBlock[] = [];
      const now = new Date().toISOString();
      const existing = new Map(
        (
          this.db
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
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const insertBlock = this.db.prepare(
          `INSERT INTO memory_leaf_blocks
            (id, node_id, tier, summary, memory_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET tier = excluded.tier,
             summary = excluded.summary, memory_count = excluded.memory_count,
             updated_at = excluded.updated_at`,
        );
        const insertMember = this.db.prepare(
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
        const removeBlock = this.db.prepare("DELETE FROM memory_leaf_blocks WHERE id = ?");
        for (const id of staleIds) removeBlock.run(id);
        this.db
          .prepare(
            `INSERT INTO leaf_block_status (node_id, dirty, updated_at) VALUES (?, 0, ?)
           ON CONFLICT(node_id) DO UPDATE SET dirty = 0, updated_at = excluded.updated_at`,
          )
          .run(nodeId, now);
        this.db
          .prepare("UPDATE memory_index_delta SET compacted = 1 WHERE node_id = ?")
          .run(nodeId);
        this.db.exec("COMMIT");
        if (staleIds.length > 0) this.invalidateVectorCaches("leaf");
        return blocks;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    dirtyLeafNodeIds(): string[] {
      const rows = this.db
        .prepare("SELECT node_id FROM leaf_block_status WHERE dirty = 1 ORDER BY node_id")
        .all() as Row[];
      return rows.map((row) => String(row.node_id));
    }

    pendingIndexDelta(nodeId?: string, limit = 512): string[] {
      const rows = nodeId
        ? (this.db
            .prepare(
              `SELECT memory_id FROM memory_index_delta
             WHERE node_id = ? ORDER BY created_at, memory_id LIMIT ?`,
            )
            .all(nodeId, Math.max(1, Math.min(limit, 2_048))) as Row[])
        : (this.db
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
      beginEmbeddingIndex(this.db, input);
    }

    completeEmbeddingIndex(indexId: string): void {
      completeEmbeddingIndex(this.db, indexId);
    }

    failEmbeddingIndex(indexId: string, error: unknown): void {
      failEmbeddingIndex(this.db, indexId, error);
    }

    embeddingIndexHealth(indexId: string): EmbeddingIndexHealth | null {
      return embeddingIndexHealth(this.db, indexId);
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
      const stmt = this.db.prepare(
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
      const rows = this.db
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
      const result = this.db
        .prepare(
          `DELETE FROM memory_index_delta
         WHERE node_id IN (${ids.map(() => "?").join(",")}) AND compacted = 1`,
        )
        .run(...ids);
      return Number(result.changes);
    }
  };
}

function mapClaimPosterior(row: Row): ClaimPosterior {
  const alpha = Number(row.alpha);
  const beta = Number(row.beta);
  const total = alpha + beta;
  const mean = total > 0 ? alpha / total : 0.5;
  // Lightweight conservative approximation suitable for shadow routing. The
  // full Beta quantile can replace it later without changing stored counters.
  const standardError = Math.sqrt((mean * (1 - mean)) / Math.max(1, total + 1));
  return {
    memoryId: String(row.memory_id),
    claimIndex: Number(row.claim_index),
    claimText: String(row.claim_text),
    priorConfidence: Number(row.prior_confidence),
    alpha,
    beta,
    mean,
    conservativeLowerBound: clamp(mean - 1.96 * standardError, 0, 1),
    independentVoteCount: Number(row.independent_vote_count),
    updatedAt: String(row.updated_at),
  };
}

function detailStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
