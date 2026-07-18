import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  DeriveMemoryInput,
  HistoryRecord,
  HistoryRole,
  MemoryContext,
  MemoryNode,
  MemoryNodeKind,
  MemoryRecord,
  MemorySearchResult,
  MemoryScope,
  MemoryStatus,
  MemoryTier,
  NodeRelation,
  NodeRelationType,
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
    memoryType?: MemoryRecord["memoryType"];
    stateKey?: string;
    eventTime?: string;
    sourceActor?: MemoryRecord["sourceActor"];
    truthStatus?: MemoryRecord["truthStatus"];
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
      evidenceIds: [input.evidenceId],
      statement: requireText(input.statement, "memory statement"),
      memoryType: input.memoryType ?? "fact",
      stateKey: input.stateKey ?? null,
      eventTime: input.eventTime ?? null,
      sourceActor: input.sourceActor ?? "user",
      truthStatus: input.truthStatus ?? "asserted",
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
          (id, node_id, evidence_id, statement, memory_type, state_key,
           event_time, source_actor, truth_status, scope_json, valid_from,
           valid_until, status, evidence_role, supersedes_id, tier, importance,
           access_count, last_accessed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
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
        serializeScope(memory.scope),
        memory.validFrom,
        memory.validUntil,
        memory.status,
        memory.evidenceRole,
        memory.supersedesId,
        memory.tier,
        memory.importance,
        memory.createdAt,
      );
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
         VALUES (?, ?)`,
      )
      .run(memory.id, memory.evidenceId);

    return memory;
  }

  remember(input: RememberInput): RememberResult {
    const memoryType = input.memoryType ?? "fact";
    if (memoryType === "state" && !input.stateKey?.trim()) {
      throw new Error("state memories require a stable stateKey");
    }
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
      const automaticPrevious = memoryType === "state" && input.stateKey
        ? this.#db
            .prepare(
              `SELECT id FROM memory_records
               WHERE memory_type = 'state' AND state_key = ? AND scope_json = ?
                 AND status = 'active'
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(input.stateKey, serializeScope(input.scope ?? {})) as Row | undefined
        : undefined;
      const supersedesId = input.supersedesId ??
        (automaticPrevious ? String(automaticPrevious.id) : undefined);
      if (supersedesId) {
        const previous = this.#db
          .prepare("SELECT node_id FROM memory_records WHERE id = ?")
          .get(supersedesId) as Row | undefined;
        if (!previous) throw new Error(`memory ${supersedesId} does not exist`);
        this.#db
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
        stateKey: input.stateKey,
        eventTime: input.eventTime,
        sourceActor: input.sourceActor,
        truthStatus: input.truthStatus,
        tier: input.tier,
        importance: input.importance,
        scope: input.scope,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        evidenceRole: input.evidenceRole ?? (supersedesId ? "update" : undefined),
        supersedesId,
      });
      this.#db.exec("COMMIT");
      return { history, node, memory };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  deriveMemory(input: DeriveMemoryInput): RememberResult {
    const sourceMemoryIds = [...new Set(input.sourceMemoryIds)];
    if (sourceMemoryIds.length < 2) {
      throw new Error("derived memories require at least two source memories");
    }
    const sources = sourceMemoryIds.map((id) => {
      const row = this.#db
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

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const linkEvidence = this.#db.prepare(
        `INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
         VALUES (?, ?)`,
      );
      const linkDerivation = this.#db.prepare(
        `INSERT INTO memory_derivations (derived_memory_id, source_memory_id)
         VALUES (?, ?)`,
      );
      for (const source of sources) {
        const evidenceIds = this.#evidenceIds(String(source.id));
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
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    result.memory.evidenceIds = this.#evidenceIds(result.memory.id);
    return result;
  }

  linkNodes(input: {
    sourceNodeId: string;
    targetNodeId: string;
    type: NodeRelationType;
    evidenceIds?: string[];
  }): NodeRelation {
    const existing = this.#db
      .prepare(
        `SELECT * FROM node_relations
         WHERE source_node_id = ? AND target_node_id = ? AND relation_type = ?`,
      )
      .get(input.sourceNodeId, input.targetNodeId, input.type) as Row | undefined;
    if (existing) return mapRelation(existing);

    const relation: NodeRelation = {
      id: randomUUID(),
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      type: input.type,
      evidenceIds: [...new Set(input.evidenceIds ?? [])],
      createdAt: new Date().toISOString(),
    };
    this.#db
      .prepare(
        `INSERT INTO node_relations
          (id, source_node_id, target_node_id, relation_type,
           evidence_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        relation.id,
        relation.sourceNodeId,
        relation.targetNodeId,
        relation.type,
        JSON.stringify(relation.evidenceIds),
        relation.createdAt,
      );
    return relation;
  }

  getRelations(nodeIds: string[], maxHops = 1): NodeRelation[] {
    const visitedNodes = new Set(nodeIds);
    const relations = new Map<string, NodeRelation>();
    let frontier = [...visitedNodes];
    for (let hop = 0; hop < Math.max(0, maxHops) && frontier.length > 0; hop += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const rows = this.#db
          .prepare(
            `SELECT * FROM node_relations
             WHERE source_node_id = ? OR target_node_id = ?`,
          )
          .all(nodeId, nodeId) as Row[];
        for (const row of rows) {
          const relation = mapRelation(row);
          relations.set(relation.id, relation);
          for (const related of [relation.sourceNodeId, relation.targetNodeId]) {
            if (!visitedNodes.has(related)) {
              visitedNodes.add(related);
              next.push(related);
            }
          }
        }
      }
      frontier = next;
    }
    return [...relations.values()];
  }

  searchContext(query: string, options: SearchOptions = {}): MemoryContext {
    const direct = this.search(query, options);
    const relations = this.getRelations(
      direct.map((result) => result.node.id),
      options.graphHops ?? 1,
    );
    const directNodeIds = new Set(direct.map((result) => result.node.id));
    const relatedNodeIds = [...new Set(relations.flatMap(
      (relation) => [relation.sourceNodeId, relation.targetNodeId],
    ))].filter((id) => !directNodeIds.has(id));
    const related = relatedNodeIds.flatMap(
      (nodeId) => this.#resultsForNode(nodeId, options.maxTier ?? 1, 2),
    );
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const results = [...direct, ...related]
      .filter(
        (result, index, all) =>
          all.findIndex((candidate) => candidate.memory.id === result.memory.id) === index,
      )
      .slice(0, limit);
    return { results, relations };
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
           m.memory_type AS m_memory_type, m.state_key AS m_state_key,
           m.event_time AS m_event_time, m.source_actor AS m_source_actor,
           m.truth_status AS m_truth_status,
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

    const results = rows
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
    for (const result of results) {
      result.memory.evidenceIds = this.#evidenceIds(result.memory.id);
      result.evidenceRecords = this.#evidenceRecords(result.memory.evidenceIds);
    }
    return results;
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
    if (existing) {
      const row = this.#db
        .prepare("SELECT content FROM history_records WHERE id = ?")
        .get(existing.historyId) as Row | undefined;
      if (row && String(row.content) === input.transcript) return existing;
    }

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
      this.#db.prepare(
        `INSERT INTO session_archives (session_id, history_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           history_id = excluded.history_id,
           created_at = excluded.created_at`,
      ).run(archive.sessionId, archive.historyId, archive.createdAt);
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
        memory_type TEXT NOT NULL DEFAULT 'fact',
        state_key TEXT,
        event_time TEXT,
        source_actor TEXT NOT NULL DEFAULT 'user',
        truth_status TEXT NOT NULL DEFAULT 'asserted',
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

      CREATE TABLE IF NOT EXISTS memory_evidence_links (
        memory_id TEXT NOT NULL REFERENCES memory_records(id),
        history_id TEXT NOT NULL REFERENCES history_records(id),
        PRIMARY KEY (memory_id, history_id)
      );

      CREATE TABLE IF NOT EXISTS memory_derivations (
        derived_memory_id TEXT NOT NULL REFERENCES memory_records(id),
        source_memory_id TEXT NOT NULL REFERENCES memory_records(id),
        PRIMARY KEY (derived_memory_id, source_memory_id)
      );

      CREATE TABLE IF NOT EXISTS node_relations (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        target_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        relation_type TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE (source_node_id, target_node_id, relation_type)
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
      CREATE INDEX IF NOT EXISTS idx_node_relations_source
        ON node_relations(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_node_relations_target
        ON node_relations(target_node_id);
    `);
    this.#ensureMemoryColumns();
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_records_state
        ON memory_records(memory_type, state_key, status);
      INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
      SELECT id, evidence_id FROM memory_records;
    `);
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
      ["memory_type", "TEXT NOT NULL DEFAULT 'fact'"],
      ["state_key", "TEXT"],
      ["event_time", "TEXT"],
      ["source_actor", "TEXT NOT NULL DEFAULT 'user'"],
      ["truth_status", "TEXT NOT NULL DEFAULT 'asserted'"],
    ];
    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.#db.exec(`ALTER TABLE memory_records ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  #evidenceIds(memoryId: string): string[] {
    return (this.#db
      .prepare(
        `SELECT history_id FROM memory_evidence_links
         WHERE memory_id = ? ORDER BY history_id`,
      )
      .all(memoryId) as Row[]).map((row) => String(row.history_id));
  }

  #resultsForNode(
    nodeId: string,
    maxTier: MemoryTier,
    limit: number,
  ): MemorySearchResult[] {
    const rows = this.#db.prepare(
      `SELECT
         m.id AS m_id, m.node_id AS m_node_id,
         m.evidence_id AS m_evidence_id, m.statement AS m_statement,
         m.memory_type AS m_memory_type, m.state_key AS m_state_key,
         m.event_time AS m_event_time, m.source_actor AS m_source_actor,
         m.truth_status AS m_truth_status,
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
       WHERE m.node_id = ? AND m.tier <= ?
         AND m.status IN ('active', 'disputed')
       ORDER BY m.tier ASC, m.importance DESC, m.created_at DESC
       LIMIT ?`,
    ).all(nodeId, maxTier, limit) as Row[];
    return rows.map((row) => {
      const result = mapSearchResult(row, 0);
      result.memory.evidenceIds = this.#evidenceIds(result.memory.id);
      result.evidenceRecords = this.#evidenceRecords(result.memory.evidenceIds);
      return result;
    });
  }

  #evidenceRecords(ids: string[]): HistoryRecord[] {
    const statement = this.#db.prepare("SELECT * FROM history_records WHERE id = ?");
    return ids.flatMap((id) => {
      const row = statement.get(id) as Row | undefined;
      return row ? [mapHistory(row)] : [];
    });
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
      evidenceIds: [String(row.m_evidence_id)],
      statement: String(row.m_statement),
      memoryType: String(row.m_memory_type) as MemoryRecord["memoryType"],
      stateKey: row.m_state_key ? String(row.m_state_key) : null,
      eventTime: row.m_event_time ? String(row.m_event_time) : null,
      sourceActor: String(row.m_source_actor) as MemoryRecord["sourceActor"],
      truthStatus: String(row.m_truth_status) as MemoryRecord["truthStatus"],
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
    evidenceRecords: [],
    lexicalScore: score,
  };
}

function mapHistory(row: Row): HistoryRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id ? String(row.session_id) : null,
    role: String(row.role) as HistoryRole,
    content: String(row.content),
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    createdAt: String(row.created_at),
  };
}

function mapRelation(row: Row): NodeRelation {
  return {
    id: String(row.id),
    sourceNodeId: String(row.source_node_id),
    targetNodeId: String(row.target_node_id),
    type: String(row.relation_type) as NodeRelationType,
    evidenceIds: parseStringArray(row.evidence_ids_json),
    createdAt: String(row.created_at),
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

function parseStringArray(value: string | number | null): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function matchesScope(memory: MemoryScope, requested?: MemoryScope): boolean {
  if (!requested) return true;
  return Object.entries(requested).every(([key, value]) => memory[key] === value);
}

function serializeScope(scope: MemoryScope): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([left], [right]) =>
      left.localeCompare(right))),
  );
}
