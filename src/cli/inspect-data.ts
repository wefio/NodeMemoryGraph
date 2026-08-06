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
  const rows = db
    .prepare(
      `SELECT m.id, m.statement, m.memory_type, m.tier, m.importance, m.status,
              m.created_at, n.canonical_name AS node_name
       FROM memory_records m
       JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.status IN ('active', 'disputed')
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 5_000))) as Row[];
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
  const rows = db
    .prepare(
      `SELECT id, created_at, query, result_memory_ids_json, qpp_json
       FROM retrieval_traces
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 1_000))) as Row[];
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
    | Row
    | undefined;
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
