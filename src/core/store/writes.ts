/**
 * writes cluster of NmgStore methods — official TypeScript mixin pattern
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

import type { Constructor } from "./store-ctor.ts";
import { nowMs, PerfTimer, SECTION } from "../perf.ts";
import { normalizeClaims } from "../claims.ts";
import {
  clamp,
  defaultResidence,
  defaultWriteReason,
  mapHistory,
  normalizeMarkers,
  requireText,
  serializeClaims,
  serializeMarkers,
  serializeScope,
} from "./rows.ts";
import type { StoreRow as Row } from "./search-ranking.ts";

import type {
  DeriveMemoryInput,
  HistoryRecord,
  HistoryRole,
  MemoryMarker,
  MemoryNode,
  MemoryNodeKind,
  MemoryRecord,
  MemoryResidence,
  MemoryScope,
  MemoryTier,
  MemoryWriteEvent,
  NodeRelation,
  RememberInput,
  RememberResult,
  SessionArchive,
  VectorEmbedder,
} from "../types.ts";

export function withWrites<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    // Base-class members (resolved at assembly time)
    declare protected db: DatabaseSync;
    declare protected embedder: VectorEmbedder;

    // Cross-cluster calls (methods defined in other clusters or store.ts)
    declare protected upsertEmbedding: (memoryId: string, text: string) => void;
    declare protected memoryText: (
      memory: Pick<MemoryRecord, "statement">,
      nodeId: string,
    ) => string;
    declare protected upsertFts: (
      memoryId: string,
      statement: string,
      nodeId: string,
      evidenceId: string,
    ) => void;
    declare protected markIndexDelta: (
      memoryId: string,
      nodeId: string,
      operation: "move" | "upsert",
      createdAt?: string,
    ) => void;
    declare protected requireHistory: (historyId: string) => HistoryRecord;
    declare upsertNode: (input: {
      canonicalName: string;
      kind?: MemoryNodeKind;
      summary?: string;
    }) => MemoryNode;
    declare protected resolveStateKey: (
      requestedKey: string,
      scope: MemoryScope,
      node: MemoryNode,
    ) => string;
    declare protected recordMemoryWriteEvent: (
      input: Omit<MemoryWriteEvent, "createdAt" | "id">,
    ) => MemoryWriteEvent;
    declare protected refreshNodeResidence: (nodeId: string, updatedAt: string) => void;
    declare protected evidenceIds: (memoryId: string) => string[];
    declare linkNodes: (input: {
      sourceNodeId: string;
      targetNodeId: string;
      type: NodeRelation["type"];
      evidenceIds?: string[];
      stability?: number;
      consolidationSource?: NodeRelation["consolidationSource"];
    }) => NodeRelation;

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
        const existing = this.db
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

      this.db
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
      const writeSource =
        input.writeSource ?? (input.memoryType === "derived" ? "derived" : "core");
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

      this.db
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
        this.db
          .prepare("UPDATE memory_nodes SET residence = 'ltg', updated_at = ? WHERE id = ?")
          .run(createdAt, memory.nodeId);
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
           VALUES (?, ?)`,
        )
        .run(memory.id, memory.evidenceId);
      this.upsertEmbedding(memory.id, this.memoryText(memory, input.nodeId));
      this.upsertFts(memory.id, memory.statement, input.nodeId, input.evidenceId);
      this.db
        .prepare(
          `INSERT INTO leaf_block_status (node_id, dirty, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
        )
        .run(input.nodeId, createdAt);
      this.markIndexDelta(memory.id, input.nodeId, "upsert", createdAt);

      return memory;
    }

    remember(input: RememberInput): RememberResult {
      if (input.perf === false) return this.rememberInner(input);
      const startedAt = nowMs();
      const perf = new PerfTimer();
      const result = perf.measure(SECTION.write, () => this.rememberInner(input));
      perf.setTotal(Date.now() - startedAt);
      return Object.assign(result, { timings: perf.snapshot() });
    }

    rememberInner(input: RememberInput): RememberResult {
      const memoryType = input.memoryType ?? "fact";
      if (memoryType === "state" && !input.stateKey?.trim()) {
        throw new Error("state memories require a stable stateKey");
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const history = input.evidenceHistoryId
          ? this.requireHistory(input.evidenceHistoryId)
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
            ? this.resolveStateKey(input.stateKey, input.scope ?? {}, node)
            : input.stateKey;
        const automaticPrevious =
          memoryType === "state" && stateKey
            ? (this.db
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
          const previous = this.db
            .prepare("SELECT node_id FROM memory_records WHERE id = ?")
            .get(supersedesId) as Row | undefined;
          if (!previous) throw new Error(`memory ${supersedesId} does not exist`);
          supersededNodeId = String(previous.node_id);
          this.db
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
        this.recordMemoryWriteEvent({
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
          this.refreshNodeResidence(supersededNodeId, memory.createdAt);
        }
        this.db.exec("COMMIT");
        return { history, node, memory };
      } catch (error) {
        this.db.exec("ROLLBACK");
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
      return this.recordMemoryWriteEvent({
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

    deriveMemory(input: DeriveMemoryInput): RememberResult {
      const sourceMemoryIds = [...new Set(input.sourceMemoryIds)];
      if (sourceMemoryIds.length < 2) {
        throw new Error("derived memories require at least two source memories");
      }
      const sources = sourceMemoryIds.map((id) => {
        const row = this.db
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

      this.db.exec("BEGIN IMMEDIATE");
      try {
        const linkEvidence = this.db.prepare(
          `INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
           VALUES (?, ?)`,
        );
        const linkDerivation = this.db.prepare(
          `INSERT INTO memory_derivations (derived_memory_id, source_memory_id)
           VALUES (?, ?)`,
        );
        for (const source of sources) {
          const evidenceIds = this.evidenceIds(String(source.id));
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
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      result.memory.evidenceIds = this.evidenceIds(result.memory.id);
      return result;
    }

    recordUsage(memoryIds: string[]): void {
      const uniqueIds = [...new Set(memoryIds)];
      if (uniqueIds.length === 0) return;

      const statement = this.db.prepare(
        `UPDATE memory_records
         SET access_count = access_count + 1,
             pending_access_count = pending_access_count + 1,
             last_accessed_at = ?
         WHERE id = ?`,
      );
      const now = new Date().toISOString();

      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of uniqueIds) statement.run(now, id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
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
        const row = this.db
          .prepare("SELECT content FROM history_records WHERE id = ?")
          .get(existing.historyId) as Row | undefined;
        if (row && String(row.content) === input.transcript) return existing;
      }

      this.db.exec("BEGIN IMMEDIATE");
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
        this.db
          .prepare(
            `INSERT INTO session_archives (session_id, history_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             history_id = excluded.history_id,
             created_at = excluded.created_at`,
          )
          .run(archive.sessionId, archive.historyId, archive.createdAt);
        if (existing && existing.historyId !== archive.historyId) {
          this.db
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
        this.db.exec("COMMIT");
        return archive;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    getSessionArchive(sessionId: string): SessionArchive | null {
      const row = this.db
        .prepare("SELECT * FROM session_archives WHERE session_id = ?")
        .get(sessionId) as Row | undefined;
      if (!row) return null;
      return {
        sessionId: String(row.session_id),
        historyId: String(row.history_id),
        createdAt: String(row.created_at),
      };
    }
  };
}
