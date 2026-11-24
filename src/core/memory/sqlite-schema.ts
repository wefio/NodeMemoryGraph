import type { DatabaseSync } from "node:sqlite";

export const RELATIONAL_SCHEMA_VERSION = 2;

export const SCHEMA_DDL_SQL = `
  CREATE TABLE IF NOT EXISTS nmg_memory_head (
    namespace TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nmg_schema_migrations (
    namespace TEXT NOT NULL,
    version INTEGER NOT NULL,
    migrated_at TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    PRIMARY KEY(namespace, version)
  );

  CREATE TABLE IF NOT EXISTS nmg_receipts (
    namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    result_ids_json TEXT NOT NULL,
    has_result INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY(namespace, operation_id)
  );

  CREATE TABLE IF NOT EXISTS nmg_sources (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    session_id TEXT,
    source_message_id TEXT,
    ordinal INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    source_ref TEXT,
    source_kind TEXT NOT NULL DEFAULT 'raw',
    created_at TEXT NOT NULL,
    ext_json TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_sources_by_session_ord
    ON nmg_sources(namespace, session_id, ordinal DESC, id);
  CREATE INDEX IF NOT EXISTS nmg_sources_by_session
    ON nmg_sources(namespace, session_id);
  CREATE INDEX IF NOT EXISTS nmg_sources_by_session_msg
    ON nmg_sources(namespace, session_id, source_message_id, id);
  CREATE INDEX IF NOT EXISTS nmg_sources_by_msg
    ON nmg_sources(namespace, source_message_id, id);

  CREATE TABLE IF NOT EXISTS nmg_nodes (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    residence TEXT NOT NULL,
    unbound INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_nodes_by_name
    ON nmg_nodes(namespace, normalized_name, id);

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
    extract_method TEXT,
    truth_status TEXT NOT NULL,
    evidence_role TEXT NOT NULL,
    write_reason TEXT NOT NULL,
    write_source TEXT NOT NULL,
    has_forget INTEGER NOT NULL,
    state_key TEXT NOT NULL,
    predicate_key TEXT NOT NULL,
    scope TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    has_source_session INTEGER NOT NULL,
    source_actor TEXT NOT NULL,
    node_id TEXT NOT NULL,
    primary_evidence_id TEXT NOT NULL,
    supersedes_id TEXT NOT NULL,
    event_time TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sort_time TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    promoted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    access_count INTEGER NOT NULL,
    last_accessed_at TEXT NOT NULL,
    ext_json TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_memories_by_scope_name
    ON nmg_memories(namespace, scope, normalized_name, id);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_scope_node
    ON nmg_memories(namespace, scope, node_id, id);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_scope_state
    ON nmg_memories(namespace, scope, state_key, sort_time DESC, id ASC);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_scope_id
    ON nmg_memories(namespace, scope, id);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_node
    ON nmg_memories(namespace, node_id, id);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_supersedes
    ON nmg_memories(namespace, supersedes_id, id) WHERE supersedes_id <> '';
  CREATE INDEX IF NOT EXISTS nmg_memories_by_primary_evidence
    ON nmg_memories(namespace, primary_evidence_id, id);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_embedding_order
    ON nmg_memories(namespace, created_at DESC, id ASC)
    WHERE status <> 'deleted' AND storage_state = '' AND has_forget = 0;
  CREATE INDEX IF NOT EXISTS nmg_memories_by_filter
    ON nmg_memories(namespace, status, storage_state, has_forget, sort_time DESC, id ASC);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_session
    ON nmg_memories(namespace, source_session_id, sort_time DESC, id ASC);
  CREATE INDEX IF NOT EXISTS nmg_memories_by_event_time
    ON nmg_memories(namespace, event_time DESC, id ASC);
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
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    ext_json TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_memory_relations_by_source
    ON nmg_memory_relations(namespace, source_id, status, relation_type, target_id);
  CREATE INDEX IF NOT EXISTS nmg_memory_relations_by_target
    ON nmg_memory_relations(namespace, target_id, status, relation_type, source_id);
  CREATE INDEX IF NOT EXISTS nmg_memory_relations_edge_source
    ON nmg_memory_relations(namespace, source_id, id) WHERE origin = 'node_edge';
  CREATE INDEX IF NOT EXISTS nmg_memory_relations_edge_target
    ON nmg_memory_relations(namespace, target_id, id) WHERE origin = 'node_edge';

  CREATE TABLE IF NOT EXISTS nmg_memory_markers (
    namespace TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    marker_key TEXT NOT NULL,
    marker_value TEXT NOT NULL,
    attr_json TEXT NOT NULL,
    PRIMARY KEY(namespace, memory_id, ordinal)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS nmg_memory_markers_by_kind_val
    ON nmg_memory_markers(namespace, kind, marker_value, memory_id);

  CREATE TABLE IF NOT EXISTS nmg_tesserae (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    memory_id TEXT,
    path TEXT NOT NULL,
    snippet TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT,
    file_simhash TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_tesserae_by_memory
    ON nmg_tesserae(namespace, memory_id, id) WHERE memory_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS nmg_state_aliases (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    alias_key TEXT NOT NULL,
    canonical_key TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );

  CREATE TABLE IF NOT EXISTS nmg_write_events (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    memory_id TEXT,
    history_id TEXT,
    session_id TEXT,
    decision TEXT NOT NULL,
    policy_reason TEXT NOT NULL,
    write_reason TEXT NOT NULL,
    write_source TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    requested_residence TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_write_events_by_policy
    ON nmg_write_events(namespace, policy_reason, id);

  CREATE TABLE IF NOT EXISTS nmg_relation_proposals (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    session_id TEXT,
    proposal_key TEXT NOT NULL,
    proposal_type TEXT NOT NULL,
    relation_type TEXT,
    status TEXT NOT NULL,
    observations INTEGER NOT NULL,
    estimated_gain REAL NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );

  CREATE TABLE IF NOT EXISTS nmg_claim_posteriors (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    claim_index INTEGER NOT NULL,
    session_id TEXT,
    claim_text TEXT NOT NULL,
    prior_confidence REAL NOT NULL,
    alpha REAL NOT NULL,
    beta REAL NOT NULL,
    mean REAL NOT NULL,
    conservative_lower_bound REAL NOT NULL,
    independent_vote_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );
  CREATE INDEX IF NOT EXISTS nmg_claim_posteriors_by_memory
    ON nmg_claim_posteriors(namespace, memory_id, claim_index);

  CREATE TABLE IF NOT EXISTS nmg_claim_outcomes (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    claim_index INTEGER NOT NULL,
    semantic_task_id TEXT NOT NULL,
    session_id TEXT,
    outcome TEXT NOT NULL,
    source TEXT NOT NULL,
    source_lineage TEXT NOT NULL,
    evidence_id TEXT,
    collection_origin TEXT NOT NULL,
    weight REAL NOT NULL,
    active_graph_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );

  CREATE TABLE IF NOT EXISTS nmg_resolution_events (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    session_id TEXT,
    from_resolution TEXT NOT NULL,
    to_resolution TEXT NOT NULL,
    opened_at TEXT,
    related_ids_json TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(namespace, id)
  );
`;

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table)
      .map((row) => String(row.name)),
  );
}

/**
 * Drop transitional v1 relational tables if they lack v2 lossless columns.
 * The caller re-populates them from `nmg_memory_entities` in the same migration transaction.
 */
export function upgradeTransitionalRelationalTables(db: DatabaseSync): boolean {
  const memCols = tableColumns(db, "nmg_memories");
  const markerCols = tableColumns(db, "nmg_memory_markers");
  const isTransitionalV1 =
    (memCols.size > 0 && !memCols.has("truth_status")) ||
    (markerCols.size > 0 && !markerCols.has("ordinal"));
  if (!isTransitionalV1) return false;
  db.exec(`
    DROP TABLE IF EXISTS nmg_relational_backfill;
    DROP TABLE IF EXISTS nmg_memory_markers;
    DROP TABLE IF EXISTS nmg_memory_relations;
    DROP TABLE IF EXISTS nmg_memory_evidence;
    DROP TABLE IF EXISTS nmg_memories;
    DROP TABLE IF EXISTS nmg_sources;
  `);
  return true;
}

/** Create or upgrade the authoritative v2 relational tables. */
export function ensureRelationalTables(db: DatabaseSync): void {
  db.exec(SCHEMA_DDL_SQL);
}
