import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  HistoryRecord,
  HistoryRole,
  MemoryNode,
  MemoryNodeKind,
  MemoryRecord,
  MemorySearchResult,
  MemoryScope,
  MemoryStatus,
  MemoryTier,
  RememberInput,
  RememberResult,
  SearchOptions,
  SessionArchive,
} from "./types.ts";

type Row = Record<string, string | number | null>;

const MAX_SEARCH_CANDIDATES = 500;

export class NmgStore {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  appendHistory(input: {
    content: string;
    role: HistoryRole;
    sessionId?: string;
    sourceRef?: string;
  }): HistoryRecord {
    const record: HistoryRecord = {
      id: randomUUID(),
      sessionId: input.sessionId ?? null,
      role: input.role,
      content: requireText(input.content, "history content"),
      sourceRef: input.sourceRef ?? null,
      createdAt: new Date().toISOString(),
    };

    this.#db
      .prepare(
        `INSERT INTO history_records
          (id, session_id, role, content, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.role,
        record.content,
        record.sourceRef,
        record.createdAt,
      );

    return record;
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

    if (existing) return mapNode(existing);

    const now = new Date().toISOString();
    const node: MemoryNode = {
      id: randomUUID(),
      canonicalName,
      kind: input.kind ?? "concept",
      summary: input.summary?.trim() || canonicalName,
      createdAt: now,
      updatedAt: now,
    };

    this.#db
      .prepare(
        `INSERT INTO memory_nodes
          (id, canonical_name, kind, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.canonicalName,
        node.kind,
        node.summary,
        node.createdAt,
        node.updatedAt,
      );

    return node;
  }

  addMemory(input: {
    nodeId: string;
    evidenceId: string;
    statement: string;
    tier?: MemoryTier;
    importance?: number;
    scope?: MemoryScope;
    validFrom?: string;
    validUntil?: string;
    evidenceRole?: MemoryRecord["evidenceRole"];
    supersedesId?: string;
  }): MemoryRecord {
    const createdAt = new Date().toISOString();
    const memory: MemoryRecord = {
      id: randomUUID(),
      nodeId: input.nodeId,
      evidenceId: input.evidenceId,
      statement: requireText(input.statement, "memory statement"),
      scope: input.scope ?? {},
      validFrom: input.validFrom ?? createdAt,
      validUntil: input.validUntil ?? null,
      status: "active",
      evidenceRole: input.evidenceRole ?? "support",
      supersedesId: input.supersedesId ?? null,
      tier: input.tier ?? 1,
      importance: clamp(input.importance ?? 0.5, 0, 1),
      accessCount: 0,
      lastAccessedAt: null,
      createdAt,
    };

    this.#db
      .prepare(
        `INSERT INTO memory_records
          (id, node_id, evidence_id, statement, scope_json, valid_from,
           valid_until, status, evidence_role, supersedes_id, tier, importance,
           access_count, last_accessed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(
        memory.id,
        memory.nodeId,
        memory.evidenceId,
        memory.statement,
        JSON.stringify(memory.scope),
        memory.validFrom,
        memory.validUntil,
        memory.status,
        memory.evidenceRole,
        memory.supersedesId,
        memory.tier,
        memory.importance,
        memory.createdAt,
      );

    return memory;
  }

  remember(input: RememberInput): RememberResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const history = this.appendHistory({
        content: input.evidence ?? input.statement,
        role: "explicit",
        sessionId: input.sessionId,
        sourceRef: input.sourceRef,
      });
      const node = this.upsertNode({
        canonicalName: input.nodeName,
        kind: input.nodeKind,
      });
      if (input.supersedesId) {
        const previous = this.#db
          .prepare("SELECT node_id FROM memory_records WHERE id = ?")
          .get(input.supersedesId) as Row | undefined;
        if (!previous) throw new Error(`memory ${input.supersedesId} does not exist`);
        if (String(previous.node_id) !== node.id) {
          throw new Error("a memory can only supersede another memory in the same node");
        }
        this.#db
          .prepare(
            `UPDATE memory_records
             SET status = 'superseded', valid_until = ?
             WHERE id = ?`,
          )
          .run(input.validFrom ?? new Date().toISOString(), input.supersedesId);
      }
      const memory = this.addMemory({
        nodeId: node.id,
        evidenceId: history.id,
        statement: input.statement,
        tier: input.tier,
        importance: input.importance,
        scope: input.scope,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        evidenceRole: input.evidenceRole,
        supersedesId: input.supersedesId,
      });
      this.#db.exec("COMMIT");
      return { history, node, memory };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: string, options: SearchOptions = {}): MemorySearchResult[] {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return [];

    const maxTier = options.maxTier ?? 1;
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const rows = this.#db
      .prepare(
        `SELECT
           m.id AS m_id, m.node_id AS m_node_id,
           m.evidence_id AS m_evidence_id, m.statement AS m_statement,
           m.scope_json AS m_scope_json, m.valid_from AS m_valid_from,
           m.valid_until AS m_valid_until, m.status AS m_status,
           m.evidence_role AS m_evidence_role,
           m.supersedes_id AS m_supersedes_id,
           m.tier AS m_tier, m.importance AS m_importance,
           m.access_count AS m_access_count,
           m.last_accessed_at AS m_last_accessed_at,
           m.created_at AS m_created_at,
           n.id AS n_id, n.canonical_name AS n_canonical_name,
           n.kind AS n_kind, n.summary AS n_summary,
           n.created_at AS n_created_at, n.updated_at AS n_updated_at,
           h.id AS h_id, h.session_id AS h_session_id, h.role AS h_role,
           h.content AS h_content, h.source_ref AS h_source_ref,
           h.created_at AS h_created_at
         FROM memory_records m
         JOIN memory_nodes n ON n.id = m.node_id
         JOIN history_records h ON h.id = m.evidence_id
         WHERE m.tier <= ?
           AND (? IS NULL OR n.canonical_name = ?)
           AND (? = 1 OR m.status IN ('active', 'disputed'))
         ORDER BY m.tier ASC, m.importance DESC,
                  m.access_count DESC, m.created_at DESC
         LIMIT ?`,
      )
      .all(
        maxTier,
        options.nodeName ?? null,
        options.nodeName ?? null,
        options.includeHistorical ? 1 : 0,
        MAX_SEARCH_CANDIDATES,
      ) as Row[];

    return rows
      .map((row) => mapSearchResult(row, lexicalScore(normalizedQuery, row)))
      .filter((result) => matchesScope(result.memory.scope, options.scope))
      .filter((result) => result.lexicalScore > 0)
      .sort(
        (left, right) =>
          right.lexicalScore - left.lexicalScore ||
          left.memory.tier - right.memory.tier ||
          right.memory.importance - left.memory.importance,
      )
      .slice(0, limit);
  }

  recordUsage(memoryIds: string[]): void {
    const uniqueIds = [...new Set(memoryIds)];
    if (uniqueIds.length === 0) return;

    const statement = this.#db.prepare(
      `UPDATE memory_records
       SET access_count = access_count + 1, last_accessed_at = ?
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
    if (existing) return existing;

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
           VALUES (?, ?, ?)`,
        )
        .run(archive.sessionId, archive.historyId, archive.createdAt);
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

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS history_records (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        source_ref TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        evidence_id TEXT NOT NULL REFERENCES history_records(id),
        statement TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '{}',
        valid_from TEXT,
        valid_until TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        evidence_role TEXT NOT NULL DEFAULT 'support',
        supersedes_id TEXT REFERENCES memory_records(id),
        tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
        importance REAL NOT NULL CHECK (importance BETWEEN 0 AND 1),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_archives (
        session_id TEXT PRIMARY KEY,
        history_id TEXT NOT NULL UNIQUE REFERENCES history_records(id),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_records_node_tier
        ON memory_records(node_id, tier);
      CREATE INDEX IF NOT EXISTS idx_memory_records_tier_priority
        ON memory_records(tier, importance DESC, access_count DESC);
    `);
    this.#ensureMemoryColumns();
  }

  #ensureMemoryColumns(): void {
    const existing = new Set(
      (this.#db.prepare("PRAGMA table_info(memory_records)").all() as Row[]).map(
        (row) => String(row.name),
      ),
    );
    const additions: Array<[string, string]> = [
      ["scope_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["valid_from", "TEXT"],
      ["valid_until", "TEXT"],
      ["status", "TEXT NOT NULL DEFAULT 'active'"],
      ["evidence_role", "TEXT NOT NULL DEFAULT 'support'"],
      ["supersedes_id", "TEXT REFERENCES memory_records(id)"],
    ];
    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.#db.exec(`ALTER TABLE memory_records ADD COLUMN ${name} ${definition}`);
      }
    }
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
  };
}

function mapSearchResult(row: Row, score: number): MemorySearchResult {
  return {
    memory: {
      id: String(row.m_id),
      nodeId: String(row.m_node_id),
      evidenceId: String(row.m_evidence_id),
      statement: String(row.m_statement),
      scope: parseScope(row.m_scope_json),
      validFrom: row.m_valid_from ? String(row.m_valid_from) : null,
      validUntil: row.m_valid_until ? String(row.m_valid_until) : null,
      status: String(row.m_status) as MemoryStatus,
      evidenceRole: String(row.m_evidence_role) as MemoryRecord["evidenceRole"],
      supersedesId: row.m_supersedes_id ? String(row.m_supersedes_id) : null,
      tier: Number(row.m_tier) as MemoryTier,
      importance: Number(row.m_importance),
      accessCount: Number(row.m_access_count),
      lastAccessedAt: row.m_last_accessed_at
        ? String(row.m_last_accessed_at)
        : null,
      createdAt: String(row.m_created_at),
    },
    node: mapNode(row, "n_"),
    evidence: {
      id: String(row.h_id),
      sessionId: row.h_session_id ? String(row.h_session_id) : null,
      role: String(row.h_role) as HistoryRole,
      content: String(row.h_content),
      sourceRef: row.h_source_ref ? String(row.h_source_ref) : null,
      createdAt: String(row.h_created_at),
    },
    lexicalScore: score,
  };
}

function lexicalScore(query: string, row: Row): number {
  const haystack = normalize(
    `${row.m_statement} ${row.n_canonical_name} ${row.n_summary}`,
  );
  if (haystack.includes(query)) return 10 + query.length;

  const terms = searchTerms(query);
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? term.length : 0),
    0,
  );
}

function searchTerms(value: string): string[] {
  const tokens = value.match(/[\p{L}\p{N}_+.#-]+/gu) ?? [];
  const terms = new Set<string>();
  for (const token of tokens) {
    if (token.length >= 2) terms.add(token);
    if (/\p{Script=Han}/u.test(token) && token.length > 4) {
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
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

function parseScope(value: string | number | null): MemoryScope {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value) as MemoryScope;
  } catch {
    return {};
  }
}

function matchesScope(memory: MemoryScope, requested?: MemoryScope): boolean {
  if (!requested) return true;
  return Object.entries(requested).every(([key, value]) => memory[key] === value);
}
