import type { DatabaseSync } from "node:sqlite";
import { CANONICAL_EVENT_TIME_GLOB } from "../event-time.ts";
import { normalizeStatement } from "../memory-normalization.ts";
import { serializeScope } from "../scope.ts";
import { ftsExpression, surfaceTrigramExpression } from "../store/search-ranking.ts";
import type {
  HistoryRecord,
  MemoryActor,
  MemoryMarker,
  MemoryRecord,
  MemoryRelationRecord,
  MemoryScope,
  MemoryStorageState,
  MemoryType,
  NodeRelation,
  NodeRelationType,
} from "../types.ts";
import type {
  MemoryEntity,
  MemoryEntityQuery,
  MemoryRelationalProjectionPage,
  MemoryRelationalProjectionQuery,
  RelationalMemoryNeighbor,
} from "./backend.ts";

const RELATIONAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nmg_relational_backfill (
    namespace TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS nmg_sources (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    ordinal INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ext_json TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_sources_by_session_ord
    ON nmg_sources(namespace, session_id, ordinal, id);
  CREATE INDEX IF NOT EXISTS nmg_sources_by_msg
    ON nmg_sources(namespace, source_message_id, id);

  CREATE TABLE IF NOT EXISTS nmg_memories (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    statement TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    status TEXT NOT NULL,
    storage_state TEXT NOT NULL,
    resolution TEXT NOT NULL,
    residence TEXT NOT NULL,
    tier INTEGER NOT NULL,
    importance REAL NOT NULL,
    confidence REAL,
    polarity TEXT,
    has_forget INTEGER NOT NULL,
    state_key TEXT NOT NULL,
    predicate_key TEXT NOT NULL,
    scope TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    source_actor TEXT NOT NULL,
    node_id TEXT NOT NULL,
    primary_evidence_id TEXT NOT NULL,
    supersedes_id TEXT NOT NULL,
    event_time TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sort_time TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    access_count INTEGER NOT NULL,
    last_accessed_at TEXT NOT NULL,
    ext_json TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_memories_by_filter
    ON nmg_memories(namespace, status, storage_state, has_forget, sort_time DESC, id ASC);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_scope_node
    ON nmg_memories(namespace, scope, node_id, id);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_scope_state
    ON nmg_memories(namespace, scope, state_key, sort_time DESC, id ASC);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_session
    ON nmg_memories(namespace, source_session_id, sort_time DESC, id ASC);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_event_time
    ON nmg_memories(namespace, event_time, id);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_predicate
    ON nmg_memories(namespace, predicate_key, polarity, id);

  CREATE TABLE IF NOT EXISTS nmg_memory_evidence (
    namespace TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    role TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY(namespace, memory_id, source_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS nmg_memory_evidence_by_source
    ON nmg_memory_evidence(namespace, source_id, memory_id);

  CREATE TABLE IF NOT EXISTS nmg_memory_relations (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    weight REAL NOT NULL,
    status TEXT NOT NULL,
    direction TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_memory_relations_by_source
    ON nmg_memory_relations(namespace, source_id, status, relation_type, target_id);
  CREATE INDEX IF NOT EXISTS nmg_memory_relations_by_target
    ON nmg_memory_relations(namespace, target_id, status, relation_type, source_id);

  CREATE TABLE IF NOT EXISTS nmg_memory_markers (
    namespace TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    marker_key TEXT NOT NULL,
    marker_value TEXT NOT NULL,
    attr_json TEXT NOT NULL,
    PRIMARY KEY(namespace, memory_id, kind, marker_key, marker_value)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS nmg_memory_markers_by_kind_val
    ON nmg_memory_markers(namespace, kind, marker_value, memory_id);
`;

const UPSERT_SOURCE_SQL = `INSERT OR REPLACE INTO nmg_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_MEMORY_SQL = `INSERT OR REPLACE INTO nmg_memories VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)`;
const DELETE_EVIDENCE_SQL = `DELETE FROM nmg_memory_evidence WHERE namespace=? AND memory_id=?`;
const INSERT_EVIDENCE_SQL = `INSERT OR REPLACE INTO nmg_memory_evidence VALUES (?, ?, ?, ?, ?)`;
const DELETE_DERIVED_REL_SQL = `DELETE FROM nmg_memory_relations WHERE namespace=? AND source_id=? AND origin IN ('supersedes', 'related')`;
const UPSERT_RELATION_SQL = `INSERT OR REPLACE INTO nmg_memory_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_MARKERS_SQL = `DELETE FROM nmg_memory_markers WHERE namespace=? AND memory_id=?`;
const INSERT_MARKER_SQL = `INSERT OR REPLACE INTO nmg_memory_markers VALUES (?, ?, ?, ?, ?, ?)`;

function parseNumericOrdinal(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(?:aml:[0-9a-f]+:)?(0|[1-9][0-9]*)$/u.exec(value);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) ? num : null;
}

function sourceExtJson(history: HistoryRecord): string {
  const ext: Record<string, unknown> = {};
  if (history.sourceRef !== undefined) ext.sourceRef = history.sourceRef;
  return Object.keys(ext).length ? JSON.stringify(ext) : "";
}

function memoryExtJson(memory: MemoryRecord): string {
  const ext: Record<string, unknown> = {
    evidenceRole: memory.evidenceRole,
    truthStatus: memory.truthStatus,
    writeReason: memory.writeReason,
    writeSource: memory.writeSource,
  };
  if (memory.extractMethod !== null) ext.extractMethod = memory.extractMethod;
  if (memory.claims !== null) ext.claims = memory.claims;
  if (memory.openedAt !== null) ext.openedAt = memory.openedAt;
  if (memory.promotedAt !== null) ext.promotedAt = memory.promotedAt;
  if (memory.retentionChangedAt !== undefined) ext.retentionChangedAt = memory.retentionChangedAt;
  if (memory.quarantineUntil !== undefined) ext.quarantineUntil = memory.quarantineUntil;
  return JSON.stringify(ext);
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

function writeSourceRow(stmt: ReturnType<DatabaseSync["prepare"]>, ns: string, h: HistoryRecord) {
  stmt.run(
    ns,
    h.id,
    h.sessionId ?? "",
    h.sourceMessageId ?? "",
    parseNumericOrdinal(h.sourceMessageId),
    h.role,
    h.content,
    h.createdAt,
    sourceExtJson(h),
  );
}

interface MemoryWriters {
  upsertMemory: ReturnType<DatabaseSync["prepare"]>;
  deleteEvidence: ReturnType<DatabaseSync["prepare"]>;
  insertEvidence: ReturnType<DatabaseSync["prepare"]>;
  deleteDerivedRel: ReturnType<DatabaseSync["prepare"]>;
  upsertRelation: ReturnType<DatabaseSync["prepare"]>;
  deleteMarkers: ReturnType<DatabaseSync["prepare"]>;
  insertMarker: ReturnType<DatabaseSync["prepare"]>;
}

function createMemoryWriters(db: DatabaseSync): MemoryWriters {
  return {
    upsertMemory: db.prepare(UPSERT_MEMORY_SQL),
    deleteEvidence: db.prepare(DELETE_EVIDENCE_SQL),
    insertEvidence: db.prepare(INSERT_EVIDENCE_SQL),
    deleteDerivedRel: db.prepare(DELETE_DERIVED_REL_SQL),
    upsertRelation: db.prepare(UPSERT_RELATION_SQL),
    deleteMarkers: db.prepare(DELETE_MARKERS_SQL),
    insertMarker: db.prepare(INSERT_MARKER_SQL),
  };
}

function writeMemoryDerivedLinks(w: MemoryWriters, ns: string, m: MemoryRecord): void {
  w.deleteEvidence.run(ns, m.id);
  const evidenceList = m.evidenceIds.length ? m.evidenceIds : m.evidenceId ? [m.evidenceId] : [];
  evidenceList.forEach((sourceId, ordinal) => {
    const role = sourceId === m.evidenceId ? m.evidenceRole : "support";
    w.insertEvidence.run(ns, m.id, sourceId, role, ordinal);
  });

  w.deleteDerivedRel.run(ns, m.id);
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
      "consolidated",
      "source->target",
      "supersedes",
      m.createdAt,
    );
  }
  for (const relatedId of m.relatedMemoryIds) {
    if (!relatedId || relatedId === m.id) continue;
    w.upsertRelation.run(
      ns,
      `rel:rel:${m.id}->${relatedId}`,
      m.id,
      relatedId,
      "memory",
      "memory",
      "related_to",
      0.8,
      "consolidated",
      "both",
      "related",
      m.createdAt,
    );
  }

  w.deleteMarkers.run(ns, m.id);
  m.markers.forEach((marker, index) => {
    const { key, value } = markerKeyAndValue(marker, index);
    const attrJson = marker.attributes ? JSON.stringify(marker.attributes) : "";
    w.insertMarker.run(ns, m.id, marker.kind, key, value, attrJson);
  });
}

function writeMemoryRow(w: MemoryWriters, ns: string, m: MemoryRecord): void {
  const hasForget = m.markers.some((marker) => marker.kind === "forget") ? 1 : 0;
  w.upsertMemory.run(
    ns,
    m.id,
    m.statement,
    normalizeStatement(m.statement),
    m.memoryType,
    m.status,
    m.storageState ?? "",
    m.resolution,
    m.residence,
    m.tier,
    m.importance,
    m.confidence,
    m.polarity,
    hasForget,
    m.stateKey ?? "",
    m.predicateKey ?? "",
    serializeScope(m.scope),
    m.sessionId ?? "",
    m.sourceSessionId ?? "",
    m.sourceActor,
    m.nodeId,
    m.evidenceId,
    m.supersedesId ?? "",
    m.eventTime ?? "",
    m.createdAt,
    m.eventTime || m.createdAt,
    m.validFrom ?? "",
    m.validUntil ?? "",
    m.expiresAt ?? "",
    m.accessCount,
    m.lastAccessedAt ?? "",
    memoryExtJson(m),
  );
  writeMemoryDerivedLinks(w, ns, m);
}

function writeEdgeRelationRow(
  stmt: ReturnType<DatabaseSync["prepare"]>,
  ns: string,
  edge: NodeRelation,
): void {
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
    edge.createdAt,
  );
}

function writeMemoryRelationRow(
  stmt: ReturnType<DatabaseSync["prepare"]>,
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
    rel.createdAt,
  );
}

/** Ensure the 5-layer relational tables exist and backfill legacy entity rows for the namespace. */
export function ensureSqliteRelationalSchema(db: DatabaseSync, namespace: string): void {
  db.exec(RELATIONAL_SCHEMA_SQL);
  const done = db.prepare("SELECT 1 FROM nmg_relational_backfill WHERE namespace=?").get(namespace);
  if (done) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM nmg_relational_backfill WHERE namespace=?").get(namespace)) {
      const legacyRows = db
        .prepare(
          `SELECT kind, payload FROM nmg_memory_entities
           WHERE namespace=? AND kind IN ('history', 'memory', 'edge', 'memoryRelation')`,
        )
        .all(namespace);
      if (legacyRows.length) {
        const entities = legacyRows.map(
          (row) => ({ kind: row.kind, value: JSON.parse(String(row.payload)) }) as MemoryEntity,
        );
        writeSqliteRelationalEntities(db, namespace, entities);
      }
      db.prepare("INSERT OR IGNORE INTO nmg_relational_backfill VALUES (?)").run(namespace);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Synchronize written entities into the 5-layer relational tables inside the caller's transaction. */
export function writeSqliteRelationalEntities(
  db: DatabaseSync,
  namespace: string,
  entities: readonly MemoryEntity[],
): void {
  let upsertSource: ReturnType<DatabaseSync["prepare"]> | undefined;
  let memoryWriters: MemoryWriters | undefined;
  let upsertRelation: ReturnType<DatabaseSync["prepare"]> | undefined;

  for (const entity of entities) {
    if (entity.kind === "history") {
      upsertSource ??= db.prepare(UPSERT_SOURCE_SQL);
      writeSourceRow(upsertSource, namespace, entity.value);
    } else if (entity.kind === "memory") {
      memoryWriters ??= createMemoryWriters(db);
      writeMemoryRow(memoryWriters, namespace, entity.value);
    } else if (entity.kind === "edge") {
      upsertRelation ??= db.prepare(UPSERT_RELATION_SQL);
      writeEdgeRelationRow(upsertRelation, namespace, entity.value);
    } else if (entity.kind === "memoryRelation") {
      upsertRelation ??= db.prepare(UPSERT_RELATION_SQL);
      writeMemoryRelationRow(upsertRelation, namespace, entity.value);
    }
  }
}

interface SqlFilter {
  readonly sql: string;
  readonly bind: (string | number)[];
}

function buildRelationalWhere(
  namespace: string,
  query: MemoryRelationalProjectionQuery,
): SqlFilter {
  const clauses = ["m.namespace = ?"];
  const bind: (string | number)[] = [namespace];

  if (query.scope !== undefined) {
    clauses.push("m.scope = ?");
    bind.push(serializeScope(query.scope));
  }
  if (query.excludeScope !== undefined) {
    clauses.push("m.scope <> ?");
    bind.push(serializeScope(query.excludeScope));
  }
  if (query.nodeId !== undefined) {
    clauses.push("m.node_id = ?");
    bind.push(query.nodeId);
  }
  if (query.nodeIds !== undefined) {
    if (!query.nodeIds.length) clauses.push("1 = 0");
    else {
      clauses.push(`m.node_id IN (${query.nodeIds.map(() => "?").join(",")})`);
      bind.push(...query.nodeIds);
    }
  }
  if (query.stateKey !== undefined) {
    clauses.push("m.state_key = ?");
    bind.push(query.stateKey);
  }
  if (query.memoryType !== undefined) {
    clauses.push("m.memory_type = ?");
    bind.push(query.memoryType);
  }
  if (query.sourceActor !== undefined) {
    clauses.push("m.source_actor = ?");
    bind.push(query.sourceActor);
  }
  if (query.sourceSessionId !== undefined) {
    clauses.push(
      `(m.source_session_id = ? OR m.session_id = ? OR EXISTS (
        SELECT 1 FROM nmg_memory_markers mk
        WHERE mk.namespace=m.namespace AND mk.memory_id=m.id AND mk.kind='aml_session' AND mk.marker_value=?
      ))`,
    );
    bind.push(query.sourceSessionId, query.sourceSessionId, query.sourceSessionId);
  }
  appendTemporalAndVisibilityClauses(clauses, bind, query);
  return { sql: clauses.join(" AND "), bind };
}

function appendTemporalAndVisibilityClauses(
  clauses: string[],
  bind: (string | number)[],
  query: MemoryRelationalProjectionQuery,
): void {
  clauses.push("(m.session_id = '' OR m.session_id = ?)");
  bind.push(query.sessionId ?? "");
  if (query.maxTier !== undefined && query.maxTier < 3) {
    clauses.push("m.tier <= ?");
    bind.push(query.maxTier);
  }
  clauses.push("m.storage_state = ''");
  clauses.push("m.has_forget = 0");
  clauses.push("(m.expires_at = '' OR m.expires_at > ?)");
  bind.push(query.now);
  if (query.includeHistorical) {
    clauses.push("m.status <> 'deleted'");
  } else {
    clauses.push("m.status = 'active'");
    clauses.push("(m.valid_from = '' OR m.valid_from <= ?)");
    clauses.push("(m.valid_until = '' OR m.valid_until > ?)");
    bind.push(query.now, query.now);
  }
  if (query.eventTimeFrom) {
    clauses.push("m.event_time >= ? AND m.event_time GLOB ?");
    bind.push(query.eventTimeFrom, CANONICAL_EVENT_TIME_GLOB);
  }
  if (query.eventTimeTo) {
    clauses.push("m.event_time <= ? AND m.event_time GLOB ?");
    bind.push(query.eventTimeTo, CANONICAL_EVENT_TIME_GLOB);
  }
}

function buildTextFilterClause(namespace: string, text: string | undefined): SqlFilter | null {
  if (!text?.trim()) return null;
  const lexical = ftsExpression(text);
  const surface = surfaceTrigramExpression(text);
  if (!lexical && !surface) return { sql: "1 = 0", bind: [] };
  if (lexical && surface) {
    return {
      sql: `EXISTS (
        SELECT 1 FROM nmg_memory_fts_rows r
        WHERE r.namespace = ? AND r.key = 'memory:' || m.id AND (
          r.fts_rowid IN (SELECT rowid FROM nmg_memory_fts WHERE nmg_memory_fts MATCH ?)
          OR r.fts_rowid IN (SELECT rowid FROM nmg_memory_surface_fts WHERE nmg_memory_surface_fts MATCH ?)
        )
      )`,
      bind: [namespace, lexical, surface],
    };
  }
  const table = lexical ? "nmg_memory_fts" : "nmg_memory_surface_fts";
  const expr = lexical || surface;
  return {
    sql: `EXISTS (
      SELECT 1 FROM nmg_memory_fts_rows r
      WHERE r.namespace = ? AND r.key = 'memory:' || m.id
        AND r.fts_rowid IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ?)
    )`,
    bind: [namespace, expr],
  };
}

interface HydrateBuckets {
  evidence: Map<string, string[]>;
  markers: Map<string, MemoryMarker[]>;
  supersedes: Map<string, string>;
  related: Map<string, string[]>;
  relations: MemoryRelationRecord[];
}

function loadHydrateBuckets(
  db: DatabaseSync,
  namespace: string,
  memoryIds: readonly string[],
): HydrateBuckets {
  const idsJson = JSON.stringify(memoryIds);
  const evidence = new Map<string, string[]>();
  for (const row of db
    .prepare(
      `SELECT e.memory_id, e.source_id
       FROM json_each(?) wanted
       CROSS JOIN nmg_memory_evidence e ON e.namespace = ? AND e.memory_id = wanted.value
       ORDER BY e.memory_id, e.ordinal, e.source_id`,
    )
    .all(idsJson, namespace)) {
    const id = String(row.memory_id);
    const list = evidence.get(id) ?? [];
    list.push(String(row.source_id));
    evidence.set(id, list);
  }

  const markers = new Map<string, MemoryMarker[]>();
  for (const row of db
    .prepare(
      `SELECT mk.memory_id, mk.kind, mk.attr_json
       FROM json_each(?) wanted
       CROSS JOIN nmg_memory_markers mk ON mk.namespace = ? AND mk.memory_id = wanted.value`,
    )
    .all(idsJson, namespace)) {
    const id = String(row.memory_id);
    const list = markers.get(id) ?? [];
    const attrStr = String(row.attr_json);
    list.push(
      attrStr
        ? {
            kind: String(row.kind),
            attributes: JSON.parse(attrStr) as MemoryMarker["attributes"],
          }
        : { kind: String(row.kind) },
    );
    markers.set(id, list);
  }

  const supersedes = new Map<string, string>();
  const related = new Map<string, string[]>();
  const relations: MemoryRelationRecord[] = [];
  for (const row of db
    .prepare(
      `SELECT r.* FROM json_each(?) w
       CROSS JOIN nmg_memory_relations r INDEXED BY nmg_memory_relations_by_source
         ON r.namespace = ? AND r.source_id = w.value AND r.status = 'consolidated'
       UNION
       SELECT r.* FROM json_each(?) w
       CROSS JOIN nmg_memory_relations r INDEXED BY nmg_memory_relations_by_target
         ON r.namespace = ? AND r.target_id = w.value AND r.status = 'consolidated'`,
    )
    .all(idsJson, namespace, idsJson, namespace)) {
    const rel: MemoryRelationRecord = {
      id: String(row.id),
      sourceId: String(row.source_id),
      targetId: String(row.target_id),
      sourceKind: String(row.source_kind) as "memory" | "node",
      targetKind: String(row.target_kind) as "memory" | "node",
      relationType: String(row.relation_type) as NodeRelationType,
      weight: Number(row.weight),
      status: String(row.status) as "consolidated" | "demoted",
      direction: String(row.direction) as "both" | "source->target" | "target->source",
      origin: String(row.origin) as MemoryRelationRecord["origin"],
      createdAt: String(row.created_at),
    };
    relations.push(rel);
    if (rel.origin === "supersedes") supersedes.set(rel.sourceId, rel.targetId);
    if (rel.origin === "related") {
      const list = related.get(rel.sourceId) ?? [];
      list.push(rel.targetId);
      related.set(rel.sourceId, list);
    }
  }
  return { evidence, markers, supersedes, related, relations };
}

function strOrNull(value: unknown): string | null {
  return value ? String(value) : null;
}

function hydrateMemoryFromRow(row: Record<string, unknown>, buckets: HydrateBuckets): MemoryRecord {
  const id = String(row.id);
  const scopeStr = String(row.scope);
  const primaryEvidence = String(row.primary_evidence_id);
  const evList = buckets.evidence.get(id) ?? (primaryEvidence ? [primaryEvidence] : []);
  const storageState = strOrNull(row.storage_state) as Exclude<
    MemoryStorageState,
    "indexed"
  > | null;
  return {
    id,
    nodeId: String(row.node_id),
    evidenceId: primaryEvidence,
    evidenceIds: evList,
    statement: String(row.statement),
    memoryType: String(row.memory_type) as MemoryType,
    stateKey: strOrNull(row.state_key),
    eventTime: strOrNull(row.event_time),
    sourceActor: String(row.source_actor) as MemoryActor,
    truthStatus: "asserted",
    confidence: row.confidence === null ? null : Number(row.confidence),
    polarity: strOrNull(row.polarity) as MemoryRecord["polarity"],
    predicateKey: strOrNull(row.predicate_key),
    extractMethod: null,
    claims: null,
    markers: buckets.markers.get(id) ?? [],
    scope: (scopeStr === "{}" ? {} : JSON.parse(scopeStr)) as MemoryScope,
    validFrom: strOrNull(row.valid_from),
    validUntil: strOrNull(row.valid_until),
    status: String(row.status) as MemoryRecord["status"],
    ...(storageState ? { storageState } : {}),
    resolution: String(row.resolution) as MemoryRecord["resolution"],
    openedAt: null,
    relatedMemoryIds: buckets.related.get(id) ?? [],
    residence: String(row.residence) as MemoryRecord["residence"],
    promotedAt: null,
    expiresAt: strOrNull(row.expires_at),
    evidenceRole: "support",
    supersedesId: buckets.supersedes.get(id) ?? strOrNull(row.supersedes_id),
    sessionId: strOrNull(row.session_id),
    sourceSessionId: strOrNull(row.source_session_id),
    tier: Number(row.tier) as MemoryRecord["tier"],
    importance: Number(row.importance),
    accessCount: Number(row.access_count),
    lastAccessedAt: strOrNull(row.last_accessed_at),
    writeReason: "",
    writeSource: "agent",
    createdAt: String(row.created_at),
  };
}

/** Indexed relational memory projection with pagination and zero `JSON.parse(payload)`. */
export function projectRelationalMemories(
  db: DatabaseSync,
  namespace: string,
  query: MemoryRelationalProjectionQuery,
): MemoryRelationalProjectionPage {
  const filter = buildRelationalWhere(namespace, query);
  const textFilter = buildTextFilterClause(namespace, query.text);
  const where = textFilter ? `${filter.sql} AND ${textFilter.sql}` : filter.sql;
  const bind = textFilter ? [...filter.bind, ...textFilter.bind] : filter.bind;

  const rawRows = db
    .prepare(
      `SELECT m.id, m.statement, m.memory_type, m.status, m.storage_state, m.resolution,
         m.residence, m.tier, m.importance, m.confidence, m.polarity, m.state_key,
         m.predicate_key, m.scope, m.session_id, m.source_session_id, m.source_actor,
         m.node_id, m.primary_evidence_id, m.supersedes_id, m.event_time, m.created_at,
         m.valid_from, m.valid_until, m.expires_at, m.access_count, m.last_accessed_at
       FROM nmg_memories m
       WHERE ${where}
       ORDER BY m.sort_time DESC, m.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...bind, query.limit + 1, query.offset) as Array<Record<string, unknown>>;

  const hasMore = rawRows.length > query.limit;
  const pageRows = hasMore ? rawRows.slice(0, query.limit) : rawRows;
  if (!pageRows.length) return { memories: [], relations: [], hasMore: false };

  const memoryIds = pageRows.map((row) => String(row.id));
  const buckets = loadHydrateBuckets(db, namespace, memoryIds);
  return {
    memories: pageRows.map((row) => hydrateMemoryFromRow(row, buckets)),
    relations: buckets.relations,
    hasMore,
  };
}

function appendUniqueNeighbor(
  seen: Set<string>,
  out: RelationalMemoryNeighbor[],
  entity: Extract<MemoryEntity, { kind: "memory" }>,
  reason: RelationalMemoryNeighbor["reason"],
): void {
  if (seen.has(entity.value.id)) return;
  seen.add(entity.value.id);
  out.push({ entity, reason });
}

/** Discover node-free relational neighbors (memory relations, stateKey peers, same event day). */
export function readRelationalMemoryNeighbors(
  db: DatabaseSync,
  namespace: string,
  anchor: MemoryRecord,
  query: MemoryEntityQuery,
): RelationalMemoryNeighbor[] {
  const limit = query.limit ?? 8;
  const scopeStr = serializeScope(query.scope ?? anchor.scope);
  const sessionId = query.sessionId ?? "";
  const out: RelationalMemoryNeighbor[] = [];
  const seen = new Set<string>([anchor.id]);

  const relIds = db
    .prepare(
      `SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END AS neighbor_id
       FROM nmg_memory_relations
       WHERE namespace = ? AND status = 'consolidated'
         AND ((source_id = ? AND target_kind = 'memory') OR (target_id = ? AND source_kind = 'memory'))
       ORDER BY weight DESC, id ASC LIMIT ?`,
    )
    .all(anchor.id, namespace, anchor.id, anchor.id, limit)
    .map((row) => String(row.neighbor_id));

  const readMemoriesByIds = (ids: readonly string[]) => {
    if (!ids.length) return [];
    const rows = db
      .prepare(
        `SELECT m.id, m.statement, m.memory_type, m.status, m.storage_state, m.resolution,
           m.residence, m.tier, m.importance, m.confidence, m.polarity, m.state_key,
           m.predicate_key, m.scope, m.session_id, m.source_session_id, m.source_actor,
           m.node_id, m.primary_evidence_id, m.supersedes_id, m.event_time, m.created_at,
           m.valid_from, m.valid_until, m.expires_at, m.access_count, m.last_accessed_at
         FROM nmg_memories m
         WHERE m.namespace = ? AND m.id IN (SELECT value FROM json_each(?))
           AND m.scope = ? AND (m.session_id = '' OR m.session_id = ?) AND m.status <> 'deleted'`,
      )
      .all(namespace, JSON.stringify(ids), scopeStr, sessionId) as Array<Record<string, unknown>>;
    if (!rows.length) return [];
    const buckets = loadHydrateBuckets(
      db,
      namespace,
      rows.map((r) => String(r.id)),
    );
    return rows.map((row) => hydrateMemoryFromRow(row, buckets));
  };

  for (const memory of readMemoriesByIds(relIds)) {
    appendUniqueNeighbor(seen, out, { kind: "memory", value: memory }, "memory_relation");
  }

  if (out.length < limit && anchor.stateKey) {
    const stateIds = db
      .prepare(
        `SELECT id FROM nmg_memories
         WHERE namespace = ? AND scope = ? AND state_key = ? AND id <> ?
           AND (session_id = '' OR session_id = ?) AND status <> 'deleted'
         ORDER BY COALESCE(NULLIF(event_time, ''), created_at) DESC, id ASC LIMIT ?`,
      )
      .all(namespace, scopeStr, anchor.stateKey, anchor.id, sessionId, limit)
      .map((row) => String(row.id));
    for (const memory of readMemoriesByIds(stateIds)) {
      appendUniqueNeighbor(seen, out, { kind: "memory", value: memory }, "same_state");
    }
  }

  const dayPrefix = (anchor.eventTime ?? "").slice(0, 10);
  if (out.length < limit && /^\d{4}-\d{2}-\d{2}$/u.test(dayPrefix)) {
    const dayIds = db
      .prepare(
        `SELECT id FROM nmg_memories
         WHERE namespace = ? AND scope = ? AND event_time >= ? AND event_time < ? AND id <> ?
           AND (session_id = '' OR session_id = ?) AND status <> 'deleted'
         ORDER BY event_time ASC, id ASC LIMIT ?`,
      )
      .all(namespace, scopeStr, `${dayPrefix}T`, `${dayPrefix}\uffff`, anchor.id, sessionId, limit)
      .map((row) => String(row.id));
    for (const memory of readMemoriesByIds(dayIds)) {
      appendUniqueNeighbor(seen, out, { kind: "memory", value: memory }, "same_event_day");
    }
  }

  return out.slice(0, limit);
}

/** Read canonical session IDs and numeric turn ordinals for a batch of source evidence IDs. */
export function readSourceTurnMetadata(
  db: DatabaseSync,
  namespace: string,
  sourceIds: readonly string[],
): Map<string, { sessionId: string | null; ordinal: number | null }> {
  const result = new Map<string, { sessionId: string | null; ordinal: number | null }>();
  if (!sourceIds.length) return result;
  const rows = db
    .prepare(
      `SELECT s.id, s.session_id, COALESCE(s.ordinal, s.rowid) AS ordinal
       FROM json_each(?) j
       CROSS JOIN nmg_sources s ON s.namespace = ? AND s.id = j.value`,
    )
    .all(JSON.stringify(sourceIds), namespace) as Array<{
    id: string;
    session_id: string;
    ordinal: number | null;
  }>;
  for (const row of rows) {
    result.set(String(row.id), {
      sessionId: row.session_id ? String(row.session_id) : null,
      ordinal: typeof row.ordinal === "number" && Number.isFinite(row.ordinal) ? row.ordinal : null,
    });
  }
  return result;
}
