/**
 * writes cluster of NmgStore methods — official TypeScript mixin pattern
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

import type { Constructor } from "./store-ctor.ts";
import {
  NEAR_DUPLICATE_SCAN,
  NEAR_DUPLICATE_THRESHOLD,
  SUPERSEDE_CANDIDATE_MAX,
  SUPERSEDE_MIN_SHARED_TOKENS,
  SUPERSEDE_PREFILTER_MAX_TERMS,
} from "./graph-policy.ts";
import { nowMs, PerfTimer, SECTION } from "../perf.ts";
import { normalizeClaims } from "../claims.ts";
import { serializeScope } from "../scope.ts";
import {
  clamp,
  defaultResidence,
  defaultWriteReason,
  mapHistory,
  normalizeMarkers,
  requireText,
  serializeClaims,
  serializeMarkers,
} from "./rows.ts";
import type { StoreRow as Row } from "./search-ranking.ts";
import { normalizeStatement, searchTerms, statementSimilarity } from "./search-ranking.ts";
import { MAX_EVIDENCE_SOURCE_CHARACTERS } from "../types.ts";

import type {
  DeriveMemoryInput,
  DuplicateCandidate,
  HistoryRecord,
  MemoryClaim,
  HistoryRole,
  MemoryMarker,
  MemoryExportBundle,
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
  Polarity,
  RecordFeedbackInput,
} from "../types.ts";
import { assertTemporalValidity } from "../semantic-domain.ts";

export function withWrites<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    // Base-class members (resolved at assembly time)
    declare protected db: DatabaseSync;
    declare protected embedder: VectorEmbedder;

    // Cross-cluster calls (methods defined in other clusters or store.ts)
    declare protected requireNode: (nodeId: string) => MemoryNode;
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
    declare protected supersedeReachableFrom: (memoryId: string) => Set<string>;
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
      sessionId?: string | null;
      sourceMessageId?: string;
      sourceRef?: string;
    }): HistoryRecord {
      const content = requireText(input.content, "history content");
      const sourceMessageId = input.sourceMessageId?.trim() || null;
      if (sourceMessageId) {
        // Source-message deduplication is scoped by the row's session. LTG rows
        // are session-global (session_id NULL), so their evidence traces dedupe
        // against session_id IS NULL rather than requiring a sessionId.
        const existing = input.sessionId?.trim()
          ? (this.db
              .prepare(
                "SELECT * FROM history_records WHERE session_id = ? AND source_message_id = ?",
              )
              .get(input.sessionId, sourceMessageId) as Row | undefined)
          : (this.db
              .prepare(
                "SELECT * FROM history_records WHERE session_id IS NULL AND source_message_id = ?",
              )
              .get(sourceMessageId) as Row | undefined);
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
      resolution?: MemoryRecord["resolution"];
      openedAt?: string;
      relatedMemoryIds?: string[];
      evidenceRole?: MemoryRecord["evidenceRole"];
      supersedesId?: string;
      residence?: MemoryResidence;
      sessionId?: string | null;
      expiresAt?: string;
      writeReason?: string;
      writeSource?: MemoryRecord["writeSource"];
    }): MemoryRecord {
      const createdAt = new Date().toISOString();
      const validFrom = input.validFrom ?? createdAt;
      assertTemporalValidity({
        eventTime: input.eventTime,
        validFrom,
        validUntil: input.validUntil,
      });
      const residence = input.residence ?? defaultResidence(input);
      // Escape-hatch rule applies to EXPLICIT STG writes only: when a caller
      // deliberately targets STG (residence: "stg") it must declare row
      // ownership — string = session-private, null = explicitly shared.
      // defaultResidence-derived STG (derived/inferred/assistant-unverified) is
      // a system provisional path, not a "save-time bypass", so it is exempt.
      if (
        input.residence === "stg" &&
        !(input.markers ?? []).some((marker) => marker.kind === "cached_from_ltg") &&
        input.sessionId === undefined
      ) {
        throw new Error(
          'Explicit STG (residence: "stg") provisional writes require an explicit sessionId — ' +
            "string = session-private, null = explicitly shared (escape-hatch rule)",
        );
      }
      const writeSource =
        input.writeSource ?? (input.memoryType === "derived" ? "derived" : "core");
      const writeReason = input.writeReason?.trim() || defaultWriteReason(input, residence);
      const claimRollup = normalizeClaims(input.claims);
      const resolution = input.resolution ?? "resolved";
      const relatedMemoryIds = normalizeRelatedMemoryIds(input.relatedMemoryIds);
      if (resolution !== "resolved" && relatedMemoryIds.length === 0) {
        throw new Error("open memories require at least one relatedMemoryId");
      }
      requireRelatedMemories(this.db, relatedMemoryIds);
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
        validFrom,
        validUntil: input.validUntil ?? null,
        status: "active",
        resolution,
        openedAt: resolution === "resolved" ? null : (input.openedAt ?? createdAt),
        relatedMemoryIds,
        residence,
        sessionId: input.sessionId ?? null,
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
             valid_until, status, resolution, opened_at, related_memory_ids_json,
             residence, session_id, promoted_at, expires_at,
             evidence_role, supersedes_id, tier, importance,
             access_count, last_accessed_at, write_reason, write_source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
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
          memory.resolution,
          memory.openedAt,
          JSON.stringify(memory.relatedMemoryIds),
          memory.residence,
          memory.sessionId,
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
      perf.setTotal(nowMs() - startedAt);
      return Object.assign(result, { timings: perf.snapshot() });
    }

    rememberInner(input: RememberInput): RememberResult {
      const memoryType = input.memoryType ?? "fact";
      if (memoryType === "state" && !input.stateKey?.trim()) {
        throw new Error("state memories require a stable stateKey");
      }
      validateEvidenceSource(input);
      // Duplicate detection (read-only, pre-transaction): an exact normalized
      // duplicate in the same scope auto-skips (returns the existing record,
      // Mem0 hash-dedup pattern); near-duplicates surface as candidates for
      // the optional LLM judge (Neo4j SAME_AS review-queue pattern).
      const scopeJson = serializeScope(input.scope ?? {});
      const dupExact = this.db
        .prepare(
          `SELECT m.* FROM memory_records m
           WHERE m.statement = ? AND m.scope_json = ? AND m.status = 'active'
           ORDER BY m.created_at DESC LIMIT 1`,
        )
        .get(input.statement, scopeJson) as Record<string, unknown> | undefined;
      const dupCandidates = this.nearDuplicateCandidates(input.statement, scopeJson);
      // The supersede scan is O(scope size) per write and its result is only
      // consumed by an external judge; bulk ingestion without one skips it.
      const supersedeCands =
        input.supersedeScan === false
          ? []
          : this.supersedeCandidates(input.statement, scopeJson, input.polarity ?? null);
      if (dupExact) {
        const judge = input.judgeDuplicates;
        if (!judge || judge({ statement: input.statement, candidates: dupCandidates }).merge) {
          return this.duplicateResult(dupExact, [dupCandidate(dupExact, 1), ...dupCandidates]);
        }
      } else if (dupCandidates.length > 0) {
        // A normalized-exact match (similarity 1.0) is an exact duplicate too —
        // normalization catches case/punctuation/whitespace variants that the
        // SQL equality check misses. Auto-skip like the SQL-exact case.
        const normExact = dupCandidates[0]!.similarity >= 1 ? dupCandidates[0] : undefined;
        if (normExact) {
          const judge = input.judgeDuplicates;
          if (!judge || judge({ statement: input.statement, candidates: dupCandidates }).merge) {
            const targetRow = this.db
              .prepare("SELECT m.* FROM memory_records m WHERE m.id = ?")
              .get(normExact.memoryId) as Record<string, unknown>;
            return this.duplicateResult(targetRow, dupCandidates);
          }
        } else if (input.judgeDuplicates) {
          const decision = input.judgeDuplicates({
            statement: input.statement,
            candidates: dupCandidates,
          });
          if (decision.merge) {
            const targetRow = this.db
              .prepare("SELECT m.* FROM memory_records m WHERE m.id = ?")
              .get(dupCandidates[0]!.memoryId) as Record<string, unknown>;
            return this.duplicateResult(targetRow, dupCandidates);
          }
        }
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const history = input.evidenceHistoryId
          ? this.requireHistory(input.evidenceHistoryId)
          : this.appendHistory({
              content: input.evidenceSource?.content ?? input.evidence ?? input.statement,
              role: input.evidenceSource?.actor ?? "explicit",
              sessionId: input.sessionId,
              sourceMessageId: input.evidenceSource?.sourceMessageId,
              sourceRef: input.evidenceSource?.sourceRef ?? input.sourceRef,
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
            .prepare("SELECT node_id, scope_json, status FROM memory_records WHERE id = ?")
            .get(supersedesId) as Row | undefined;
          if (!previous) throw new Error(`memory ${supersedesId} does not exist`);
          if (String(previous.status) === "deleted") {
            throw new Error("deleted memories cannot participate in supersession");
          }
          if (String(previous.scope_json) !== serializeScope(input.scope ?? {})) {
            throw new Error("supersession requires identical memory scope");
          }
          const existingSuccessor = this.db
            .prepare("SELECT id FROM memory_records WHERE supersedes_id = ? LIMIT 1")
            .get(supersedesId) as Row | undefined;
          if (existingSuccessor) {
            throw new Error(
              `memory ${supersedesId} is already superseded by ${String(existingSuccessor.id)}`,
            );
          }
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
          resolution: input.resolution,
          openedAt: input.openedAt,
          relatedMemoryIds: input.relatedMemoryIds,
          evidenceRole: input.evidenceRole ?? (supersedesId ? "update" : undefined),
          supersedesId,
          residence: input.residence,
          sessionId: input.sessionId,
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
        const written = { history, node, memory };
        return {
          ...written,
          ...(dupCandidates.length > 0 ? { duplicates: dupCandidates } : {}),
          ...(supersedeCands.length > 0 ? { supersedeCandidates: supersedeCands } : {}),
        };
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    /**
     * Mark a same-scope memory as superseded by a newer record (deterministic
     * supersession, the MemStrata/MemClaw write-time pattern): the stale record
     * becomes status='superseded' with a valid_until, and the newer record
     * points back via supersedes_id. Retrieval already filters superseded rows,
     * so a superseded value stops appearing in future contexts. NMG only wires
     * the pointers — deciding WHICH candidate is superseded is the external
     * judge's job (it sees RememberResult.supersedeCandidates).
     */
    applySupersession(input: {
      newMemoryId: string;
      supersededMemoryId: string;
      validUntil?: string;
    }): void {
      const newer = this.db
        .prepare(
          "SELECT id, node_id, scope_json, status, supersedes_id FROM memory_records WHERE id = ?",
        )
        .get(input.newMemoryId) as Row | undefined;
      if (!newer) throw new Error(`memory ${input.newMemoryId} does not exist`);
      const stale = this.db
        .prepare("SELECT id, node_id, scope_json, status FROM memory_records WHERE id = ?")
        .get(input.supersededMemoryId) as Row | undefined;
      if (!stale) throw new Error(`memory ${input.supersededMemoryId} does not exist`);
      if (input.newMemoryId === input.supersededMemoryId) {
        throw new Error("a memory cannot supersede itself");
      }
      if (String(newer.status) === "deleted" || String(stale.status) === "deleted") {
        throw new Error("deleted memories cannot participate in supersession");
      }
      if (String(newer.scope_json) !== String(stale.scope_json)) {
        throw new Error("supersession requires identical memory scope");
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const existingPredecessor = newer.supersedes_id ? String(newer.supersedes_id) : null;
        if (existingPredecessor && existingPredecessor !== input.supersededMemoryId) {
          throw new Error(`memory ${input.newMemoryId} already supersedes ${existingPredecessor}`);
        }
        const existingSuccessor = this.db
          .prepare("SELECT id FROM memory_records WHERE supersedes_id = ? AND id <> ? LIMIT 1")
          .get(input.supersededMemoryId, input.newMemoryId) as Row | undefined;
        if (existingSuccessor) {
          throw new Error(
            `memory ${input.supersededMemoryId} is already superseded by ${String(existingSuccessor.id)}`,
          );
        }
        // Write-time cycle defence (docs §7.2): adding the edge
        // new→superseded forms a cycle exactly when `superseded` already
        // reaches `new` along supersedes_id edges. Reject the write instead of
        // corrupting the supersede DAG (the caller can pick another candidate).
        const reachable = this.supersedeReachableFrom(input.supersededMemoryId);
        if (reachable.has(input.newMemoryId)) {
          throw new Error(
            `applySupersession would create a supersede cycle: ` +
              `${input.newMemoryId} supersedes ${input.supersededMemoryId}, ` +
              `but ${input.supersededMemoryId} already reaches ${input.newMemoryId}`,
          );
        }
        this.db
          .prepare(
            `UPDATE memory_records
             SET status = 'superseded', valid_until = COALESCE(valid_until, ?)
             WHERE id = ?`,
          )
          .run(input.validUntil ?? new Date().toISOString(), input.supersededMemoryId);
        this.db
          .prepare(
            "UPDATE memory_records SET supersedes_id = ?, evidence_role = 'update' WHERE id = ?",
          )
          .run(input.supersededMemoryId, input.newMemoryId);
        if (String(stale.node_id) !== String(newer.node_id)) {
          this.refreshNodeResidence(String(stale.node_id), new Date().toISOString());
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    /**
     * Feedback-driven write-path maintenance — "the LLM lives in the feedback
     * loop, not the ingest path". The caller (an agent LLM, or an eval harness
     * simulating one) supplies semantic judgements AFTER answering, so NMG
     * needs no polarity/claims annotation at ingest time (0-annotation).
     *
     * - attributedMemoryIds → recordUsage (access_count / last_accessed_at)
     * - supersede     → applySupersession (mark the stale predecessor
     *   superseded). Soft signal: an invalid target (missing / already
     *   superseded / deleted) is ignored, never thrown to the caller.
     */
    recordFeedback(input: RecordFeedbackInput): void {
      if (input.attributedMemoryIds?.length) {
        this.recordUsage(input.attributedMemoryIds);
      }
      if (input.supersede) {
        const { supersededMemoryId, newMemoryId } = input.supersede;
        if (newMemoryId) {
          try {
            this.applySupersession({ newMemoryId, supersededMemoryId });
          } catch {
            // Soft maintenance signal — ignore an invalid supersede target.
          }
        } else {
          // Old-value-only: the caller knows the predecessor is stale but the
          // new value has not been ingested yet → mark disputed (retrieval
          // still surfaces it as stale) instead of superseded; a later ingest
          // of the same-topic new value supersedes it via supersedeCandidates.
          this.db
            .prepare(
              "UPDATE memory_records SET status = 'disputed' WHERE id = ? AND status = 'active'",
            )
            .run(supersededMemoryId);
        }
      }
      if (input.retrieveHints?.length) {
        for (const { memoryId, hints } of input.retrieveHints) {
          if (!hints.length) continue;
          const row = this.db
            .prepare("SELECT markers_json FROM memory_records WHERE id = ?")
            .get(memoryId) as Row | undefined;
          if (!row) continue; // soft signal — unknown target
          const raw = row.markers_json;
          const markers = (() => {
            if (raw == null) return [] as MemoryMarker[];
            try {
              return JSON.parse(String(raw)) as MemoryMarker[];
            } catch {
              return [] as MemoryMarker[];
            }
          })();
          let changed = false;
          for (const hint of hints) {
            if (!markers.some((m) => m.kind === "retrieveHint" && m.attributes?.value === hint)) {
              markers.push({ kind: "retrieveHint", attributes: { value: hint } });
              changed = true;
            }
          }
          if (changed) {
            this.db
              .prepare("UPDATE memory_records SET markers_json = ? WHERE id = ?")
              .run(JSON.stringify(markers), memoryId);
          }
        }
      }
    }

    /** Read one memory by id — used to confirm a feedback target's state. */
    getMemory(memoryId: string, sessionId?: string): MemoryRecord | null {
      // session-scoped: when a sessionId is supplied, a provisional row owned
      // by another session is invisible (shared rows with session_id NULL are
      // always visible). docs/stg-shared-store-v2 §3.2 / §3.6.
      const row = this.db
        .prepare(
          "SELECT * FROM memory_records WHERE id = ? AND ((? IS NOT NULL AND (session_id IS NULL OR session_id = ?)) OR (? IS NULL AND session_id IS NULL)) LIMIT 1",
        )
        .get(memoryId, sessionId ?? null, sessionId ?? null, sessionId ?? null) as Row | undefined;
      return row ? mapMemoryRow(row) : null;
    }

    /** Active LTG copies created specifically from one STG source memory. */
    consolidatedFromStg(sourceMemoryId: string): MemoryRecord[] {
      return (
        this.db
          .prepare(
            `SELECT DISTINCT m.*
               FROM memory_records m, json_each(m.markers_json) marker
              WHERE m.status = 'active'
                AND json_extract(marker.value, '$.kind') = 'consolidated_from_stg'
                AND json_extract(marker.value, '$.attributes.sourceMemoryId') = ?
              ORDER BY m.created_at, m.id`,
          )
          .all(sourceMemoryId) as Row[]
      ).map(mapMemoryRow);
    }

    exportMemories(
      input: {
        sourceActor?: MemoryRecord["sourceActor"];
        includeDeleted?: boolean;
      } = {},
    ): MemoryExportBundle {
      const clauses = [input.includeDeleted ? "1 = 1" : "status <> 'deleted'"];
      const params: string[] = [];
      if (input.sourceActor) {
        clauses.push("source_actor = ?");
        params.push(input.sourceActor);
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM memory_records WHERE ${clauses.join(" AND ")} ORDER BY created_at, id`,
        )
        .all(...params) as Record<string, unknown>[];
      return {
        format: "nmg.memory-export.v1",
        exportedAt: new Date().toISOString(),
        items: rows.map((row) => {
          const memory = mapMemoryRow(row);
          const evidenceIds = [...new Set([memory.evidenceId, ...this.evidenceIds(memory.id)])];
          memory.evidenceIds = evidenceIds;
          return {
            memory,
            node: this.requireNode(memory.nodeId),
            evidence: evidenceIds.map((id) => this.requireHistory(id)),
          };
        }),
      };
    }

    private nearDuplicateCandidates(statement: string, scopeJson: string): DuplicateCandidate[] {
      const inputNorm = normalizeStatement(statement);
      const recent = this.db
        .prepare(
          `SELECT m.id, m.node_id, m.statement, m.event_time FROM memory_records m
           WHERE m.scope_json = ? AND m.status = 'active'
           ORDER BY m.created_at DESC LIMIT ${NEAR_DUPLICATE_SCAN}`,
        )
        .all(scopeJson) as Record<string, unknown>[];
      const out: DuplicateCandidate[] = [];
      for (const row of recent) {
        if (String(row.statement) === statement) continue;
        const sim = statementSimilarity(inputNorm, normalizeStatement(String(row.statement)));
        if (sim >= NEAR_DUPLICATE_THRESHOLD) out.push(dupCandidate(row, sim));
      }
      out.sort((a, b) => b.similarity - a.similarity);
      return out;
    }

    /**
     * Same-scope active memories that share at least one content token with the
     * incoming statement (but are NOT near-duplicates — those are merge
     * territory). These are candidates for supersession: the incoming statement
     * may be the current value and one of these may be its stale predecessor.
     * Text-only heuristic; semantic judgement is delegated to an external judge.
     */
    private supersedeCandidates(
      statement: string,
      scopeJson: string,
      polarity: Polarity | null = null,
    ): DuplicateCandidate[] {
      // Token matching must survive case/punctuation drift across years of
      // dialogue: "Employed" vs "employed", "healthcare." vs "healthcare".
      // Normalize tokens to lowercased alphanumerics before comparing.
      const normalizeTok = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
      const inputTokens = new Set(
        searchTerms(statement)
          .map(normalizeTok)
          .filter((t) => t.length >= 2),
      );
      // A transition phrase ("Moving from being employed to self-employed",
      // "transitioned from A to B") names the OLD value on the "from" side.
      // Use those words as explicit recall keys — similarity (lexical or
      // vector) cannot separate a true predecessor from same-topic chit-chat,
      // but the language structure can. Mark such rows high-priority.
      const transitionTokens = transitionFromTokens(statement);
      if (inputTokens.size === 0 && transitionTokens.length === 0) return [];
      // Old values can sit arbitrarily far back in time (a 2025 employment
      // status superseded by a 2035 self-employment), so the candidate pool
      // must NOT be restricted to the most recent rows. Pre-filter by content
      // tokens via instr() (plain substring, no LIKE wildcards) to avoid a
      // full scope scan, then compute exact shared tokens (normalized).
      const transitionSet = new Set(transitionTokens);
      const contentTerms = [...inputTokens]
        .filter((term) => !transitionSet.has(term))
        .sort((left, right) => right.length - left.length || left.localeCompare(right));
      const likeTerms = [...new Set([...transitionTokens, ...contentTerms])].slice(
        0,
        SUPERSEDE_PREFILTER_MAX_TERMS,
      );
      const likeClause = likeTerms.map(() => `instr(lower(m.statement), ?) > 0`).join(" OR ");
      const params: string[] = likeTerms;
      const recent = this.db
        .prepare(
          `SELECT m.id, m.node_id, m.statement, m.event_time, m.polarity FROM memory_records m
           WHERE m.scope_json = ? AND m.status IN ('active', 'disputed') AND (${likeClause})
           ORDER BY m.created_at DESC`,
        )
        .all(scopeJson, ...params) as Record<string, unknown>[];
      const inputNorm = normalizeStatement(statement);
      // Polarity is caller-supplied metadata (the caller understands the
      // semantics: "no longer employed" is a negative update). A polarity flip
      // against a same-topic memory — new negative vs old affirmative, or the
      // reverse — is a strong "this stale value is over" signal that pure
      // lexical similarity cannot see (embeddings of a claim and its negation
      // sit too close together).
      const inputPol: Polarity | null =
        polarity === "negative" || polarity === "affirmative" ? polarity : null;
      const out: Array<{
        c: DuplicateCandidate;
        shared: number;
        transitionHit: boolean;
        polarityHit: boolean;
      }> = [];
      for (const row of recent) {
        const rowText = String(row.statement);
        if (rowText === statement) continue;
        const sim = statementSimilarity(inputNorm, normalizeStatement(rowText));
        // Near-duplicates (>= threshold) are merge candidates, not supersession ones.
        if (sim >= NEAR_DUPLICATE_THRESHOLD) continue;
        const shared = searchTerms(rowText)
          .map(normalizeTok)
          .filter((t) => inputTokens.has(t)).length;
        const transitionHit = transitionTokens.some((t) => rowText.toLowerCase().includes(t));
        const rowPol = String(row.polarity ?? "");
        const polarityHit =
          inputPol !== null &&
          (rowPol === "affirmative" || rowPol === "negative") &&
          rowPol !== inputPol;
        if (shared >= SUPERSEDE_MIN_SHARED_TOKENS || transitionHit || polarityHit) {
          const priority: "transition" | "polarity" | "token" = transitionHit
            ? "transition"
            : polarityHit
              ? "polarity"
              : "token";
          out.push({ c: dupCandidate(row, sim, priority), shared, transitionHit, polarityHit });
        }
      }
      // Transition-name hits and polarity flips go first (they name the
      // predecessor directly), then same-topic lexical overlap.
      out.sort(
        (a, b) =>
          Number(b.transitionHit || b.polarityHit) - Number(a.transitionHit || a.polarityHit) ||
          b.c.similarity - a.c.similarity,
      );
      return out.slice(0, SUPERSEDE_CANDIDATE_MAX).map((x) => x.c);
    }

    private duplicateResult(
      row: Record<string, unknown>,
      candidates: DuplicateCandidate[],
    ): RememberResult {
      return {
        history: this.requireHistory(String(row.evidence_id)),
        node: this.requireNode(String(row.node_id)),
        memory: mapMemoryRow(row),
        duplicates: candidates,
      };
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

/**
 * Detect "from X to Y" transition phrases ("Moving from being employed to
 * self-employed", "transitioned from A to B", "went from X to Y"). The
 * "from" side names the OLD value; those words are recall keys for the
 * superseded predecessor, which similarity (lexical or vector) cannot
 * separate from same-topic chit-chat.
 */
function validateEvidenceSource(input: RememberInput): void {
  const source = input.evidenceSource;
  if (!source) return;
  // sessionId attribution is required only for session-private STG rows.
  // LTG rows are project/session-global (session_id NULL) and the evidence
  // excerpt stays attributable via sourceMessageId + sourceRef.
  const residence = input.residence ?? defaultResidence(input);
  if (residence === "stg" && !input.sessionId?.trim()) {
    throw new Error("evidenceSource requires sessionId");
  }
  if (!source.sourceMessageId?.trim()) {
    throw new Error("evidenceSource requires sourceMessageId");
  }
  if (!source.content?.trim()) throw new Error("evidenceSource content must not be empty");
  if (source.content.length > MAX_EVIDENCE_SOURCE_CHARACTERS) {
    throw new Error(
      `evidenceSource exceeds ${MAX_EVIDENCE_SOURCE_CHARACTERS} characters; retain an exact excerpt or external artifact reference`,
    );
  }
  const actor = input.sourceActor ?? "user";
  if (source.actor !== actor) {
    throw new Error(`evidenceSource actor ${source.actor} does not match sourceActor ${actor}`);
  }
  const claimed = input.evidence?.trim();
  if (claimed && source.content.toLocaleLowerCase() !== claimed.toLocaleLowerCase()) {
    throw new Error("evidenceSource content must be the exact excerpt supplied as evidence");
  }
}

function transitionFromTokens(statement: string): string[] {
  const out: string[] = [];
  const re =
    /\b(?:moving|moved|transition(?:ing|ed)?|switch(?:ing|ed)?|shift(?:ing|ed)?|went|going|go|changed|change|increase(?:d)?)\s+from\b([^.;!?]{0,45}?)\s+(?:to|into)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(statement))) {
    const fragment = String(match[1])
      .replace(/\b(?:being|been|a|an|the|my|his|her|their|our|your)\b/gi, " ")
      .trim();
    for (const token of fragment.match(/[a-z0-9]{2,}/gi) ?? []) {
      out.push(token.toLowerCase());
    }
  }
  return [...new Set(out)];
}

function dupCandidate(
  row: Record<string, unknown>,
  similarity: number,
  priority: "transition" | "polarity" | "token" = "token",
): DuplicateCandidate {
  return {
    memoryId: String(row.id),
    nodeId: String(row.node_id),
    statement: String(row.statement),
    eventTime: (row.event_time as string | null) ?? null,
    similarity,
    priority,
  };
}

/** Row (snake_case memory_records) → MemoryRecord for duplicate short-circuits. */
function mapMemoryRow(row: Record<string, unknown>): MemoryRecord {
  const parse = (v: unknown, fallback: unknown) => {
    if (v == null) return fallback;
    try {
      return JSON.parse(String(v));
    } catch {
      return fallback;
    }
  };
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    evidenceId: String(row.evidence_id),
    evidenceIds: [String(row.evidence_id)],
    statement: String(row.statement),
    memoryType: (row.memory_type as MemoryRecord["memoryType"]) ?? "fact",
    stateKey: (row.state_key as string) ?? null,
    eventTime: (row.event_time as string) ?? null,
    sourceActor: (row.source_actor as MemoryRecord["sourceActor"]) ?? "user",
    truthStatus: (row.truth_status as MemoryRecord["truthStatus"]) ?? "asserted",
    confidence: (row.confidence as number) ?? null,
    polarity: (row.polarity as MemoryRecord["polarity"]) ?? null,
    predicateKey: (row.predicate_key as string) ?? null,
    extractMethod: (row.extract_method as MemoryRecord["extractMethod"]) ?? null,
    claims: parse(row.claims_json, null) as MemoryClaim[] | null,
    markers: parse(row.markers_json, []) as MemoryMarker[],
    scope: parse(row.scope_json, {}) as MemoryScope,
    validFrom: (row.valid_from as string) ?? null,
    validUntil: (row.valid_until as string) ?? null,
    status: (row.status as MemoryRecord["status"]) ?? "active",
    resolution: (row.resolution as MemoryRecord["resolution"]) ?? "resolved",
    openedAt: (row.opened_at as string) ?? null,
    relatedMemoryIds: parse(row.related_memory_ids_json, []) as string[],
    residence: (row.residence as MemoryRecord["residence"]) ?? "stg",
    sessionId: (row.session_id as string) ?? null,
    promotedAt: (row.promoted_at as string) ?? null,
    expiresAt: (row.expires_at as string) ?? null,
    evidenceRole: (row.evidence_role as MemoryRecord["evidenceRole"]) ?? "support",
    supersedesId: (row.supersedes_id as string) ?? null,
    tier: (row.tier as MemoryRecord["tier"]) ?? 1,
    importance: (row.importance as number) ?? 0.5,
    accessCount: (row.access_count as number) ?? 0,
    lastAccessedAt: (row.last_accessed_at as string) ?? null,
    writeReason: String(row.write_reason ?? ""),
    writeSource: (row.write_source as MemoryRecord["writeSource"]) ?? "core",
    createdAt: String(row.created_at),
  };
}

function normalizeRelatedMemoryIds(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

function requireRelatedMemories(db: DatabaseSync, ids: readonly string[]): void {
  const exists = db.prepare("SELECT 1 FROM memory_records WHERE id = ?");
  for (const id of ids) {
    if (!exists.get(id)) throw new Error(`related memory ${id} does not exist`);
  }
}
