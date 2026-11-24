import type { DatabaseSync } from "node:sqlite";
import { normalizeStatement } from "../memory-normalization.ts";
import { serializeScope } from "../scope.ts";
import type {
  ClaimOutcomeEvent,
  ClaimPosterior,
  HistoryRecord,
  MemoryMarker,
  MemoryNode,
  MemoryRecord,
  MemoryRelationRecord,
  MemoryWriteEvent,
  NodeRelation,
  TesseraRecord,
  TopologyProposal,
} from "../types.ts";
import type {
  MemoryCommitReceipt,
  MemoryCommitRequest,
  MemoryEntity,
  MemoryStateAlias,
} from "./backend.ts";

type PreparedStmt = ReturnType<DatabaseSync["prepare"]>;

const UPSERT_RECEIPT_SQL = `INSERT OR REPLACE INTO nmg_receipts VALUES (?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_SOURCE_SQL = `INSERT OR REPLACE INTO nmg_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_NODE_SQL = `INSERT OR REPLACE INTO nmg_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_MEMORY_SQL = `INSERT OR REPLACE INTO nmg_memories VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)`;
const DELETE_EVIDENCE_SQL = `DELETE FROM nmg_memory_evidence WHERE namespace=? AND memory_id=?`;
const INSERT_EVIDENCE_SQL = `INSERT OR REPLACE INTO nmg_memory_evidence VALUES (?, ?, ?, ?, ?)`;
const DELETE_DERIVED_REL_SQL = `DELETE FROM nmg_memory_relations WHERE namespace=? AND source_id=? AND origin IN ('supersedes', 'related')`;
const DEMOTE_MEMORY_RELS_SQL = `UPDATE nmg_memory_relations
  SET status='demoted'
  WHERE namespace=? AND status='consolidated' AND origin <> 'node_edge'
    AND ((source_id=? AND source_kind='memory') OR (target_id=? AND target_kind='memory'))`;
const UPSERT_RELATION_SQL = `INSERT OR REPLACE INTO nmg_memory_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_MARKERS_SQL = `DELETE FROM nmg_memory_markers WHERE namespace=? AND memory_id=?`;
const INSERT_MARKER_SQL = `INSERT OR REPLACE INTO nmg_memory_markers VALUES (?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_TESSERA_SQL = `INSERT OR REPLACE INTO nmg_tesserae VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_STATE_ALIAS_SQL = `INSERT OR REPLACE INTO nmg_state_aliases VALUES (?, ?, ?, ?, ?, ?)`;
const UPSERT_WRITE_EVENT_SQL = `INSERT OR REPLACE INTO nmg_write_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_RELATION_PROPOSAL_SQL = `INSERT OR REPLACE INTO nmg_relation_proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_CLAIM_POSTERIOR_SQL = `INSERT OR REPLACE INTO nmg_claim_posteriors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_CLAIM_OUTCOME_SQL = `INSERT OR REPLACE INTO nmg_claim_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_RESOLUTION_EVENT_SQL = `INSERT OR REPLACE INTO nmg_resolution_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export interface RelationalWriters {
  upsertReceipt: PreparedStmt;
  upsertSource: PreparedStmt;
  upsertNode: PreparedStmt;
  upsertMemory: PreparedStmt;
  deleteEvidence: PreparedStmt;
  insertEvidence: PreparedStmt;
  deleteDerivedRel: PreparedStmt;
  demoteMemoryRels: PreparedStmt;
  upsertRelation: PreparedStmt;
  deleteMarkers: PreparedStmt;
  insertMarker: PreparedStmt;
  upsertTessera: PreparedStmt;
  upsertStateAlias: PreparedStmt;
  upsertWriteEvent: PreparedStmt;
  upsertProposal: PreparedStmt;
  upsertPosterior: PreparedStmt;
  upsertOutcome: PreparedStmt;
  upsertResolutionEvent: PreparedStmt;
}

export function createRelationalWriters(db: DatabaseSync): RelationalWriters {
  return {
    upsertReceipt: db.prepare(UPSERT_RECEIPT_SQL),
    upsertSource: db.prepare(UPSERT_SOURCE_SQL),
    upsertNode: db.prepare(UPSERT_NODE_SQL),
    upsertMemory: db.prepare(UPSERT_MEMORY_SQL),
    deleteEvidence: db.prepare(DELETE_EVIDENCE_SQL),
    insertEvidence: db.prepare(INSERT_EVIDENCE_SQL),
    deleteDerivedRel: db.prepare(DELETE_DERIVED_REL_SQL),
    demoteMemoryRels: db.prepare(DEMOTE_MEMORY_RELS_SQL),
    upsertRelation: db.prepare(UPSERT_RELATION_SQL),
    deleteMarkers: db.prepare(DELETE_MARKERS_SQL),
    insertMarker: db.prepare(INSERT_MARKER_SQL),
    upsertTessera: db.prepare(UPSERT_TESSERA_SQL),
    upsertStateAlias: db.prepare(UPSERT_STATE_ALIAS_SQL),
    upsertWriteEvent: db.prepare(UPSERT_WRITE_EVENT_SQL),
    upsertProposal: db.prepare(UPSERT_RELATION_PROPOSAL_SQL),
    upsertPosterior: db.prepare(UPSERT_CLAIM_POSTERIOR_SQL),
    upsertOutcome: db.prepare(UPSERT_CLAIM_OUTCOME_SQL),
    upsertResolutionEvent: db.prepare(UPSERT_RESOLUTION_EVENT_SQL),
  };
}

export function parseNumericOrdinal(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(?:aml:[0-9a-f]+:)?(0|[1-9][0-9]*)$/u.exec(value);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) ? num : null;
}

function inferSourceKind(history: HistoryRecord): string {
  if (history.role === "explicit" && !history.sourceMessageId && !history.sourceRef) {
    return "explicit";
  }
  return "raw";
}

function memoryExtJson(memory: MemoryRecord): string {
  const ext: Record<string, unknown> = {};
  if (memory.claims !== null) ext.claims = memory.claims;
  if ("retentionChangedAt" in memory && memory.retentionChangedAt !== undefined) {
    ext.retentionChangedAt = memory.retentionChangedAt;
  }
  if ("quarantineUntil" in memory && memory.quarantineUntil !== undefined) {
    ext.quarantineUntil = memory.quarantineUntil;
  }
  if (memory.relatedMemoryIds.length > 0) ext.relatedMemoryIds = memory.relatedMemoryIds;
  return Object.keys(ext).length ? JSON.stringify(ext) : "";
}

function firstAttr(attrs: MemoryMarker["attributes"], keys: readonly string[]): unknown {
  if (!attrs) return undefined;
  for (const key of keys) {
    if (attrs[key] !== undefined && attrs[key] !== null) return attrs[key];
  }
  return undefined;
}

function markerKeyAndValue(marker: MemoryMarker, index: number): { key: string; value: string } {
  const attrs = marker.attributes;
  if (marker.kind === "aml_session" && typeof attrs?.session_id === "string") {
    return { key: "session_id", value: attrs.session_id };
  }
  const value = firstAttr(attrs, ["tesseraId", "sourceMemoryId", "trigger", "term", "value"]);
  return {
    key: String(index),
    value: value === undefined ? "" : String(value),
  };
}

export function writeReceiptRow(
  stmt: PreparedStmt,
  ns: string,
  receipt: MemoryCommitReceipt,
): void {
  const hasResult = receipt.result !== undefined ? 1 : 0;
  stmt.run(
    ns,
    receipt.operationId,
    receipt.requestHash,
    receipt.revision,
    JSON.stringify(receipt.resultIds),
    hasResult,
    hasResult ? JSON.stringify(receipt.result) : "",
  );
}

export function writeSourceRow(
  stmt: PreparedStmt,
  ns: string,
  h: HistoryRecord,
  sourceKindOverride?: string,
): void {
  stmt.run(
    ns,
    h.id,
    h.sessionId,
    h.sourceMessageId,
    parseNumericOrdinal(h.sourceMessageId),
    h.role,
    h.content,
    h.sourceRef,
    sourceKindOverride ?? inferSourceKind(h),
    h.createdAt,
    "",
  );
}

export function writeNodeRow(stmt: PreparedStmt, ns: string, node: MemoryNode): void {
  stmt.run(
    ns,
    node.id,
    node.canonicalName,
    node.canonicalName.trim().toLocaleLowerCase("en-US"),
    node.kind,
    node.summary,
    node.status,
    node.residence,
    node.unbound === undefined ? null : node.unbound ? 1 : 0,
    node.createdAt,
    node.updatedAt,
  );
}

function writeMemoryDerivedLinks(w: RelationalWriters, ns: string, m: MemoryRecord): void {
  w.deleteEvidence.run(ns, m.id);
  const evidenceList = m.evidenceIds.length ? m.evidenceIds : m.evidenceId ? [m.evidenceId] : [];
  evidenceList.forEach((sourceId, ordinal) => {
    const role = sourceId === m.evidenceId ? m.evidenceRole : "support";
    w.insertEvidence.run(ns, m.id, sourceId, role, ordinal);
  });

  w.deleteDerivedRel.run(ns, m.id);
  const activeRelStatus =
    m.status === "deleted" || m.markers.some((mk) => mk.kind === "forget")
      ? "demoted"
      : "consolidated";
  if (m.supersedesId) {
    w.upsertRelation.run(
      ns,
      `rel:sup:${m.id}->${m.supersedesId}`,
      m.id,
      m.supersedesId,
      "memory",
      "memory",
      "supersedes",
      1.0,
      activeRelStatus,
      "source->target",
      "supersedes",
      0,
      m.createdAt,
      "",
    );
  }
  m.relatedMemoryIds.forEach((relatedId, ordinal) => {
    if (!relatedId || relatedId === m.id) return;
    w.upsertRelation.run(
      ns,
      `rel:rel:${m.id}->${relatedId}`,
      m.id,
      relatedId,
      "memory",
      "memory",
      "related_to",
      0.8,
      activeRelStatus,
      "both",
      "related",
      ordinal,
      m.createdAt,
      "",
    );
  });

  w.deleteMarkers.run(ns, m.id);
  m.markers.forEach((marker, ordinal) => {
    const { key, value } = markerKeyAndValue(marker, ordinal);
    const attrJson = marker.attributes ? JSON.stringify(marker.attributes) : "";
    w.insertMarker.run(ns, m.id, ordinal, marker.kind, key, value, attrJson);
  });
}

export function isPurgedMemoryRecord(m: MemoryRecord): boolean {
  return (
    m.status === "deleted" ||
    Boolean(m.storageState) ||
    m.markers.some((marker) => marker.kind === "forget")
  );
}

function orEmpty(value: string | null | undefined): string {
  return value ?? "";
}

function sourceSessionFlag(m: MemoryRecord): number {
  if (m.sourceSessionId === undefined) return 0;
  return m.sourceSessionId === null ? 2 : 1;
}

function memoryScalarRowValues(
  ns: string,
  m: MemoryRecord,
  hasForget: number,
): Array<string | number | null> {
  return [
    ns,
    m.id,
    m.statement,
    normalizeStatement(m.statement),
    m.memoryType,
    m.status,
    orEmpty(m.storageState),
    m.resolution,
    m.residence,
    m.tier,
    m.importance,
    m.confidence,
    m.polarity,
    m.extractMethod,
    m.truthStatus,
    m.evidenceRole,
    m.writeReason,
    m.writeSource,
    hasForget,
    orEmpty(m.stateKey),
    orEmpty(m.predicateKey),
    serializeScope(m.scope),
    orEmpty(m.sessionId),
    orEmpty(m.sourceSessionId),
    sourceSessionFlag(m),
    m.sourceActor,
    m.nodeId,
    m.evidenceId,
    orEmpty(m.supersedesId),
    orEmpty(m.eventTime),
    m.createdAt,
    m.eventTime || m.createdAt,
    orEmpty(m.validFrom),
    orEmpty(m.validUntil),
    orEmpty(m.openedAt),
    orEmpty(m.promotedAt),
    orEmpty(m.expiresAt),
    m.accessCount,
    orEmpty(m.lastAccessedAt),
    memoryExtJson(m),
  ];
}

export function writeMemoryRow(w: RelationalWriters, ns: string, m: MemoryRecord): void {
  const hasForget = m.markers.some((marker) => marker.kind === "forget") ? 1 : 0;
  w.upsertMemory.run(...memoryScalarRowValues(ns, m, hasForget));
  writeMemoryDerivedLinks(w, ns, m);
  if (m.status === "deleted" || hasForget === 1) {
    w.demoteMemoryRels.run(ns, m.id, m.id);
  }
}

export function writeEdgeRelationRow(stmt: PreparedStmt, ns: string, edge: NodeRelation): void {
  const extJson = JSON.stringify({
    evidenceIds: edge.evidenceIds,
    residence: edge.residence,
    stability: edge.stability,
    fanBudget: edge.fanBudget,
    activationRule: edge.activationRule,
    consolidationSource: edge.consolidationSource,
    consolidatedAt: edge.consolidatedAt,
  });
  stmt.run(
    ns,
    edge.id,
    edge.sourceNodeId,
    edge.targetNodeId,
    "node",
    "node",
    edge.type,
    edge.strength,
    edge.status,
    edge.direction,
    "node_edge",
    0,
    edge.createdAt,
    extJson,
  );
}

export function writeMemoryRelationRow(
  stmt: PreparedStmt,
  ns: string,
  rel: MemoryRelationRecord,
): void {
  stmt.run(
    ns,
    rel.id,
    rel.sourceId,
    rel.targetId,
    rel.sourceKind,
    rel.targetKind,
    rel.relationType,
    rel.weight,
    rel.status,
    rel.direction,
    rel.origin,
    0,
    rel.createdAt,
    "",
  );
}

function writeTesseraRow(stmt: PreparedStmt, ns: string, t: TesseraRecord): void {
  stmt.run(
    ns,
    t.id,
    t.memoryId ?? null,
    t.path,
    t.snippet,
    t.label,
    t.kind ?? null,
    t.fileSimhash ?? null,
    t.createdAt,
  );
}

function writeStateAliasRow(stmt: PreparedStmt, ns: string, a: MemoryStateAlias): void {
  stmt.run(ns, a.id, a.aliasKey, a.canonicalKey, serializeScope(a.scope), a.createdAt);
}

export function writeAuditEventRow(stmt: PreparedStmt, ns: string, e: MemoryWriteEvent): void {
  stmt.run(
    ns,
    e.id,
    e.memoryId,
    e.historyId,
    e.sessionId,
    e.decision,
    e.policyReason,
    e.writeReason,
    e.writeSource,
    e.memoryType,
    e.requestedResidence,
    e.createdAt,
  );
}

function writeProposalRow(
  stmt: PreparedStmt,
  ns: string,
  p: TopologyProposal & { sessionId: string | null },
): void {
  stmt.run(
    ns,
    p.id,
    p.sessionId,
    p.proposalKey,
    p.type,
    p.relationType,
    p.status,
    p.observations,
    p.estimatedGain,
    p.createdAt,
    JSON.stringify(p),
  );
}

function writePosteriorRow(
  stmt: PreparedStmt,
  ns: string,
  entry: { id: string; sessionId: string | null; posterior: ClaimPosterior },
): void {
  const p = entry.posterior;
  stmt.run(
    ns,
    entry.id,
    p.memoryId,
    p.claimIndex,
    entry.sessionId,
    p.claimText,
    p.priorConfidence,
    p.alpha,
    p.beta,
    p.mean,
    p.conservativeLowerBound,
    p.independentVoteCount,
    p.updatedAt,
  );
}

function writeOutcomeRow(
  stmt: PreparedStmt,
  ns: string,
  e: ClaimOutcomeEvent & { sessionId: string | null },
): void {
  stmt.run(
    ns,
    e.id,
    e.memoryId,
    e.claimIndex,
    e.semanticTaskId,
    e.sessionId,
    e.outcome,
    e.source,
    e.sourceLineage,
    e.evidenceId,
    e.collectionOrigin,
    e.weight,
    e.activeGraphId,
    e.createdAt,
  );
}

type ResolutionEventEntity = Extract<MemoryEntity, { kind: "resolutionEvent" }>["value"];

function writeResolutionEventRow(stmt: PreparedStmt, ns: string, r: ResolutionEventEntity): void {
  stmt.run(
    ns,
    r.id,
    r.memoryId,
    r.sessionId,
    r.fromResolution,
    r.toResolution,
    r.openedAt,
    JSON.stringify(r.relatedMemoryIds),
    r.reason,
    r.createdAt,
  );
}

export function writeRelationalEntity(
  w: RelationalWriters,
  ns: string,
  entity: MemoryEntity,
): void {
  switch (entity.kind) {
    case "history":
      writeSourceRow(w.upsertSource, ns, entity.value);
      return;
    case "node":
      writeNodeRow(w.upsertNode, ns, entity.value);
      return;
    case "memory":
      writeMemoryRow(w, ns, entity.value);
      return;
    case "edge":
      writeEdgeRelationRow(w.upsertRelation, ns, entity.value);
      return;
    case "memoryRelation":
      writeMemoryRelationRow(w.upsertRelation, ns, entity.value);
      return;
    case "tessera":
      writeTesseraRow(w.upsertTessera, ns, entity.value);
      return;
    case "stateAlias":
      writeStateAliasRow(w.upsertStateAlias, ns, entity.value);
      return;
    case "writeEvent":
      writeAuditEventRow(w.upsertWriteEvent, ns, entity.value);
      return;
    case "relationProposal":
      writeProposalRow(w.upsertProposal, ns, entity.value);
      return;
    case "claimPosterior":
      writePosteriorRow(w.upsertPosterior, ns, entity.value);
      return;
    case "claimOutcome":
      writeOutcomeRow(w.upsertOutcome, ns, entity.value);
      return;
    case "resolutionEvent":
      writeResolutionEventRow(w.upsertResolutionEvent, ns, entity.value);
      return;
  }
}

export interface CommitDerivedSyncCallbacks {
  onMemoryText: (memory: MemoryRecord) => void;
  onMemoryPurged: (memoryId: string) => void;
  onTesseraText: (tessera: TesseraRecord) => void;
}

/** Persist a validated MemoryCommitRequest strictly into authoritative relational tables. */
export function writeRelationalCommit(
  db: DatabaseSync,
  namespace: string,
  request: MemoryCommitRequest,
  receipt: MemoryCommitReceipt,
  callbacks: CommitDerivedSyncCallbacks,
): void {
  const w = createRelationalWriters(db);
  for (const entity of request.changes.upsert) {
    writeRelationalEntity(w, namespace, entity);
    if (entity.kind === "memory") {
      callbacks.onMemoryText(entity.value);
      if (isPurgedMemoryRecord(entity.value)) {
        callbacks.onMemoryPurged(entity.value.id);
      }
    } else if (entity.kind === "tessera") {
      callbacks.onTesseraText(entity.value);
    }
  }
  for (const auditEvent of request.audit ?? []) {
    writeAuditEventRow(w.upsertWriteEvent, namespace, auditEvent);
  }
  writeReceiptRow(w.upsertReceipt, namespace, receipt);
}
