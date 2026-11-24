import type { DatabaseSync } from "node:sqlite";
import { CANONICAL_EVENT_TIME_GLOB } from "../event-time.ts";
import { normalizeStatement } from "../memory-normalization.ts";
import { serializeScope } from "../scope.ts";
import { ftsExpression, surfaceTrigramExpression } from "../store/search-ranking.ts";
import type {
  ClaimOutcomeEvent,
  HistoryRecord,
  HistoryRole,
  MemoryActor,
  MemoryClaim,
  MemoryMarker,
  MemoryNode,
  MemoryNodeKind,
  MemoryRecord,
  MemoryRelationRecord,
  MemoryScope,
  MemoryStatus,
  MemoryStorageState,
  MemoryType,
  NodeRelation,
  NodeRelationType,
  TesseraRecord,
  TopologyProposal,
} from "../types.ts";
import {
  sessionScopedEntity,
  type MemoryCommitReceipt,
  type MemoryEntity,
  type MemoryEntityQuery,
  type MemoryRelationalProjectionPage,
  type MemoryRelationalProjectionQuery,
  type RelationalMemoryNeighbor,
} from "./backend.ts";
import { queryBounds } from "./entity-rows.ts";

const SURFACE_TRIGRAM_WEIGHT = 0.35;

export const MEMORY_SELECT_COLUMNS = `m.id, m.statement, m.memory_type, m.status, m.storage_state,
  m.resolution, m.residence, m.tier, m.importance, m.confidence, m.polarity, m.extract_method,
  m.truth_status, m.evidence_role, m.write_reason, m.write_source, m.state_key, m.predicate_key,
  m.scope, m.session_id, m.source_session_id, m.has_source_session, m.source_actor, m.node_id,
  m.primary_evidence_id, m.supersedes_id, m.event_time, m.created_at, m.valid_from, m.valid_until,
  m.opened_at, m.promoted_at, m.expires_at, m.access_count, m.last_accessed_at, m.ext_json`;

export interface SqlFilter {
  readonly sql: string;
  readonly bind: (string | number)[];
}

interface HydrateBuckets {
  evidence: Map<string, string[]>;
  markers: Map<string, MemoryMarker[]>;
  related: Map<string, string[]>;
  relations: MemoryRelationRecord[];
}

function strOrNull(value: unknown): string | null {
  return value ? String(value) : null;
}

function parseExtJson(raw: unknown): Record<string, unknown> {
  const str = typeof raw === "string" ? raw : raw ? String(raw) : "";
  return str ? (JSON.parse(str) as Record<string, unknown>) : {};
}

export function loadHydrateBuckets(
  db: DatabaseSync,
  namespace: string,
  memoryIds: readonly string[],
): HydrateBuckets {
  const evidence = new Map<string, string[]>();
  const markers = new Map<string, MemoryMarker[]>();
  const related = new Map<string, string[]>();
  const relations: MemoryRelationRecord[] = [];
  if (!memoryIds.length) return { evidence, markers, related, relations };
  const idsJson = JSON.stringify(memoryIds);

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

  for (const row of db
    .prepare(
      `SELECT mk.memory_id, mk.kind, mk.attr_json
       FROM json_each(?) wanted
       CROSS JOIN nmg_memory_markers mk ON mk.namespace = ? AND mk.memory_id = wanted.value
       ORDER BY mk.memory_id, mk.ordinal`,
    )
    .all(idsJson, namespace)) {
    const id = String(row.memory_id);
    const list = markers.get(id) ?? [];
    const attrStr = String(row.attr_json);
    list.push(
      attrStr
        ? { kind: String(row.kind), attributes: JSON.parse(attrStr) as MemoryMarker["attributes"] }
        : { kind: String(row.kind) },
    );
    markers.set(id, list);
  }

  for (const row of db
    .prepare(
      `SELECT r.* FROM json_each(?) w
       CROSS JOIN nmg_memory_relations r INDEXED BY nmg_memory_relations_by_source
         ON r.namespace = ? AND r.source_id = w.value AND r.status = 'consolidated'
       UNION
       SELECT r.* FROM json_each(?) w
       CROSS JOIN nmg_memory_relations r INDEXED BY nmg_memory_relations_by_target
         ON r.namespace = ? AND r.target_id = w.value AND r.status = 'consolidated'
       ORDER BY ordinal, created_at, id`,
    )
    .all(idsJson, namespace, idsJson, namespace)) {
    const rel = mapMemoryRelationRow(row);
    relations.push(rel);
    if (rel.origin === "related") {
      const list = related.get(rel.sourceId) ?? [];
      list.push(rel.targetId);
      related.set(rel.sourceId, list);
    }
  }
  return { evidence, markers, related, relations };
}

function strOrDefault(value: unknown, fallback: string): string {
  return value ? String(value) : fallback;
}

function applyOptionalHydratedFields(
  record: MemoryRecord,
  row: Record<string, unknown>,
  ext: Record<string, unknown>,
): void {
  const storageState = strOrNull(row.storage_state) as Exclude<
    MemoryStorageState,
    "indexed"
  > | null;
  if (storageState) record.storageState = storageState;
  const hasSourceSession = Number(row.has_source_session ?? 0);
  if (hasSourceSession === 1) record.sourceSessionId = String(row.source_session_id);
  else if (hasSourceSession === 2) record.sourceSessionId = null;
  if ("retentionChangedAt" in ext)
    record.retentionChangedAt = ext.retentionChangedAt as string | null;
  if ("quarantineUntil" in ext) record.quarantineUntil = ext.quarantineUntil as string | null;
}

function hydrateMemoryFromRow(row: Record<string, unknown>, buckets: HydrateBuckets): MemoryRecord {
  const id = String(row.id);
  const scopeStr = String(row.scope);
  const primaryEvidence = String(row.primary_evidence_id);
  const ext = parseExtJson(row.ext_json);
  const record: MemoryRecord = {
    id,
    nodeId: String(row.node_id),
    evidenceId: primaryEvidence,
    evidenceIds: buckets.evidence.get(id) ?? (primaryEvidence ? [primaryEvidence] : []),
    statement: String(row.statement),
    memoryType: String(row.memory_type) as MemoryType,
    stateKey: strOrNull(row.state_key),
    eventTime: strOrNull(row.event_time),
    sourceActor: String(row.source_actor) as MemoryActor,
    truthStatus: strOrDefault(row.truth_status, "asserted") as MemoryRecord["truthStatus"],
    confidence: row.confidence === null ? null : Number(row.confidence),
    polarity: strOrNull(row.polarity) as MemoryRecord["polarity"],
    predicateKey: strOrNull(row.predicate_key),
    extractMethod: strOrNull(row.extract_method) as MemoryRecord["extractMethod"],
    claims: (ext.claims as MemoryClaim[] | undefined) ?? null,
    markers: buckets.markers.get(id) ?? [],
    scope: (scopeStr === "{}" ? {} : JSON.parse(scopeStr)) as MemoryScope,
    validFrom: strOrNull(row.valid_from),
    validUntil: strOrNull(row.valid_until),
    status: String(row.status) as MemoryStatus,
    resolution: String(row.resolution) as MemoryRecord["resolution"],
    openedAt: strOrNull(row.opened_at),
    relatedMemoryIds:
      (ext.relatedMemoryIds as string[] | undefined) ?? buckets.related.get(id) ?? [],
    residence: String(row.residence) as MemoryRecord["residence"],
    promotedAt: strOrNull(row.promoted_at),
    expiresAt: strOrNull(row.expires_at),
    evidenceRole: strOrDefault(row.evidence_role, "support") as MemoryRecord["evidenceRole"],
    supersedesId: strOrNull(row.supersedes_id),
    sessionId: strOrNull(row.session_id),
    tier: Number(row.tier) as MemoryRecord["tier"],
    importance: Number(row.importance),
    accessCount: Number(row.access_count),
    lastAccessedAt: strOrNull(row.last_accessed_at),
    writeReason: strOrDefault(row.write_reason, ""),
    writeSource: strOrDefault(row.write_source, "agent") as MemoryRecord["writeSource"],
    createdAt: String(row.created_at),
  };
  applyOptionalHydratedFields(record, row, ext);
  return record;
}

export function hydrateMemoriesFromRows(
  db: DatabaseSync,
  namespace: string,
  rows: readonly Record<string, unknown>[],
): { memories: MemoryRecord[]; relations: MemoryRelationRecord[] } {
  if (!rows.length) return { memories: [], relations: [] };
  const buckets = loadHydrateBuckets(
    db,
    namespace,
    rows.map((row) => String(row.id)),
  );
  return {
    memories: rows.map((row) => hydrateMemoryFromRow(row, buckets)),
    relations: buckets.relations,
  };
}

function appendIdListFilter(
  clauses: string[],
  bind: (string | number)[],
  column: string,
  ids: readonly string[],
  label: string,
): void {
  if (ids.length > 512) throw new Error(`At most 512 ${label} per read`);
  if (!ids.length) {
    clauses.push("1 = 0");
    return;
  }
  if (ids.length === 1) {
    clauses.push(`${column} = ?`);
    bind.push(ids[0]!);
    return;
  }
  clauses.push(`${column} IN (${ids.map(() => "?").join(",")})`);
  bind.push(...ids);
}

/** Build a parameterized relational SQL WHERE predicate for `nmg_memories` queries. */
export function buildMemoryQueryFilter(
  namespace: string,
  query: Partial<MemoryEntityQuery>,
  alias = "m",
): SqlFilter {
  const p = alias ? `${alias}.` : "";
  const clauses = [`${p}namespace = ?`];
  const bind: (string | number)[] = [namespace];
  if (query.ids) appendIdListFilter(clauses, bind, `${p}id`, query.ids, "entity IDs");
  if (query.nodeId !== undefined) {
    clauses.push(`${p}node_id = ?`);
    bind.push(query.nodeId);
  }
  if (query.nodeIds) appendIdListFilter(clauses, bind, `${p}node_id`, query.nodeIds, "node IDs");
  if (query.exactText !== undefined) {
    clauses.push(`${p}normalized_name = ?`);
    bind.push(normalizeStatement(query.exactText));
  }
  if (query.stateKey !== undefined) {
    clauses.push(`${p}state_key = ?`);
    bind.push(query.stateKey);
  }
  if (query.scope !== undefined) {
    clauses.push(`${p}scope = ?`);
    bind.push(serializeScope(query.scope));
  }
  if (query.excludeScope !== undefined) {
    clauses.push(`${p}scope <> ?`);
    bind.push(serializeScope(query.excludeScope));
  }
  clauses.push(`(${p}session_id = '' OR ${p}session_id = ?)`);
  bind.push(query.sessionId ?? "");
  appendMemoryExtraClauses(clauses, bind, query, p);
  return { sql: clauses.join(" AND "), bind };
}

function appendMemoryExtraClauses(
  clauses: string[],
  bind: (string | number)[],
  query: Omit<MemoryEntityQuery, "kind">,
  p: string,
): void {
  if (query.supersedesId) {
    clauses.push(`${p}supersedes_id = ?`);
    bind.push(query.supersedesId);
  }
  if (query.consolidatedFrom) {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM nmg_memory_markers mk INDEXED BY nmg_memory_markers_by_kind_val
        WHERE mk.namespace = ${p}namespace AND mk.kind = 'consolidated_from_stg'
          AND mk.marker_value = ? AND mk.memory_id = ${p}id
      )`,
    );
    bind.push(query.consolidatedFrom);
  }
  if (query.eventTimeFrom) {
    clauses.push(`${p}event_time >= ?`);
    bind.push(query.eventTimeFrom);
  }
  if (query.eventTimeTo) {
    clauses.push(`${p}event_time <= ?`);
    bind.push(query.eventTimeTo);
  }
  if (query.eventTimeFrom || query.eventTimeTo) {
    clauses.push(`${p}event_time GLOB ?`);
    bind.push(CANONICAL_EVENT_TIME_GLOB);
  }
}

function buildRelationalWhere(
  namespace: string,
  query: MemoryRelationalProjectionQuery,
): SqlFilter {
  const base = buildMemoryQueryFilter(
    namespace,
    {
      scope: query.scope,
      excludeScope: query.excludeScope,
      nodeId: query.nodeId,
      nodeIds: query.nodeIds,
      stateKey: query.stateKey,
      sessionId: query.sessionId,
      eventTimeFrom: query.eventTimeFrom,
      eventTimeTo: query.eventTimeTo,
    },
    "m",
  );
  const clauses = [base.sql];
  const bind = [...base.bind];
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
  if (query.evidenceId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM nmg_memory_evidence e WHERE e.namespace=m.namespace AND e.source_id=? AND e.memory_id=m.id)`,
    );
    bind.push(query.evidenceId);
  }
  if (query.relationTypes?.length) {
    const placeholders = query.relationTypes.map(() => "?").join(",");
    clauses.push(
      `EXISTS (
        SELECT 1 FROM nmg_memory_relations r
        WHERE r.namespace=m.namespace AND r.status='consolidated'
          AND r.relation_type IN (${placeholders})
          AND (r.source_id=m.id OR r.target_id=m.id)
      )`,
    );
    bind.push(...query.relationTypes);
  }
  appendProjectionVisibility(clauses, bind, query);
  return { sql: clauses.join(" AND "), bind };
}

function appendProjectionVisibility(
  clauses: string[],
  bind: (string | number)[],
  query: MemoryRelationalProjectionQuery,
): void {
  if (query.maxTier !== undefined && query.maxTier < 3) {
    clauses.push("m.tier <= ?");
    bind.push(query.maxTier);
  }
  clauses.push("m.storage_state = ''");
  clauses.push("m.has_forget = 0");
  clauses.push("(m.expires_at = '' OR m.expires_at > ?)");
  bind.push(query.now);
  if (query.statuses?.length) {
    clauses.push(`m.status IN (${query.statuses.map(() => "?").join(",")})`);
    bind.push(...query.statuses);
    return;
  }
  if (query.includeHistorical) {
    clauses.push("m.status <> 'deleted'");
  } else {
    clauses.push("m.status = 'active'");
    clauses.push("(m.valid_from = '' OR m.valid_from <= ?)");
    clauses.push("(m.valid_until = '' OR m.valid_until > ?)");
    bind.push(query.now, query.now);
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
  return {
    sql: `EXISTS (
      SELECT 1 FROM nmg_memory_fts_rows r
      WHERE r.namespace = ? AND r.key = 'memory:' || m.id
        AND r.fts_rowid IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ?)
    )`,
    bind: [namespace, lexical || surface],
  };
}

/** Indexed relational memory projection with pagination and zero entity-table dependency. */
export function projectRelationalMemories(
  db: DatabaseSync,
  namespace: string,
  query: MemoryRelationalProjectionQuery,
): MemoryRelationalProjectionPage {
  const filter = buildRelationalWhere(namespace, query);
  const textFilter = buildTextFilterClause(namespace, query.text);
  const where = textFilter ? `${filter.sql} AND ${textFilter.sql}` : filter.sql;
  const bind = textFilter ? [...filter.bind, ...textFilter.bind] : filter.bind;

  const orderBy =
    query.eventTimeFrom || query.eventTimeTo
      ? "m.event_time DESC, m.id ASC"
      : "m.sort_time DESC, m.id ASC";
  const rawRows = db
    .prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS}
       FROM nmg_memories m
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(...bind, query.limit + 1, query.offset) as Array<Record<string, unknown>>;

  const hasMore = rawRows.length > query.limit;
  const pageRows = hasMore ? rawRows.slice(0, query.limit) : rawRows;
  if (!pageRows.length) return { memories: [], relations: [], hasMore: false };

  const { memories, relations } = hydrateMemoriesFromRows(db, namespace, pageRows);
  return { memories, relations, hasMore };
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
        `SELECT ${MEMORY_SELECT_COLUMNS}
         FROM nmg_memories m
         WHERE m.namespace = ? AND m.id IN (SELECT value FROM json_each(?))
           AND m.scope = ? AND (m.session_id = '' OR m.session_id = ?)
           AND m.status <> 'deleted' AND m.storage_state = '' AND m.has_forget = 0`,
      )
      .all(namespace, JSON.stringify(ids), scopeStr, sessionId) as Array<Record<string, unknown>>;
    return hydrateMemoriesFromRows(db, namespace, rows).memories;
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
           AND storage_state = '' AND has_forget = 0
         ORDER BY sort_time DESC, id ASC LIMIT ?`,
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
           AND storage_state = '' AND has_forget = 0
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
    session_id: string | null;
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

/** Read committed operation receipt from `nmg_receipts`. */
export function readRelationalReceipt(
  db: DatabaseSync,
  namespace: string,
  operationId: string,
): MemoryCommitReceipt | null {
  const row = db
    .prepare(
      `SELECT operation_id, request_hash, revision, result_ids_json, has_result, result_json
       FROM nmg_receipts WHERE namespace=? AND operation_id=?`,
    )
    .get(namespace, operationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    operationId: String(row.operation_id),
    requestHash: String(row.request_hash),
    revision: Number(row.revision),
    resultIds: JSON.parse(String(row.result_ids_json)) as string[],
    ...(Number(row.has_result) === 1 ? { result: JSON.parse(String(row.result_json)) } : {}),
  };
}

/** Read authoritative memory and explicit node counts for a namespace. */
export function readRelationalCounts(
  db: DatabaseSync,
  namespace: string,
): { memories: number; nodes: number } {
  const memRow = db
    .prepare("SELECT count(*) AS n FROM nmg_memories WHERE namespace=?")
    .get(namespace);
  const nodeRow = db
    .prepare("SELECT count(*) AS n FROM nmg_nodes WHERE namespace=?")
    .get(namespace);
  return { memories: Number(memRow?.n ?? 0), nodes: Number(nodeRow?.n ?? 0) };
}

interface FtsSourceSpec {
  readonly prefixLen: number;
  readonly lexicalTable: string;
  readonly surfaceTable: string;
}

function resolveFtsSpec(kind: "memory" | "tessera"): FtsSourceSpec {
  return kind === "memory"
    ? { prefixLen: 8, lexicalTable: "nmg_memory_fts", surfaceTable: "nmg_memory_surface_fts" }
    : {
        prefixLen: 9,
        lexicalTable: "nmg_memory_tessera_fts",
        surfaceTable: "nmg_memory_tessera_surface_fts",
      };
}

function ftsSubquerySql(
  namespace: string,
  kind: "memory" | "tessera",
  table: string,
  expression: string,
): { fromSql: string; bind: (string | number)[] } {
  const { prefixLen } = resolveFtsSpec(kind);
  return {
    fromSql: `(SELECT substr(r.key, ${prefixLen}) AS fts_id, f.rank AS fts_rank FROM ${table} f
      CROSS JOIN nmg_memory_fts_rows r ON r.fts_rowid = f.rowid
      WHERE r.namespace = ? AND r.key GLOB '${kind}:*' AND ${table} MATCH ?)`,
    bind: [namespace, expression],
  };
}

function resolveTextFtsJoin(
  namespace: string,
  kind: "memory" | "tessera",
  text: string | undefined,
  scoredExpression?: string,
  scoredTable?: string,
): { fromSql?: string; bind: (string | number)[]; emptyFts: boolean } {
  const spec = resolveFtsSpec(kind);
  if (scoredExpression !== undefined) {
    if (!scoredExpression) return { bind: [], emptyFts: true };
    const sub = ftsSubquerySql(namespace, kind, scoredTable ?? spec.lexicalTable, scoredExpression);
    return { fromSql: sub.fromSql, bind: sub.bind, emptyFts: false };
  }
  if (!text) return { bind: [], emptyFts: false };
  const lexicalExpr = ftsExpression(text);
  const surfaceExpr = surfaceTrigramExpression(text);
  if (!lexicalExpr && !surfaceExpr) return { bind: [], emptyFts: true };
  if (lexicalExpr && surfaceExpr) {
    return {
      fromSql: `(SELECT substr(r.key, ${spec.prefixLen}) AS fts_id, SUM(matched.fts_rank) AS fts_rank FROM (
          SELECT f.rowid AS fts_rowid, f.rank AS fts_rank FROM ${spec.lexicalTable} f WHERE ${spec.lexicalTable} MATCH ?
          UNION ALL
          SELECT s.rowid AS fts_rowid, s.rank * ${SURFACE_TRIGRAM_WEIGHT} AS fts_rank FROM ${spec.surfaceTable} s WHERE ${spec.surfaceTable} MATCH ?
        ) matched
        CROSS JOIN nmg_memory_fts_rows r ON r.fts_rowid = matched.fts_rowid
        WHERE r.namespace = ? AND r.key GLOB '${kind}:*'
        GROUP BY r.key)`,
      bind: [lexicalExpr, surfaceExpr, namespace],
      emptyFts: false,
    };
  }
  const [table, expr] = lexicalExpr
    ? [spec.lexicalTable, lexicalExpr]
    : [spec.surfaceTable, surfaceExpr];
  const sub = ftsSubquerySql(namespace, kind, table, expr);
  return { fromSql: sub.fromSql, bind: sub.bind, emptyFts: false };
}

/** Read FTS-scored lexical memory candidates directly from `nmg_memories` + FTS5 indexes. */
export function readRelationalLexicalMemoryPage(
  db: DatabaseSync,
  namespace: string,
  query: MemoryEntityQuery,
  expression: string,
  table?: string,
): Array<{ entity: Extract<MemoryEntity, { kind: "memory" }>; bm25: number }> {
  const { limit, offset } = queryBounds(query);
  const fts = resolveTextFtsJoin(namespace, "memory", undefined, expression, table);
  if (fts.emptyFts || !fts.fromSql) return [];
  const filter = buildMemoryQueryFilter(namespace, query, "m");
  const rows = db
    .prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS}, -fts_rank AS bm25
       FROM ${fts.fromSql}
       CROSS JOIN nmg_memories m ON m.namespace = ? AND m.id = fts_id
       WHERE ${filter.sql}
       ORDER BY fts_rank, m.rowid DESC, m.id
       LIMIT ? OFFSET ?`,
    )
    .all(...fts.bind, namespace, ...filter.bind, limit, offset) as Array<Record<string, unknown>>;
  if (!rows.length) return [];
  const { memories } = hydrateMemoriesFromRows(db, namespace, rows);
  return memories.map((value, idx) => ({
    entity: { kind: "memory", value },
    bm25: Number(rows[idx]!.bm25),
  }));
}

function mapHistoryRow(row: Record<string, unknown>): HistoryRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    sourceMessageId: row.source_message_id === null ? null : String(row.source_message_id),
    role: String(row.role) as HistoryRole,
    content: String(row.content),
    sourceRef: row.source_ref === null ? null : String(row.source_ref),
    createdAt: String(row.created_at),
  };
}

function mapNodeRow(row: Record<string, unknown>): MemoryNode {
  return {
    id: String(row.id),
    canonicalName: String(row.canonical_name),
    kind: String(row.kind) as MemoryNodeKind,
    summary: String(row.summary),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    status: String(row.status) as MemoryNode["status"],
    residence: String(row.residence) as MemoryNode["residence"],
    ...(row.unbound === null || row.unbound === undefined ? {} : { unbound: Boolean(row.unbound) }),
  };
}

function mapEdgeRow(row: Record<string, unknown>): NodeRelation {
  const ext = parseExtJson(row.ext_json);
  const createdAt = String(row.created_at);
  return {
    id: String(row.id),
    sourceNodeId: String(row.source_id),
    targetNodeId: String(row.target_id),
    type: String(row.relation_type) as NodeRelationType,
    evidenceIds: (ext.evidenceIds as string[] | undefined) ?? [],
    residence: "ltg",
    status: String(row.status) as NodeRelation["status"],
    stability: Number(ext.stability ?? 1),
    strength: Number(row.weight),
    direction: String(row.direction) as NodeRelation["direction"],
    fanBudget: Boolean(ext.fanBudget ?? true),
    activationRule: (ext.activationRule ?? "conductive") as NodeRelation["activationRule"],
    consolidationSource: (ext.consolidationSource ??
      "explicit") as NodeRelation["consolidationSource"],
    consolidatedAt: String(ext.consolidatedAt ?? createdAt),
    createdAt,
  };
}

function mapMemoryRelationRow(row: Record<string, unknown>): MemoryRelationRecord {
  return {
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
}

function mapTesseraRow(row: Record<string, unknown>): TesseraRecord {
  return {
    id: String(row.id),
    path: String(row.path),
    snippet: String(row.snippet),
    label: String(row.label),
    ...(row.kind === null ? {} : { kind: String(row.kind) }),
    ...(row.memory_id === null ? {} : { memoryId: String(row.memory_id) }),
    createdAt: String(row.created_at),
    ...(row.file_simhash === null ? {} : { fileSimhash: String(row.file_simhash) }),
  };
}

function appendSimpleTableFilters(
  clauses: string[],
  bind: (string | number)[],
  query: MemoryEntityQuery,
  alias: string,
): void {
  const p = alias ? `${alias}.` : "";
  if (query.ids) appendIdListFilter(clauses, bind, `${p}id`, query.ids, "entity IDs");
  if (sessionScopedEntity(query.kind)) {
    clauses.push(`(${p}session_id IS NULL OR ${p}session_id = ?)`);
    bind.push(query.sessionId ?? "");
  }
}

function buildSqlPlanForKind(
  namespace: string,
  query: MemoryEntityQuery,
): { sql: string; bind: (string | number)[] } {
  const { limit, offset } = queryBounds(query);
  if (query.kind === "memory") {
    const fts = resolveTextFtsJoin(namespace, "memory", query.text);
    if (fts.emptyFts) {
      return {
        sql: `SELECT ${MEMORY_SELECT_COLUMNS} FROM nmg_memories m WHERE 1 = 0 LIMIT ? OFFSET ?`,
        bind: [limit, offset],
      };
    }
    const filter = buildMemoryQueryFilter(namespace, query, "m");
    const from = fts.fromSql
      ? `${fts.fromSql} CROSS JOIN nmg_memories m ON m.namespace = ? AND m.id = fts_id`
      : "nmg_memories m";
    const bind = fts.fromSql ? [...fts.bind, namespace, ...filter.bind] : filter.bind;
    const order = fts.fromSql ? "fts_rank, m.rowid DESC, m.id" : "m.id";
    return {
      sql: `SELECT ${MEMORY_SELECT_COLUMNS} FROM ${from} WHERE ${filter.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      bind: [...bind, limit, offset],
    };
  }
  return buildAuxSqlPlan(namespace, query, limit, offset);
}

interface AuxPlanSpec {
  readonly selectSql: string;
  readonly fixedClause?: string;
  readonly applyFilter?: (
    query: MemoryEntityQuery,
    clauses: string[],
    bind: (string | number)[],
  ) => void;
}

const AUX_PLAN_SPECS: Partial<Record<MemoryEntity["kind"], AuxPlanSpec>> = {
  history: {
    selectSql: "SELECT * FROM nmg_sources",
    applyFilter: (q, c, b) => {
      if (q.sourceMessageId !== undefined) {
        c.push("source_message_id = ?");
        b.push(q.sourceMessageId);
      }
    },
  },
  node: {
    selectSql: "SELECT * FROM nmg_nodes",
    applyFilter: (q, c, b) => {
      if (q.nodeName !== undefined) {
        c.push("normalized_name = ?");
        b.push(q.nodeName.trim().toLocaleLowerCase("en-US"));
      }
    },
  },
  memoryRelation: {
    selectSql: "SELECT * FROM nmg_memory_relations",
    fixedClause: "origin <> 'node_edge'",
  },
  stateAlias: {
    selectSql: "SELECT * FROM nmg_state_aliases",
    applyFilter: (q, c, b) => {
      if (q.scope !== undefined) {
        c.push("scope = ?");
        b.push(serializeScope(q.scope));
      }
    },
  },
  writeEvent: { selectSql: "SELECT * FROM nmg_write_events" },
  relationProposal: { selectSql: "SELECT payload_json FROM nmg_relation_proposals" },
  claimPosterior: {
    selectSql: "SELECT * FROM nmg_claim_posteriors",
    applyFilter: (q, c, b) => {
      if (q.claimMemoryId) {
        c.push("memory_id = ?");
        b.push(q.claimMemoryId);
      }
    },
  },
  claimOutcome: { selectSql: "SELECT * FROM nmg_claim_outcomes" },
  resolutionEvent: { selectSql: "SELECT * FROM nmg_resolution_events" },
};

function buildAuxSqlPlan(
  namespace: string,
  query: MemoryEntityQuery,
  limit: number,
  offset: number,
): { sql: string; bind: (string | number)[] } {
  if (query.kind === "edge") return buildEdgeSqlPlan(namespace, query, limit, offset);
  if (query.kind === "tessera") return buildTesseraSqlPlan(namespace, query, limit, offset);
  const spec = AUX_PLAN_SPECS[query.kind];
  if (!spec) throw new Error(`Unsupported entity kind: ${query.kind}`);
  const clauses = ["namespace = ?"];
  const bind: (string | number)[] = [namespace];
  appendSimpleTableFilters(clauses, bind, query, "");
  if (spec.fixedClause) clauses.push(spec.fixedClause);
  spec.applyFilter?.(query, clauses, bind);
  return {
    sql: `${spec.selectSql} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ? OFFSET ?`,
    bind: [...bind, limit, offset],
  };
}

function buildEdgeSqlPlan(
  namespace: string,
  query: MemoryEntityQuery,
  limit: number,
  offset: number,
): { sql: string; bind: (string | number)[] } {
  if (query.connectedTo !== undefined) {
    const clauses = ["namespace = ?", "origin = 'node_edge'"];
    const bind: (string | number)[] = [namespace];
    const useEndpointIdx = !query.ids;
    if (query.ids) appendIdListFilter(clauses, bind, "id", query.ids, "entity IDs");
    const where = clauses.join(" AND ");
    const node = query.connectedTo;
    const srcIdx = useEndpointIdx ? " INDEXED BY nmg_memory_relations_edge_source" : "";
    const tgtIdx = useEndpointIdx ? " INDEXED BY nmg_memory_relations_edge_target" : "";
    return {
      sql: `SELECT * FROM (
        SELECT * FROM nmg_memory_relations${srcIdx} WHERE ${where} AND source_id = ?
        UNION ALL
        SELECT * FROM nmg_memory_relations${tgtIdx} WHERE ${where} AND target_id = ? AND source_id <> ?
        ORDER BY id LIMIT ? OFFSET ?
      )`,
      bind: [...bind, node, ...bind, node, node, limit, offset],
    };
  }
  const clauses = ["namespace = ?", "origin = 'node_edge'"];
  const bind: (string | number)[] = [namespace];
  appendSimpleTableFilters(clauses, bind, query, "");
  return {
    sql: `SELECT * FROM nmg_memory_relations WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ? OFFSET ?`,
    bind: [...bind, limit, offset],
  };
}

function buildTesseraSqlPlan(
  namespace: string,
  query: MemoryEntityQuery,
  limit: number,
  offset: number,
): { sql: string; bind: (string | number)[] } {
  const fts = resolveTextFtsJoin(namespace, "tessera", query.text);
  if (fts.emptyFts) {
    return {
      sql: "SELECT * FROM nmg_tesserae t WHERE 1 = 0 LIMIT ? OFFSET ?",
      bind: [limit, offset],
    };
  }
  const clauses = ["t.namespace = ?"];
  const bind: (string | number)[] = [namespace];
  if (query.ids) appendIdListFilter(clauses, bind, "t.id", query.ids, "entity IDs");
  const from = fts.fromSql
    ? `${fts.fromSql} CROSS JOIN nmg_tesserae t ON t.namespace = ? AND t.id = fts_id`
    : "nmg_tesserae t";
  const allBind = fts.fromSql ? [...fts.bind, namespace, ...bind] : bind;
  const order = fts.fromSql ? "fts_rank, t.rowid DESC, t.id" : "t.id";
  return {
    sql: `SELECT t.* FROM ${from} WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
    bind: [...allBind, limit, offset],
  };
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const AUX_ROW_DECODERS: Record<
  Exclude<MemoryEntity["kind"], "memory">,
  (row: Record<string, unknown>) => MemoryEntity
> = {
  history: (row) => ({ kind: "history", value: mapHistoryRow(row) }),
  node: (row) => ({ kind: "node", value: mapNodeRow(row) }),
  edge: (row) => ({ kind: "edge", value: mapEdgeRow(row) }),
  memoryRelation: (row) => ({ kind: "memoryRelation", value: mapMemoryRelationRow(row) }),
  tessera: (row) => ({ kind: "tessera", value: mapTesseraRow(row) }),
  stateAlias: (row) => ({
    kind: "stateAlias",
    value: {
      id: String(row.id),
      aliasKey: String(row.alias_key),
      canonicalKey: String(row.canonical_key),
      scope: JSON.parse(String(row.scope)) as MemoryScope,
      createdAt: String(row.created_at),
    },
  }),
  writeEvent: (row) => ({
    kind: "writeEvent",
    value: {
      id: String(row.id),
      memoryId: nullableStr(row.memory_id),
      historyId: nullableStr(row.history_id),
      sessionId: nullableStr(row.session_id),
      decision: String(row.decision) as "accepted" | "rejected",
      policyReason: String(row.policy_reason),
      writeReason: String(row.write_reason),
      writeSource: String(row.write_source) as MemoryRecord["writeSource"],
      memoryType: String(row.memory_type) as MemoryType,
      requestedResidence: String(row.requested_residence) as MemoryRecord["residence"],
      createdAt: String(row.created_at),
    },
  }),
  relationProposal: (row) => ({
    kind: "relationProposal",
    value: JSON.parse(String(row.payload_json)) as TopologyProposal & { sessionId: string | null },
  }),
  claimPosterior: (row) => ({
    kind: "claimPosterior",
    value: {
      id: String(row.id),
      sessionId: nullableStr(row.session_id),
      posterior: {
        memoryId: String(row.memory_id),
        claimIndex: Number(row.claim_index),
        claimText: String(row.claim_text),
        priorConfidence: Number(row.prior_confidence),
        alpha: Number(row.alpha),
        beta: Number(row.beta),
        mean: Number(row.mean),
        conservativeLowerBound: Number(row.conservative_lower_bound),
        independentVoteCount: Number(row.independent_vote_count),
        updatedAt: String(row.updated_at),
      },
    },
  }),
  claimOutcome: (row) => ({
    kind: "claimOutcome",
    value: {
      id: String(row.id),
      memoryId: String(row.memory_id),
      claimIndex: Number(row.claim_index),
      semanticTaskId: String(row.semantic_task_id),
      sessionId: nullableStr(row.session_id),
      outcome: String(row.outcome) as ClaimOutcomeEvent["outcome"],
      source: String(row.source) as ClaimOutcomeEvent["source"],
      sourceLineage: String(row.source_lineage),
      evidenceId: nullableStr(row.evidence_id),
      collectionOrigin: String(row.collection_origin) as ClaimOutcomeEvent["collectionOrigin"],
      weight: Number(row.weight),
      activeGraphId: nullableStr(row.active_graph_id),
      createdAt: String(row.created_at),
    },
  }),
  resolutionEvent: (row) => ({
    kind: "resolutionEvent",
    value: {
      id: String(row.id),
      memoryId: String(row.memory_id),
      fromResolution: String(row.from_resolution) as MemoryRecord["resolution"],
      toResolution: String(row.to_resolution) as MemoryRecord["resolution"],
      openedAt: nullableStr(row.opened_at),
      relatedMemoryIds: JSON.parse(String(row.related_ids_json)) as string[],
      reason: nullableStr(row.reason),
      sessionId: nullableStr(row.session_id),
      createdAt: String(row.created_at),
    },
  }),
};

function decodeAuxRow(
  kind: Exclude<MemoryEntity["kind"], "memory">,
  row: Record<string, unknown>,
): MemoryEntity {
  return AUX_ROW_DECODERS[kind](row);
}

/** Query authoritative relational tables for any `MemoryEntityQuery`. */
export function scanRelational(
  db: DatabaseSync,
  namespace: string,
  query: MemoryEntityQuery,
): MemoryEntity[] {
  const plan = buildSqlPlanForKind(namespace, query);
  const rows = db.prepare(plan.sql).all(...plan.bind) as Array<Record<string, unknown>>;
  if (!rows.length) return [];
  if (query.kind === "memory") {
    return hydrateMemoriesFromRows(db, namespace, rows).memories.map((value) => ({
      kind: "memory",
      value,
    }));
  }
  const kind = query.kind;
  return rows.map((row) => decodeAuxRow(kind, row));
}

/** Execute batched entity scans grouped by entity kind inside a single read snapshot. */
export function scanRelationalBatch(
  db: DatabaseSync,
  namespace: string,
  queries: readonly MemoryEntityQuery[],
): MemoryEntity[][] {
  const results: MemoryEntity[][] = queries.map(() => []);
  const byKind = new Map<MemoryEntity["kind"], Array<{ slot: number; query: MemoryEntityQuery }>>();
  queries.forEach((query, slot) => {
    const group = byKind.get(query.kind) ?? [];
    group.push({ slot, query });
    byKind.set(query.kind, group);
  });

  for (const [kind, entries] of byKind) {
    for (let offset = 0; offset < entries.length; offset += 32) {
      const batch = entries.slice(offset, offset + 32);
      const plans = batch.map(({ query }) => buildSqlPlanForKind(namespace, query));
      const sql = plans
        .map((plan, i) => `SELECT ${batch[i]!.slot} AS slot, * FROM (${plan.sql})`)
        .join(" UNION ALL ");
      const rows = db.prepare(sql).all(...plans.flatMap((plan) => plan.bind)) as Array<
        Record<string, unknown>
      >;
      if (kind === "memory") {
        const { memories } = hydrateMemoriesFromRows(db, namespace, rows);
        memories.forEach((value, i) =>
          results[Number(rows[i]!.slot)]!.push({ kind: "memory", value }),
        );
      } else {
        for (const row of rows) results[Number(row.slot)]!.push(decodeAuxRow(kind, row));
      }
    }
  }
  return results;
}
