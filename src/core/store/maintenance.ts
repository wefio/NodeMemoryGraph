/**
 * maintenance cluster of NmgStore methods — official TypeScript mixin pattern
 * (docs/design/store-cluster-split.md, cluster-dag.test.ts).
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
  LeafSummaryTask,
  NodeSummaryTask,
  MaintenanceBatchResult,
  MemoryNode,
  MemoryNodeKind,
  MemoryMaintenanceAction,
  MemoryMaintenanceDefect,
  MemoryMaintenancePolicyArtifact,
  MemoryMaintenanceProposal,
  MemoryRecord,
  MemoryResidence,
  MemoryResolution,
  MemoryStatus,
  MemoryStorageState,
  MemoryTier,
  MemoryWriteEvent,
  NodeRouteSignalItem,
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
import { intersectScopes, validityIntervalsOverlap } from "../semantic-domain.ts";
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
import { ftsIndexedText } from "./search-ranking.ts";
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
    declare appendHistory: (input: {
      content: string;
      role: HistoryRecord["role"];
      sessionId?: string | null;
      sourceMessageId?: string;
      sourceRef?: string;
    }) => HistoryRecord;
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
    declare protected invalidateScopeWriteIndexes: (scopeJson?: string) => void;
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
    declare trainRouter: (
      query: string,
      usefulNodeIds: string[],
      learningRate?: number,
      confirmedNodeIds?: string[],
    ) => void;
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
      const collectionOrigin =
        input.collectionOrigin ??
        (input.votes.some((vote) => vote.source === "benchmark") ? "controlled" : "natural");
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
        evidenceSource: RecordClaimOutcomesInput["votes"][number]["evidenceSource"];
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
        const evidenceSource = vote.evidenceSource;
        if (evidenceSource) {
          if (vote.source !== "user" && vote.source !== "tool") {
            throw new Error("claim outcome evidenceSource requires source user or tool");
          }
          if (evidenceSource.actor !== vote.source) {
            throw new Error("claim outcome evidence actor must match its source");
          }
          if (
            requireText(evidenceSource.sourceMessageId, "evidenceSource.sourceMessageId") !==
            sourceLineage
          ) {
            throw new Error("claim outcome evidence sourceMessageId must match sourceLineage");
          }
          requireText(evidenceSource.content, "evidenceSource.content");
          requireText(evidenceSource.sessionId, "evidenceSource.sessionId");
        }
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
            evidenceSource,
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
          const evidenceId = item.evidenceSource
            ? this.appendHistory({
                content: item.evidenceSource.content,
                role: item.evidenceSource.actor,
                sessionId: item.evidenceSource.sessionId,
                sourceMessageId: item.evidenceSource.sourceMessageId,
                sourceRef: item.evidenceSource.sourceRef,
              }).id
            : null;
          const inserted = this.db
            .prepare(
              `INSERT OR IGNORE INTO claim_outcome_events
                (id, memory_id, claim_index, semantic_task_id, source,
                 source_lineage, evidence_id, collection_origin, outcome, weight,
                 active_graph_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              item.memoryId,
              item.claimIndex,
              semanticTaskId,
              item.source,
              item.sourceLineage,
              evidenceId,
              collectionOrigin,
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
            evidenceId,
            collectionOrigin,
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
        evidenceId: row.evidence_id ? String(row.evidence_id) : null,
        collectionOrigin: String(
          row.collection_origin ?? "legacy",
        ) as ClaimOutcomeEvent["collectionOrigin"],
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
            "resolution, opened_at, related_memory_ids_json, " +
            "residence, session_id, promoted_at, expires_at, evidence_role, supersedes_id, " +
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
        resolution: String(row.resolution ?? "resolved") as MemoryRecord["resolution"],
        openedAt: row.opened_at ? String(row.opened_at) : null,
        relatedMemoryIds: parseStringArray(row.related_memory_ids_json),
        residence: String(row.residence ?? "ltg") as MemoryResidence,
        sessionId: row.session_id ? String(row.session_id) : null,
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
            `SELECT id, result_memory_ids_json, disclosed_memory_ids_json,
                    attributed_memory_ids_json,
                    useful_memory_ids_json,
                    contradicted_memory_ids_json, rejected_memory_ids_json
             FROM retrieval_traces`,
          )
          .all() as Row[];
        const updateTrace = this.db.prepare(
          `UPDATE retrieval_traces
           SET result_memory_ids_json = ?, disclosed_memory_ids_json = ?,
               attributed_memory_ids_json = ?, useful_memory_ids_json = ?,
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
            withoutDeleted(trace.disclosed_memory_ids_json),
            withoutDeleted(trace.attributed_memory_ids_json),
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
        this.invalidateScopeWriteIndexes(String(row.scope_json));
        return memory;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    /**
     * Delete every provisional memory owned by one session (session_id match),
     * reusing deleteMemory's full cascade (FTS/embeddings/traces/proposals).
     * Shared rows (session_id NULL: cached_from_ltg / LTG) are untouched.
     * Returns the number of memories removed. Used by STG session lifecycle:
     * docs/design/stg-shared-store-v2-2026-08-12.md §3.3.
     */
    purgeSession(sessionId: string): number {
      const rows = this.db
        .prepare("SELECT id FROM memory_records WHERE session_id = ?")
        .all(sessionId) as Row[];
      let purged = 0;
      for (const row of rows) {
        const id = String(row.id);
        if (this.deleteMemory(id)) {
          // deleteMemory soft-deletes (status='deleted') while cleaning FTS /
          // embeddings / traces. Session purge is a physical removal (STG is
          // scratch: no audit value), so drop the row itself too — otherwise
          // exact access still resolves it.
          this.db.prepare("DELETE FROM memory_records WHERE id = ?").run(id);
          purged += 1;
        }
      }
      return purged;
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
          `SELECT id, node_id, evidence_id, statement, residence, storage_state, resolution, scope_json
           FROM memory_records WHERE id = ?`,
        )
        .get(memoryId) as Row | undefined;
      if (!row) throw new Error(`memory ${memoryId} does not exist`);
      if (String(row.residence) !== "ltg") {
        throw new Error("L4/L5 retention applies only to shared LTG memories");
      }
      const current = String(row.storage_state ?? "indexed") as MemoryStorageState;
      if (current === target) return current;
      if (String(row.resolution ?? "resolved") !== "resolved" && target !== "indexed") {
        throw new Error("open memories must be resolved before archival or quarantine");
      }
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
        this.invalidateScopeWriteIndexes(String(row.scope_json));
        return target;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    setMemoryResolution(
      memoryId: string,
      target: MemoryResolution,
      options: { relatedMemoryIds?: string[]; reason?: string; openedAt?: string } = {},
    ): {
      memoryId: string;
      resolution: MemoryResolution;
      openedAt: string | null;
      relatedMemoryIds: string[];
    } {
      const row = this.db
        .prepare(
          `SELECT resolution, opened_at, related_memory_ids_json, storage_state
           FROM memory_records WHERE id = ?`,
        )
        .get(memoryId) as Row | undefined;
      if (!row) throw new Error(`memory ${memoryId} does not exist`);
      const previous = String(row.resolution ?? "resolved") as MemoryResolution;
      const relatedMemoryIds = [
        ...new Set(
          (options.relatedMemoryIds ?? parseStringArray(row.related_memory_ids_json))
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ];
      if (target !== "resolved" && relatedMemoryIds.length === 0) {
        throw new Error("open memories require at least one relatedMemoryId");
      }
      const exists = this.db.prepare("SELECT 1 FROM memory_records WHERE id = ?");
      for (const relatedId of relatedMemoryIds) {
        if (!exists.get(relatedId)) throw new Error(`related memory ${relatedId} does not exist`);
      }
      if (target !== "resolved" && String(row.storage_state ?? "indexed") !== "indexed") {
        this.setMemoryStorageState(memoryId, "indexed");
      }
      const openedAt =
        target === "resolved"
          ? row.opened_at
            ? String(row.opened_at)
            : null
          : (options.openedAt ?? new Date().toISOString());
      if (
        previous === target &&
        JSON.stringify(relatedMemoryIds) === String(row.related_memory_ids_json)
      ) {
        return { memoryId, resolution: target, openedAt, relatedMemoryIds };
      }
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE memory_records
             SET resolution = ?, opened_at = ?, related_memory_ids_json = ?,
                 storage_state = CASE WHEN ? = 'resolved' THEN storage_state ELSE 'indexed' END,
                 retention_changed_at = CASE WHEN ? = 'resolved' THEN retention_changed_at ELSE NULL END,
                 quarantine_until = CASE WHEN ? = 'resolved' THEN quarantine_until ELSE NULL END
             WHERE id = ?`,
          )
          .run(
            target,
            openedAt,
            JSON.stringify(relatedMemoryIds),
            target,
            target,
            target,
            memoryId,
          );
        this.db
          .prepare(
            `INSERT INTO memory_resolution_events
              (id, memory_id, from_resolution, to_resolution, opened_at,
               related_memory_ids_json, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            memoryId,
            previous,
            target,
            openedAt,
            JSON.stringify(relatedMemoryIds),
            options.reason?.trim() || null,
            now,
          );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return { memoryId, resolution: target, openedAt, relatedMemoryIds };
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
             AND m.resolution = 'resolved'
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
      // Loop guard (docs/design/stg-isolated-store.md §3): a cached_from_ltg memory is
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
             AND resolution = 'resolved'
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
      this.invalidateScopeWriteIndexes();
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
     * Execute one bounded maintenance slice. A locally hot node is immediately
     * due; global write/access pressure also drains the largest/oldest small-node
     * backlogs so a graph of many sparse nodes cannot starve maintenance forever.
     * The counters already live on the write/read paths, so ordinary
     * remember/get calls only enqueue work.
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
          `WITH pressure AS (
             SELECT
               (SELECT COUNT(*) FROM memory_index_delta d
                  JOIN memory_nodes active_write_node ON active_write_node.id = d.node_id
                 WHERE d.compacted = 0 AND active_write_node.status = 'active') AS total_pending_writes,
               (SELECT COALESCE(SUM(m.pending_access_count), 0) FROM memory_records m
                  JOIN memory_nodes active_access_node ON active_access_node.id = m.node_id
                 WHERE active_access_node.status = 'active') AS total_pending_accesses
           ), candidates AS (
             SELECT n.id AS node_id,
                    (SELECT COUNT(*) FROM memory_index_delta d
                      WHERE d.node_id = n.id AND d.compacted = 0) AS pending_writes,
                    (SELECT COALESCE(SUM(m.pending_access_count), 0)
                       FROM memory_records m WHERE m.node_id = n.id) AS pending_accesses,
                    COALESCE((SELECT MIN(d.created_at) FROM memory_index_delta d
                      WHERE d.node_id = n.id AND d.compacted = 0), n.updated_at) AS oldest
               FROM memory_nodes n WHERE n.status = 'active'
           )
           SELECT candidates.*, pressure.total_pending_writes, pressure.total_pending_accesses
             FROM candidates CROSS JOIN pressure
            WHERE pending_writes >= ? OR pending_accesses >= ?
               OR (total_pending_writes >= ? AND pending_writes > 0)
               OR (total_pending_accesses >= ? AND pending_accesses > 0)
            ORDER BY
              CASE WHEN pending_writes >= ? OR pending_accesses >= ? THEN 0 ELSE 1 END,
              pending_writes DESC, pending_accesses DESC, oldest, node_id
            LIMIT ?`,
        )
        .all(
          writeThreshold,
          accessThreshold,
          writeThreshold,
          accessThreshold,
          writeThreshold,
          accessThreshold,
          nodeLimit,
        ) as Row[];

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
          const accessDue =
            Number(row.pending_accesses) >= accessThreshold ||
            (Number(row.total_pending_accesses) >= accessThreshold &&
              Number(row.pending_accesses) > 0);
          const writeDue =
            Number(row.pending_writes) >= writeThreshold ||
            (Number(row.total_pending_writes) >= writeThreshold && Number(row.pending_writes) > 0);
          if (accessDue) {
            const result = this.rebalanceNode(nodeId, options.capacities);
            rebalancedNodeIds.push(nodeId);
            changedMemoryIds.push(...result.changedMemoryIds);
            rowsTouched += result.processedMemoryCount;
          }
          if (writeDue) {
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
      const taskId = input.taskId?.trim() || stableTaskId(input.query);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `INSERT INTO retrieval_traces
            (id, session_id, query, result_memory_ids_json, result_node_ids_json,
             expanded_node_ids_json, disclosed_memory_ids_json, attributed_memory_ids_json,
             useful_memory_ids_json,
             contradicted_memory_ids_json, rejected_memory_ids_json,
             relation_ids_json, task_id, active_graph_budget_json,
             active_graph_usage_json, selections_json, expansions_json,
             budget_ledger_json, qpp_json, timings_json, filter_usage_json,
             node_route_signal_json,
             ambiguity, fallback_used, conflict_observed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.sessionId?.trim() || null,
            input.query,
            JSON.stringify([...new Set(input.resultMemoryIds)]),
            JSON.stringify(nodeIds),
            JSON.stringify([...new Set(input.expandedNodeIds ?? [])]),
            JSON.stringify([...new Set(input.disclosedMemoryIds ?? [])]),
            JSON.stringify([...new Set(input.attributedMemoryIds ?? [])]),
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
            JSON.stringify(input.nodeRouteSignal ?? []),
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
        // Aggregate tier of the summary-routing signal: per-node counters of
        // how often the node-summary FTS index matched (summary_routed_count)
        // and how often such a node also reached the base result set
        // (summary_recalled_count). routed - recalled per node is the IR gap.
        // Updated inline here (hot path) because the observation is only
        // known at search time; the per-query detail is already persisted in
        // node_route_signal_json for offline diagnosis / router training.
        const updateNodeSignal = this.db.prepare(
          `INSERT INTO node_retrieval_signals
            (node_id, query_count, ambiguity_sum, fallback_count,
             conflict_count, summary_routed_count, summary_recalled_count,
             updated_at)
           VALUES (?, 0, 0, 0, 0, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET
             summary_routed_count = summary_routed_count + excluded.summary_routed_count,
             summary_recalled_count = summary_recalled_count + excluded.summary_recalled_count,
             updated_at = excluded.updated_at`,
        );
        for (const signal of input.nodeRouteSignal ?? []) {
          if (!signal.routed && !signal.recalled) continue;
          updateNodeSignal.run(
            signal.nodeId,
            signal.routed ? 1 : 0,
            signal.recalled ? 1 : 0,
            createdAt,
          );
        }
        this.recordNodeSelections(nodeIds, input.expandedNodeIds ?? [], createdAt);
        this.recordEdgeSelections(input.relationIds ?? [], createdAt);
        // Retrieval-pair signals (node_pair_signals, edge_task_observations)
        // are deferred to drainPendingTraceSignals so the hot path stays
        // O(result nodes) instead of O(pairs). The trace row above is the
        // durable buffer: pending rows are replayed by the next maintenance
        // drain, and feedback updates on the row survive via MAX semantics.
        this.db.exec("COMMIT");
        return id;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    /**
     * Materialize deferred retrieval-pair signals (node_pair_signals and
     * edge_task_observations) from trace rows that have not been drained yet.
     *
     * recordRetrievalTrace keeps the hot path O(result nodes) by deferring the
     * O(pairs) accumulation here. The trace row is the durable buffer: pending
     * rows (signals_drained_at IS NULL) are replayed by a later drain, so a
     * crash between a search and a maintenance run loses nothing. Feedback that
     * arrived before a drain is preserved because edge_task_observations uses
     * MAX(useful/contradicted) and this drain derives the same values from the
     * trace's (feedback-updated) useful/contradicted memory ids.
     *
     * Runs as part of runSemanticMaintenance (bounded, explicit), never per
     * query. useful_count stays derived-on-read (proposeTopologyChanges
     * recomputes it from edge_task_observations), so no per-pair refresh here.
     * Returns the number of traces drained.
     */
    drainPendingTraceSignals(options: { limit?: number } = {}): number {
      const limit = Math.max(1, Math.min(options.limit ?? 256, 2_048));
      const pending = this.db
        .prepare(
          `SELECT id, result_node_ids_json, useful_memory_ids_json,
                  contradicted_memory_ids_json, task_id, query, created_at
           FROM retrieval_traces
           WHERE signals_drained_at IS NULL
           ORDER BY created_at, id LIMIT ?`,
        )
        .all(limit) as Row[];
      if (pending.length === 0) return 0;
      const drainedAt = new Date().toISOString();
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
      const markDrained = this.db.prepare(
        `UPDATE retrieval_traces SET signals_drained_at = ? WHERE id = ?`,
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of pending) {
          const id = String(row.id);
          const nodeIds = [...new Set(parseStringArray(String(row.result_node_ids_json)))].sort();
          if (nodeIds.length >= 2) {
            const usefulNodeIds = new Set(
              this.nodeIdsForMemories(parseStringArray(String(row.useful_memory_ids_json))),
            );
            const contradictedNodeIds = new Set(
              this.nodeIdsForMemories(parseStringArray(String(row.contradicted_memory_ids_json))),
            );
            const taskId = String(row.task_id) || stableTaskId(String(row.query));
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
                updatePair.run(...pair, JSON.stringify(evidence), drainedAt);
                observeTask.run(
                  ...pair,
                  taskId,
                  id,
                  usefulNodeIds.has(pair[0]) && usefulNodeIds.has(pair[1]) ? 1 : 0,
                  contradictedNodeIds.has(pair[0]) || contradictedNodeIds.has(pair[1]) ? 1 : 0,
                  drainedAt,
                );
              }
            }
          }
          markDrained.run(drainedAt, id);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return pending.length;
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

    /** IR gap report from the summary-routing signal (diagnostic consumer):
     *  for each node, how many times the node-summary FTS index matched it
     *  (routed) and how many times it also reached the base result set
     *  (recalled). gap = routed − recalled counts the times base retrieval
     *  missed a node the summary index kept finding — those are exactly the
     *  rescues the node-routed expansion performed. High-gap nodes point at
     *  lexical/vector index holes worth fixing. */
    summaryRouteGapReport(limit = 25): Array<{
      nodeId: string;
      routed: number;
      recalled: number;
      gap: number;
      gapRatio: number;
    }> {
      const rows = this.db
        .prepare("SELECT node_route_signal_json FROM retrieval_traces")
        .all() as Row[];
      const agg = new Map<string, { routed: number; recalled: number }>();
      for (const row of rows) {
        for (const signal of parseStoredJson(
          row.node_route_signal_json,
          [],
        ) as NodeRouteSignalItem[]) {
          const entry = agg.get(signal.nodeId) ?? { routed: 0, recalled: 0 };
          if (signal.routed) entry.routed += 1;
          if (signal.recalled) entry.recalled += 1;
          agg.set(signal.nodeId, entry);
        }
      }
      return [...agg.entries()]
        .map(([nodeId, v]) => ({
          nodeId,
          routed: v.routed,
          recalled: v.recalled,
          gap: v.routed - v.recalled,
          gapRatio: v.routed > 0 ? (v.routed - v.recalled) / v.routed : 0,
        }))
        .sort((a, b) => b.gap - a.gap)
        .slice(0, limit);
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

    // Safe ownership probe for trace lookups that must not throw (e.g. an RPC
    // walking candidate stores to find the one that owns a trace). Unlike
    // retrievalTrace it never throws, so a foreign trace in an early candidate
    // cannot abort the search for the real owner. Returns a tri-state so the
    // caller can keep the diagnostics distinction between "trace is gone" and
    // "trace exists but belongs to another session".
    traceOwnership(id: string, sessionId?: string): "owned" | "foreign" | "absent" {
      const row = this.db
        .prepare("SELECT session_id FROM retrieval_traces WHERE id = ?")
        .get(id) as Row | undefined;
      if (!row) return "absent";
      const owner =
        row.session_id === null || row.session_id === undefined ? null : String(row.session_id);
      if (owner !== null && owner !== sessionId?.trim()) return "foreign";
      return "owned";
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
        disclosedMemoryIds: parseStringArray(row.disclosed_memory_ids_json),
        attributedMemoryIds: parseStringArray(row.attributed_memory_ids_json),
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
        nodeRouteSignal: parseStoredJson(row.node_route_signal_json, []) as NodeRouteSignalItem[],
        createdAt: String(row.created_at),
      };
    }

    /**
     * Record exact evidence disclosed to the model. Disclosure is observable,
     * but it is not answer attribution and must not affect topology or controller
     * supervision.
     */
    recordActiveGraphDisclosure(
      activeGraphId: string,
      disclosedMemoryIds: readonly string[],
      sessionId?: string,
    ): void {
      const row = this.db
        .prepare("SELECT * FROM retrieval_traces WHERE id = ?")
        .get(activeGraphId) as Row | undefined;
      if (!row) throw new Error(`active graph ${activeGraphId} does not exist`);
      this.assertTraceOwner(row, sessionId);
      const resultMemoryIds = new Set(parseStringArray(row.result_memory_ids_json));
      const observed = [...new Set(disclosedMemoryIds)].filter((id) => resultMemoryIds.has(id));
      const disclosed = [
        ...new Set([...parseStringArray(row.disclosed_memory_ids_json), ...observed]),
      ];
      this.db
        .prepare("UPDATE retrieval_traces SET disclosed_memory_ids_json = ? WHERE id = ?")
        .run(JSON.stringify(disclosed), activeGraphId);
      this.recordUsage(observed);
    }

    recordActiveGraphAttribution(
      activeGraphId: string,
      input: {
        method: "answer_overlap" | "verified_evidence";
        attributedMemoryIds: readonly string[];
        contradictedMemoryIds?: readonly string[];
        rejectedMemoryIds?: readonly string[];
      },
      sessionId?: string,
    ): void {
      const startedAt = nowMs();
      this.recordActiveGraphAttributionInner(activeGraphId, input, sessionId);
      // Record the attribution span on the same trace row (best-effort —
      // the span is diagnostic, never a reason to fail the call).
      try {
        this.db
          .prepare(
            `UPDATE retrieval_traces SET timings_json = json_patch(timings_json, ?) WHERE id = ?`,
          )
          .run(JSON.stringify({ attribution: { totalMs: nowMs() - startedAt } }), activeGraphId);
      } catch {
        /* trace timing is diagnostic; ignore write failure */
      }
    }

    // Moved up from NmgStoreBase: its only caller is recordActiveGraphAttribution
    // (this cluster), and it calls recordUsage (writes) and trainRouter
    // (graph) — keeping it in base forced two upward stubs.
    protected recordActiveGraphAttributionInner(
      activeGraphId: string,
      input: {
        method: "answer_overlap" | "verified_evidence";
        attributedMemoryIds: readonly string[];
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
      const observedAttributedMemoryIds = [...new Set(input.attributedMemoryIds)].filter((id) =>
        resultMemoryIds.has(id),
      );
      const attributedMemoryIds = [
        ...new Set([
          ...parseStringArray(row.attributed_memory_ids_json),
          ...observedAttributedMemoryIds,
        ]),
      ];
      this.db
        .prepare("UPDATE retrieval_traces SET attributed_memory_ids_json = ? WHERE id = ?")
        .run(JSON.stringify(attributedMemoryIds), activeGraphId);
      // Answer overlap is a black-box diagnostic over a provider-controlled API
      // model. It is not causal evidence and must never feed topology, hierarchy,
      // or differentiable-controller learning.
      if (input.method === "answer_overlap") return;
      const observedVerifiedMemoryIds = observedAttributedMemoryIds;
      const observedContradictedMemoryIds = [...new Set(input.contradictedMemoryIds ?? [])].filter(
        (id) => resultMemoryIds.has(id),
      );
      const observedRejectedMemoryIds = [...new Set(input.rejectedMemoryIds ?? [])].filter((id) =>
        resultMemoryIds.has(id),
      );
      const verifiedMemoryIds = [
        ...new Set([...parseStringArray(row.useful_memory_ids_json), ...observedVerifiedMemoryIds]),
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
      const verifiedNodeIds = new Set(this.nodeIdsForMemories(verifiedMemoryIds));
      const contradictedNodeIds = new Set(this.nodeIdsForMemories(contradictedMemoryIds));
      const observedVerifiedNodeIds = new Set(this.nodeIdsForMemories(observedVerifiedMemoryIds));
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
            JSON.stringify(verifiedMemoryIds),
            JSON.stringify(contradictedMemoryIds),
            JSON.stringify(rejectedMemoryIds),
            activeGraphId,
          );
        this.recordNodeOutcomes(
          observedVerifiedNodeIds,
          observedContradictedNodeIds,
          observedRejectedNodeIds,
          now,
        );
        this.recordEdgeOutcomes(
          relationIds,
          observedVerifiedNodeIds,
          observedContradictedNodeIds,
          observedRejectedNodeIds,
          now,
        );
        const taskId = String(row.task_id) || stableTaskId(String(row.query));
        for (let left = 0; left < resultNodeIds.length; left += 1) {
          for (let right = left + 1; right < resultNodeIds.length; right += 1) {
            const pair = [resultNodeIds[left]!, resultNodeIds[right]!] as const;
            observedPairs.push(pair);
            const usefulFlag = verifiedNodeIds.has(pair[0]) && verifiedNodeIds.has(pair[1]) ? 1 : 0;
            const contradictedFlag =
              contradictedNodeIds.has(pair[0]) || contradictedNodeIds.has(pair[1]) ? 1 : 0;
            // Pair signals may not have been drained into edge_task_observations
            // yet (they are deferred to maintenance), so upsert instead of a
            // bare UPDATE — a missing row must not silently drop the outcome.
            this.db
              .prepare(
                `INSERT INTO edge_task_observations
                  (left_node_id, right_node_id, task_id, trace_id, useful,
                   contradicted, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(left_node_id, right_node_id, task_id) DO UPDATE SET
                   useful = MAX(useful, excluded.useful),
                   contradicted = MAX(contradicted, excluded.contradicted)`,
              )
              .run(...pair, taskId, activeGraphId, usefulFlag, contradictedFlag, now);
            this.refreshPairUsefulness(pair[0], pair[1]);
          }
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.recordUsage(observedVerifiedMemoryIds);
      if (verifiedNodeIds.size > 0) {
        // Triple-confirmation for the summary-routing supervision signal: only
        // nodes that were summary-routed (routed ∧ recalled in this trace's
        // node_route_signal_json) AND explicitly verified are boosted in the
        // router update. Summary hits alone never train the router — that
        // would be exposure-biased (Unbiased-LTR echo-chamber guard).
        const tripleConfirmed = new Set<string>();
        for (const signal of parseStoredJson(
          row.node_route_signal_json,
          [],
        ) as NodeRouteSignalItem[]) {
          if (signal.routed && signal.recalled && verifiedNodeIds.has(signal.nodeId)) {
            tripleConfirmed.add(signal.nodeId);
          }
        }
        this.trainRouter(String(row.query), [...verifiedNodeIds], 0.2, [...tripleConfirmed]);
      }
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

    /** Membership fingerprint of a block: "count:id,id,…" in ordinal order.
     *  Block ids are content-addressed (stableLeafBlockId), so a membership
     *  change normally means a new block id — the key is a cheap guard for
     *  in-place member status flips (active/disputed filtering). */
    #leafMembersKey(blockId: string): string {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) || ':' || IFNULL(GROUP_CONCAT(memory_id, ','), '') AS key
             FROM (SELECT lm.memory_id FROM memory_leaf_members lm
                   JOIN memory_records m ON m.id = lm.memory_id
                   WHERE lm.block_id = ? AND m.status IN ('active', 'disputed')
                     AND m.storage_state = 'indexed'
                   ORDER BY lm.ordinal)`,
        )
        .get(blockId) as Row;
      return String(row.key);
    }

    /** Blocks whose semantic summary is missing or stale (membership changed
     *  since it was written). The store stays LLM-free: an external
     *  LeafSummaryProvider summarizes the returned tasks and persists results
     *  via setLeafSummary. Scans blocks oldest-first so the longest-unsummarized
     *  blocks go first. */
    pendingLeafSummaries(
      options: {
        limit?: number;
        scan?: number;
        statementCountCap?: number;
        statementCharCap?: number;
      } = {},
    ): LeafSummaryTask[] {
      const limit = Math.max(1, Math.min(options.limit ?? 64, 512));
      const scan = Math.max(limit, Math.min(options.scan ?? 2_048, 16_384));
      const statementCountCap = Math.max(1, Math.min(options.statementCountCap ?? 48, 128));
      const statementCharCap = Math.max(32, Math.min(options.statementCharCap ?? 400, 4_000));
      const rows = this.db
        .prepare(
          `SELECT b.id, b.node_id, b.memory_count, b.semantic_members_key, n.canonical_name
             FROM memory_leaf_blocks b
             JOIN memory_nodes n ON n.id = b.node_id
            WHERE n.status = 'active'
            ORDER BY b.updated_at ASC, b.id ASC
            LIMIT ?`,
        )
        .all(scan) as Row[];
      const statementQuery = this.db.prepare(
        `SELECT m.statement FROM memory_leaf_members lm
           JOIN memory_records m ON m.id = lm.memory_id
          WHERE lm.block_id = ? AND m.status IN ('active', 'disputed')
            AND m.storage_state = 'indexed'
          ORDER BY lm.ordinal LIMIT ?`,
      );
      const tasks: LeafSummaryTask[] = [];
      for (const row of rows) {
        if (tasks.length >= limit) break;
        const blockId = String(row.id);
        const membersKey = this.#leafMembersKey(blockId);
        if (String(row.semantic_members_key ?? "") === membersKey) continue;
        const statements = (statementQuery.all(blockId, statementCountCap) as Row[]).map(
          (statement) => {
            const text = String(statement.statement);
            return text.length > statementCharCap ? `${text.slice(0, statementCharCap)}…` : text;
          },
        );
        if (statements.length === 0) continue;
        tasks.push({
          blockId,
          nodeId: String(row.node_id),
          nodeName: String(row.canonical_name),
          membersKey,
          memoryCount: Number(row.memory_count),
          statements,
        });
      }
      return tasks;
    }

    /** Persist an externally written semantic summary for a block. Rejects
     *  stale writes whose membership fingerprint no longer matches (the block
     *  changed while the LLM call was in flight) — the caller re-collects via
     *  pendingLeafSummaries. Bumps updated_at so the leaf-embedding staleness
     *  check re-embeds the block with the semantic text, and (re)indexes the
     *  summary into the block FTS table for lexical routing. */
    setLeafSummary(blockId: string, summary: string, model: string, membersKey: string): boolean {
      const text = summary.trim();
      if (!text) throw new Error("leaf summary must not be empty");
      if (!model.trim()) throw new Error("leaf summary model is required");
      const exists = this.db
        .prepare("SELECT id FROM memory_leaf_blocks WHERE id = ?")
        .get(blockId) as Row | undefined;
      if (!exists) return false;
      if (this.#leafMembersKey(blockId) !== membersKey) return false;
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE memory_leaf_blocks
                SET semantic_summary = ?, semantic_summary_model = ?,
                    semantic_members_key = ?, semantic_summary_at = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(text, model.trim(), membersKey, now, now, blockId);
        this.db.prepare("DELETE FROM memory_leaf_fts WHERE block_id = ?").run(blockId);
        this.db
          .prepare("INSERT INTO memory_leaf_fts(block_id, summary) VALUES (?, ?)")
          .run(blockId, ftsIndexedText(text));
        this.db.exec("COMMIT");
        this.invalidateVectorCaches("leaf");
        return true;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    /** Nodes whose semantic summary is missing or stale under hysteresis.
     *  Input is the node's leaf-block summaries (never raw memories), so a
     *  node only becomes pending once at least `minBlocks` of its blocks are
     *  summarized. Refresh rules: no summary yet, or ≥ `newMembersThreshold`
     *  new indexed members since generation, or any membership change after
     *  `refreshMs`. No strict fingerprint — bounded staleness is the design. */
    pendingNodeSummaries(
      options: {
        limit?: number;
        scan?: number;
        minBlocks?: number;
        newMembersThreshold?: number;
        refreshMs?: number;
        statementCountCap?: number;
        statementCharCap?: number;
      } = {},
    ): NodeSummaryTask[] {
      const limit = Math.max(1, Math.min(options.limit ?? 32, 256));
      const scan = Math.max(limit, Math.min(options.scan ?? 1_024, 16_384));
      const minBlocks = Math.max(1, Math.min(options.minBlocks ?? 2, 32));
      const newMembersThreshold = Math.max(1, Math.min(options.newMembersThreshold ?? 5, 512));
      const refreshMs = Math.max(60_000, options.refreshMs ?? 86_400_000);
      const statementCountCap = Math.max(1, Math.min(options.statementCountCap ?? 24, 128));
      const statementCharCap = Math.max(32, Math.min(options.statementCharCap ?? 300, 4_000));
      const rows = this.db
        .prepare(
          `SELECT id, canonical_name, semantic_summary, semantic_member_count,
                  semantic_summary_at
             FROM memory_nodes
            WHERE status = 'active'
            ORDER BY updated_at ASC, id ASC
            LIMIT ?`,
        )
        .all(scan) as Row[];
      const countQuery = this.db.prepare(
        `SELECT COUNT(*) AS c FROM memory_records
          WHERE node_id = ? AND status IN ('active', 'disputed')
            AND storage_state = 'indexed'`,
      );
      const blockSummaryQuery = this.db.prepare(
        `SELECT semantic_summary FROM memory_leaf_blocks
          WHERE node_id = ? AND semantic_summary IS NOT NULL
          ORDER BY updated_at ASC, id ASC LIMIT ?`,
      );
      const nowMs = Date.now();
      const tasks: NodeSummaryTask[] = [];
      for (const row of rows) {
        if (tasks.length >= limit) break;
        const nodeId = String(row.id);
        const statements = (blockSummaryQuery.all(nodeId, statementCountCap) as Row[]).map(
          (block) => {
            const text = String(block.semantic_summary);
            return text.length > statementCharCap ? `${text.slice(0, statementCharCap)}…` : text;
          },
        );
        if (statements.length < minBlocks) continue;
        const count = Number((countQuery.get(nodeId) as Row).c);
        const previous =
          row.semantic_member_count == null ? null : Number(row.semantic_member_count);
        if (previous === null) {
          if (count === 0) continue;
        } else {
          const delta = count - previous;
          const ageMs = row.semantic_summary_at
            ? nowMs - Date.parse(String(row.semantic_summary_at))
            : Number.POSITIVE_INFINITY;
          if (delta < newMembersThreshold && !(delta !== 0 && ageMs >= refreshMs)) continue;
        }
        tasks.push({
          nodeId,
          nodeName: String(row.canonical_name),
          memberCount: count,
          statements,
        });
      }
      return tasks;
    }

    /** Persist an externally written node summary. No stale rejection (unlike
     *  setLeafSummary): the summary is index metadata under hysteresis, so a
     *  slightly older membership baseline is acceptable — the recorded
     *  memberCount simply becomes the new hysteresis baseline. (Re)indexes
     *  into the node FTS table for lexical routing. */
    setNodeSummary(nodeId: string, summary: string, model: string, memberCount: number): boolean {
      const text = summary.trim();
      if (!text) throw new Error("node summary must not be empty");
      if (!model.trim()) throw new Error("node summary model is required");
      const exists = this.db.prepare("SELECT id FROM memory_nodes WHERE id = ?").get(nodeId) as
        Row | undefined;
      if (!exists) return false;
      // Embedding freshness is timestamp-based. Ensure a summary written in the
      // same millisecond as its previous embedding is still observably newer.
      const latestEmbedding = this.db
        .prepare("SELECT MAX(updated_at) AS updated_at FROM node_embeddings WHERE node_id = ?")
        .get(nodeId) as Row | undefined;
      const latestEmbeddingMs = latestEmbedding?.updated_at
        ? Date.parse(String(latestEmbedding.updated_at))
        : Number.NaN;
      const now = new Date(
        Number.isFinite(latestEmbeddingMs)
          ? Math.max(Date.now(), latestEmbeddingMs + 1)
          : Date.now(),
      ).toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE memory_nodes
                SET semantic_summary = ?, semantic_summary_model = ?,
                    semantic_member_count = ?, semantic_summary_at = ?
              WHERE id = ?`,
          )
          .run(text, model.trim(), Math.max(0, Math.floor(memberCount)), now, nodeId);
        this.db.prepare("DELETE FROM memory_node_fts WHERE node_id = ?").run(nodeId);
        this.db
          .prepare("INSERT INTO memory_node_fts(node_id, summary) VALUES (?, ?)")
          .run(nodeId, ftsIndexedText(text));
        this.db.exec("COMMIT");
        return true;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
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
                m2.rowid AS other_rowid,
                m1.scope_json AS own_scope_json,
                m2.scope_json AS other_scope_json,
                m1.valid_from AS own_valid_from,
                m1.valid_until AS own_valid_until,
                m2.valid_from AS other_valid_from,
                m2.valid_until AS other_valid_until
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
            AND (m1.rowid <> m2.rowid OR c1.key < c2.key)
          ORDER BY m2.rowid
          LIMIT 32`,
      );
      for (const id of memoryIds) {
        const rows = stmt.all(id) as Array<{
          pred_key: string;
          own_text: string;
          other_text: string;
          own_rowid: number;
          other_rowid: number;
          own_scope_json: string;
          other_scope_json: string;
          own_valid_from: string | null;
          own_valid_until: string | null;
          other_valid_from: string | null;
          other_valid_until: string | null;
        }>;
        const row = rows.find((candidate) => {
          const scope = intersectScopes(
            parseScope(candidate.own_scope_json),
            parseScope(candidate.other_scope_json),
          );
          return (
            scope !== null &&
            validityIntervalsOverlap(
              { validFrom: candidate.own_valid_from, validUntil: candidate.own_valid_until },
              {
                validFrom: candidate.other_valid_from,
                validUntil: candidate.other_valid_until,
              },
            )
          );
        });
        if (!row) continue;
        const ownIsEarlier = row.own_rowid <= row.other_rowid;
        const earlierText = ownIsEarlier ? row.own_text : row.other_text;
        const laterText = ownIsEarlier ? row.other_text : row.own_text;
        const overlapScope = intersectScopes(
          parseScope(row.own_scope_json),
          parseScope(row.other_scope_json),
        );
        const scopeQualifier =
          overlapScope && Object.keys(overlapScope).length > 0
            ? ` within scope ${JSON.stringify(overlapScope)}`
            : "";
        notes.set(
          id,
          `[NMG note: contradictory memories about '${row.pred_key}'${scopeQualifier}: ` +
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

    createMemoryMaintenanceProposal(input: {
      defectType: MemoryMaintenanceDefect;
      action: MemoryMaintenanceAction;
      targetMemoryIds: string[];
      evidenceMemoryIds?: string[];
      evidenceTraceIds?: string[];
      proposedStatement?: string;
      proposedScope?: import("../types.ts").MemoryScope;
      policy: MemoryMaintenancePolicyArtifact;
      longHorizonScore: number;
      evaluationKind: "held_out" | "matched_replay";
      evaluationRef: string;
    }): MemoryMaintenanceProposal {
      const targets = [
        ...new Set(input.targetMemoryIds.map((id) => requireText(id, "targetMemoryId"))),
      ];
      if (targets.length === 0) throw new Error("maintenance proposal requires targetMemoryIds");
      if (input.defectType === "retrieval" && input.action !== "observe") {
        throw new Error(
          "retrieval defects are selection-policy evidence and may only use action=observe",
        );
      }
      if (input.action === "rewrite" && !input.proposedStatement?.trim()) {
        throw new Error("rewrite proposals require proposedStatement");
      }
      if (input.action === "rescope" && !input.proposedScope) {
        throw new Error("rescope proposals require proposedScope");
      }
      const score = clamp(input.longHorizonScore, 0, 1);
      const threshold = clamp(input.policy.minimumLongHorizonScore, 0, 1);
      if (score < threshold) {
        throw new Error(`long-horizon score ${score} is below policy threshold ${threshold}`);
      }
      const evidenceMemoryIds = [...new Set(input.evidenceMemoryIds ?? [])];
      const evidenceTraceIds = [...new Set(input.evidenceTraceIds ?? [])];
      for (const id of [...targets, ...evidenceMemoryIds]) this.requireActiveMemory(id);
      for (const id of evidenceTraceIds) {
        if (!this.db.prepare("SELECT 1 FROM retrieval_traces WHERE id = ?").get(id)) {
          throw new Error(`retrieval trace ${id} does not exist`);
        }
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO memory_maintenance_proposals(
             id, defect_type, action, target_memory_ids_json, evidence_memory_ids_json,
             evidence_trace_ids_json, proposed_statement, proposed_scope_json,
             policy_id, policy_revision, policy_source_hash, minimum_long_horizon_score,
             long_horizon_score, evaluation_kind, evaluation_ref, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          id,
          input.defectType,
          input.action,
          JSON.stringify(targets),
          JSON.stringify(evidenceMemoryIds),
          JSON.stringify(evidenceTraceIds),
          input.proposedStatement?.trim() || null,
          input.proposedScope ? JSON.stringify(input.proposedScope) : null,
          requireText(input.policy.id, "policy.id"),
          requireText(input.policy.revision, "policy.revision"),
          requireText(input.policy.sourceHash, "policy.sourceHash"),
          threshold,
          score,
          input.evaluationKind,
          requireText(input.evaluationRef, "evaluationRef"),
          now,
        );
      return this.memoryMaintenanceProposal(id)!;
    }

    memoryMaintenanceProposals(
      status: MemoryMaintenanceProposal["status"] = "pending",
    ): MemoryMaintenanceProposal[] {
      return (
        this.db
          .prepare(
            "SELECT * FROM memory_maintenance_proposals WHERE status = ? ORDER BY created_at, id",
          )
          .all(status) as Row[]
      ).map(mapMemoryMaintenanceProposal);
    }

    reviewMemoryMaintenanceProposal(
      proposalId: string,
      decision: "accept" | "reject",
      reason: string,
    ): MemoryMaintenanceProposal {
      const proposal = this.memoryMaintenanceProposal(proposalId);
      if (!proposal) throw new Error(`memory maintenance proposal ${proposalId} does not exist`);
      if (proposal.status !== "pending") {
        throw new Error(`memory maintenance proposal ${proposalId} is already ${proposal.status}`);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE memory_maintenance_proposals
           SET status = ?, review_reason = ?, reviewed_at = ? WHERE id = ?`,
        )
        .run(
          decision === "accept" ? "accepted" : "rejected",
          requireText(reason, "reason"),
          now,
          proposalId,
        );
      return this.memoryMaintenanceProposal(proposalId)!;
    }

    private memoryMaintenanceProposal(proposalId: string): MemoryMaintenanceProposal | null {
      const row = this.db
        .prepare("SELECT * FROM memory_maintenance_proposals WHERE id = ?")
        .get(proposalId) as Row | undefined;
      return row ? mapMemoryMaintenanceProposal(row) : null;
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

function mapMemoryMaintenanceProposal(row: Row): MemoryMaintenanceProposal {
  return {
    id: String(row.id),
    defectType: String(row.defect_type) as MemoryMaintenanceDefect,
    action: String(row.action) as MemoryMaintenanceAction,
    targetMemoryIds: parseStringArray(row.target_memory_ids_json),
    evidenceMemoryIds: parseStringArray(row.evidence_memory_ids_json),
    evidenceTraceIds: parseStringArray(row.evidence_trace_ids_json),
    proposedStatement: row.proposed_statement ? String(row.proposed_statement) : null,
    proposedScope: row.proposed_scope_json ? parseScope(row.proposed_scope_json) : null,
    policy: {
      id: String(row.policy_id),
      revision: String(row.policy_revision),
      sourceHash: String(row.policy_source_hash),
      minimumLongHorizonScore: Number(row.minimum_long_horizon_score),
    },
    longHorizonScore: Number(row.long_horizon_score),
    evaluationKind: String(row.evaluation_kind) as MemoryMaintenanceProposal["evaluationKind"],
    evaluationRef: String(row.evaluation_ref),
    status: String(row.status) as MemoryMaintenanceProposal["status"],
    reviewReason: row.review_reason ? String(row.review_reason) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    createdAt: String(row.created_at),
  };
}
