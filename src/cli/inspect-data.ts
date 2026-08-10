/**
 * Read-only query layer for `nmg inspect`.
 *
 * Opens the SQLite database with `readOnly: true` — the inspector never
 * migrates, never writes, and never talks to the daemon, so it is safe to
 * point at a live database (WAL allows concurrent readers). Row parsing is
 * deliberately local and minimal: these are display queries, not store
 * capabilities, and adding them to the store surface would widen it for a
 * single consumer.
 */
import { DatabaseSync } from "node:sqlite";

export interface InspectMemoryRow {
  id: string;
  statement: string;
  memoryType: string;
  tier: number;
  importance: number;
  status: string;
  nodeName: string;
  createdAt: string;
}

export interface InspectMemoryDetail extends InspectMemoryRow {
  sourceActor: string;
  truthStatus: string;
  residence: string;
  scope: Record<string, string>;
  evidenceRole: string;
  accessCount: number;
  lastAccessedAt: string | null;
  expiresAt: string | null;
  evidence: Array<{ role: string; content: string; createdAt: string }>;
}

export interface InspectTraceRow {
  id: string;
  createdAt: string;
  query: string;
  resultCount: number;
  hasQpp: boolean;
}

export interface InspectTraceDetail extends InspectTraceRow {
  resultMemoryIds: string[];
  qpp: unknown;
  selections: unknown;
  expansions: unknown;
  timings: unknown;
  filterUsage: unknown;
}

type Row = Record<string, unknown>;

export function openInspectDb(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, { readOnly: true });
}

export function listMemories(db: DatabaseSync, limit = 500): InspectMemoryRow[] {
  return mapMemoryRows(
    db
      .prepare(
        `SELECT m.id, m.statement, m.memory_type, m.tier, m.importance, m.status,
                m.created_at, n.canonical_name AS node_name
         FROM memory_records m
         JOIN memory_nodes n ON n.id = m.node_id
         WHERE m.status IN ('active', 'disputed')
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(clampLimit(limit, 5_000)) as Row[],
  );
}

/**
 * Full-text search over the memory_fts index (statement + node + evidence).
 * FTS5's unicode61 tokenizer does not segment CJK, so queries containing CJK
 * characters — and malformed FTS syntax — fall back to substring matching.
 */
export function searchMemories(db: DatabaseSync, query: string, limit = 200): InspectMemoryRow[] {
  const trimmed = query.trim();
  if (!trimmed) return listMemories(db, limit);
  if (!/[⺀-鿿豈-﫿𠀀-𪨟]/u.test(trimmed)) {
    const ftsQuery = trimmed
      .split(/\s+/)
      .map((token) => `"${token.replaceAll('"', '""')}"*`)
      .join(" ");
    try {
      return mapMemoryRows(
        db
          .prepare(
            `SELECT m.id, m.statement, m.memory_type, m.tier, m.importance, m.status,
                    m.created_at, n.canonical_name AS node_name
             FROM memory_fts f
             JOIN memory_records m ON m.id = f.memory_id
             JOIN memory_nodes n ON n.id = m.node_id
             WHERE memory_fts MATCH ? AND m.status IN ('active', 'disputed')
             ORDER BY bm25(memory_fts)
             LIMIT ?`,
          )
          .all(ftsQuery, clampLimit(limit, 5_000)) as Row[],
      );
    } catch {
      // Malformed FTS syntax (unbalanced quotes, stray operators): fall through.
    }
  }
  const pattern = `%${escapeLike(trimmed)}%`;
  return mapMemoryRows(
    db
      .prepare(
        `SELECT m.id, m.statement, m.memory_type, m.tier, m.importance, m.status,
                m.created_at, n.canonical_name AS node_name
         FROM memory_records m
         JOIN memory_nodes n ON n.id = m.node_id
         WHERE m.status IN ('active', 'disputed')
           AND (m.statement LIKE ? ESCAPE '\\' OR n.canonical_name LIKE ? ESCAPE '\\')
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(pattern, pattern, clampLimit(limit, 5_000)) as Row[],
  );
}

export function getMemoryDetail(db: DatabaseSync, memoryId: string): InspectMemoryDetail | null {
  const row = db
    .prepare(
      `SELECT m.*, n.canonical_name AS node_name
       FROM memory_records m
       JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.id = ?`,
    )
    .get(memoryId) as Row | undefined;
  if (!row) return null;
  const evidenceRows = db
    .prepare(
      `SELECT h.role, h.content, h.created_at
       FROM memory_evidence_links l
       JOIN history_records h ON h.id = l.history_id
       WHERE l.memory_id = ?
       ORDER BY h.created_at ASC`,
    )
    .all(memoryId) as Row[];
  return {
    id: String(row.id),
    statement: String(row.statement),
    memoryType: String(row.memory_type),
    tier: Number(row.tier),
    importance: Number(row.importance),
    status: String(row.status),
    nodeName: String(row.node_name),
    createdAt: String(row.created_at),
    sourceActor: String(row.source_actor),
    truthStatus: String(row.truth_status),
    residence: String(row.residence),
    scope: Object.fromEntries(
      Object.entries(parseJsonObject(row.scope_json) ?? {}).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
    evidenceRole: String(row.evidence_role),
    accessCount: Number(row.access_count),
    lastAccessedAt: row.last_accessed_at === null ? null : String(row.last_accessed_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    evidence: evidenceRows.map((evidence) => ({
      role: String(evidence.role),
      content: String(evidence.content),
      createdAt: String(evidence.created_at),
    })),
  };
}

export function listTraces(db: DatabaseSync, limit = 200): InspectTraceRow[] {
  return mapTraceRows(
    db
      .prepare(
        `SELECT id, created_at, query, result_memory_ids_json, qpp_json
         FROM retrieval_traces
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(clampLimit(limit, 1_000)) as Row[],
  );
}

/** Substring search over trace queries (the table is small; no FTS index). */
export function searchTraces(db: DatabaseSync, query: string, limit = 200): InspectTraceRow[] {
  const trimmed = query.trim();
  if (!trimmed) return listTraces(db, limit);
  return mapTraceRows(
    db
      .prepare(
        `SELECT id, created_at, query, result_memory_ids_json, qpp_json
         FROM retrieval_traces
         WHERE query LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(`%${escapeLike(trimmed)}%`, clampLimit(limit, 1_000)) as Row[],
  );
}

function mapTraceRows(rows: Row[]): InspectTraceRow[] {
  return rows.map((row) => ({
    id: String(row.id),
    createdAt: String(row.created_at),
    query: String(row.query),
    resultCount: parseJsonArray(row.result_memory_ids_json).length,
    hasQpp: parseJsonObject(row.qpp_json) !== null,
  }));
}

export function getTraceDetail(db: DatabaseSync, traceId: string): InspectTraceDetail | null {
  const row = db.prepare("SELECT * FROM retrieval_traces WHERE id = ?").get(traceId) as
    Row | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    query: String(row.query),
    resultCount: parseJsonArray(row.result_memory_ids_json).length,
    hasQpp: parseJsonObject(row.qpp_json) !== null,
    resultMemoryIds: parseJsonArray(row.result_memory_ids_json),
    qpp: parseJsonObject(row.qpp_json),
    selections: parseJsonObject(row.selections_json) ?? parseJsonArray(row.selections_json),
    expansions: parseJsonObject(row.expansions_json) ?? parseJsonArray(row.expansions_json),
    timings: parseJsonObject(row.timings_json),
    filterUsage: parseJsonObject(row.filter_usage_json),
  };
}

function mapMemoryRows(rows: Row[]): InspectMemoryRow[] {
  return rows.map((row) => ({
    id: String(row.id),
    statement: String(row.statement),
    memoryType: String(row.memory_type),
    tier: Number(row.tier),
    importance: Number(row.importance),
    status: String(row.status),
    nodeName: String(row.node_name),
    createdAt: String(row.created_at),
  }));
}

function clampLimit(limit: number, max: number): number {
  return Math.max(1, Math.min(limit, max));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
