/**
 * SQLite schema creation and forward migration.
 *
 * Extracted from NmgStore, which had grown to hold mutations, queries,
 * maintenance and migration in one class with no internal seam. This group is
 * the cleanest boundary: every function here depends only on the database
 * handle, never on the embedder, router or vector caches.
 *
 * Migration is expected to run on every store open, so all statements are
 * idempotent — CREATE TABLE IF NOT EXISTS, ALTER TABLE guarded by a
 * PRAGMA table_info probe, and INSERT OR IGNORE backfills.
 */

import type { DatabaseSync } from "node:sqlite";

import { encodeVector, parseVector } from "./vector-codec.ts";

type Row = Record<string, string | number | Uint8Array | null>;

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_records (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      source_message_id TEXT,
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
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      residence TEXT NOT NULL DEFAULT 'ltg' CHECK (residence IN ('stg', 'ltg'))
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
      confidence REAL,
      polarity TEXT,
      extract_method TEXT CHECK (extract_method IN ('rule', 'llm')),
      claims_json TEXT,
      markers_json TEXT NOT NULL DEFAULT '[]',
      predicate_key TEXT,
      scope_json TEXT NOT NULL DEFAULT '{}',
      valid_from TEXT,
      valid_until TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      residence TEXT NOT NULL DEFAULT 'ltg' CHECK (residence IN ('stg', 'ltg')),
      promoted_at TEXT,
      expires_at TEXT,
      evidence_role TEXT NOT NULL DEFAULT 'support',
      supersedes_id TEXT REFERENCES memory_records(id),
      tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
      importance REAL NOT NULL CHECK (importance BETWEEN 0 AND 1),
      access_count INTEGER NOT NULL DEFAULT 0,
      pending_access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      write_reason TEXT NOT NULL DEFAULT 'legacy_write',
      write_source TEXT NOT NULL DEFAULT 'core',
      storage_state TEXT NOT NULL DEFAULT 'indexed'
        CHECK (storage_state IN ('indexed', 'dormant', 'quarantine')),
      retention_changed_at TEXT,
      quarantine_until TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_write_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT REFERENCES memory_records(id) ON DELETE SET NULL,
      history_id TEXT REFERENCES history_records(id) ON DELETE SET NULL,
      session_id TEXT,
      decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
      policy_reason TEXT NOT NULL,
      write_reason TEXT NOT NULL,
      write_source TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      requested_residence TEXT NOT NULL,
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
      residence TEXT NOT NULL DEFAULT 'ltg',
      status TEXT NOT NULL DEFAULT 'consolidated',
      stability REAL NOT NULL DEFAULT 1,
      strength REAL NOT NULL DEFAULT 0.5,
      direction TEXT NOT NULL DEFAULT 'both',
      fan_budget INTEGER NOT NULL DEFAULT 1,
      activation_rule TEXT NOT NULL DEFAULT 'conductive',
      consolidation_source TEXT NOT NULL DEFAULT 'explicit',
      consolidated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (source_node_id, target_node_id, relation_type)
    );

    CREATE TABLE IF NOT EXISTS node_transforms (
      id TEXT PRIMARY KEY,
      transform_type TEXT NOT NULL,
      source_node_ids_json TEXT NOT NULL,
      target_node_ids_json TEXT NOT NULL,
      moved_memory_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_redirects (
      source_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      target_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      transform_id TEXT NOT NULL REFERENCES node_transforms(id),
      PRIMARY KEY (source_node_id, target_node_id, transform_id)
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT NOT NULL REFERENCES memory_records(id),
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      vector_blob BLOB,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, model)
    );

    CREATE TABLE IF NOT EXISTS node_embeddings (
      node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      vector_blob BLOB,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (node_id, model)
    );

    CREATE TABLE IF NOT EXISTS memory_leaf_blocks (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
      summary TEXT NOT NULL,
      memory_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_leaf_members (
      block_id TEXT NOT NULL REFERENCES memory_leaf_blocks(id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL REFERENCES memory_records(id),
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (block_id, memory_id)
    );

    CREATE TABLE IF NOT EXISTS leaf_embeddings (
      block_id TEXT NOT NULL REFERENCES memory_leaf_blocks(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      vector_blob BLOB,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (block_id, model)
    );

    CREATE TABLE IF NOT EXISTS leaf_block_status (
      node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id),
      dirty INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_index_delta (
      memory_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      operation TEXT NOT NULL CHECK (operation IN ('move', 'upsert')),
      compacted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS embedding_index_state (
      index_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      profile TEXT NOT NULL,
      targets_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('failed', 'ready', 'running')),
      last_started_at TEXT,
      last_succeeded_at TEXT,
      last_failed_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS retrieval_traces (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      query TEXT NOT NULL,
      result_memory_ids_json TEXT NOT NULL,
      result_node_ids_json TEXT NOT NULL,
      expanded_node_ids_json TEXT NOT NULL,
      useful_memory_ids_json TEXT NOT NULL,
      contradicted_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      rejected_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      relation_ids_json TEXT NOT NULL DEFAULT '[]',
      task_id TEXT NOT NULL DEFAULT '',
      active_graph_budget_json TEXT NOT NULL DEFAULT '{}',
      active_graph_usage_json TEXT NOT NULL DEFAULT '{}',
      selections_json TEXT NOT NULL DEFAULT '[]',
      expansions_json TEXT NOT NULL DEFAULT '[]',
      budget_ledger_json TEXT NOT NULL DEFAULT '[]',
      ambiguity REAL NOT NULL,
      fallback_used INTEGER NOT NULL,
      conflict_observed INTEGER NOT NULL,
      qpp_json TEXT NOT NULL DEFAULT '{}',
      timings_json TEXT NOT NULL DEFAULT '{}',
      filter_usage_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS perf_aggregates (
      section TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      sum REAL NOT NULL DEFAULT 0,
      sum_sq REAL NOT NULL DEFAULT 0,
      buckets_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (section)
    );

    CREATE TABLE IF NOT EXISTS node_retrieval_signals (
      node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id),
      query_count INTEGER NOT NULL DEFAULT 0,
      ambiguity_sum REAL NOT NULL DEFAULT 0,
      fallback_count INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_pair_signals (
      left_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      right_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      co_retrieval_count INTEGER NOT NULL DEFAULT 0,
      useful_count INTEGER NOT NULL DEFAULT 0,
      evidence_trace_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (left_node_id, right_node_id)
    );

    CREATE TABLE IF NOT EXISTS edge_task_observations (
      left_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      right_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      task_id TEXT NOT NULL,
      trace_id TEXT NOT NULL REFERENCES retrieval_traces(id),
      useful INTEGER NOT NULL DEFAULT 0,
      contradicted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (left_node_id, right_node_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS node_activation_signals (
      node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id),
      selected_count INTEGER NOT NULL DEFAULT 0,
      expanded_count INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      contradicted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edge_activation_signals (
      relation_id TEXT PRIMARY KEY REFERENCES node_relations(id) ON DELETE CASCADE,
      selected_count INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      contradicted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consolidation_events (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      previous_state TEXT NOT NULL,
      next_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_trace_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topology_proposals (
      id TEXT PRIMARY KEY,
      proposal_key TEXT NOT NULL,
      proposal_type TEXT NOT NULL CHECK (proposal_type IN ('link', 'split')),
      source_node_ids_json TEXT NOT NULL,
      relation_type TEXT,
      partitions_json TEXT NOT NULL,
      evidence_trace_ids_json TEXT NOT NULL,
      observations INTEGER NOT NULL,
      estimated_gain REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS router_weights (
      node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id),
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      weights_json TEXT NOT NULL,
      examples INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_fts_registry (
      memory_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_id UNINDEXED,
      statement,
      node_name,
      evidence,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS state_key_aliases (
      alias_key TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (alias_key, scope_json)
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
    CREATE INDEX IF NOT EXISTS idx_memory_index_delta_node
      ON memory_index_delta(node_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_topology_proposals_key_created
      ON topology_proposals(proposal_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_edge_task_observations_pair
      ON edge_task_observations(left_node_id, right_node_id, created_at);
  `);
  ensureMemoryColumns(db);
  ensureHistoryColumns(db);
  ensureEmbeddingTable(db);
  ensureNodeColumns(db);
  ensureRelationColumns(db);
  ensureRetrievalTraceColumns(db);
  ensurePerfAggregateColumns(db);
  ensureDeltaColumns(db);
  ensureBinaryVectors(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_history_source_message
      ON history_records(session_id, source_message_id)
      WHERE source_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_records_state
      ON memory_records(memory_type, state_key, status);
    CREATE INDEX IF NOT EXISTS idx_memory_records_residence_expiry
      ON memory_records(residence, expires_at, status);
    CREATE INDEX IF NOT EXISTS idx_retrieval_traces_created_at
      ON retrieval_traces(created_at);
    UPDATE memory_records SET promoted_at = created_at
      WHERE residence = 'ltg' AND promoted_at IS NULL;
    INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
    SELECT id, evidence_id FROM memory_records;
    INSERT INTO memory_fts(memory_id, statement, node_name, evidence)
    SELECT m.id, m.statement, n.canonical_name, h.content
    FROM memory_records m
    JOIN memory_nodes n ON n.id = m.node_id
    JOIN history_records h ON h.id = m.evidence_id
    LEFT JOIN memory_fts_registry r ON r.memory_id = m.id
    WHERE r.memory_id IS NULL AND m.storage_state = 'indexed';
    INSERT OR IGNORE INTO memory_fts_registry(memory_id)
    SELECT id FROM memory_records WHERE storage_state = 'indexed';
    INSERT OR IGNORE INTO leaf_block_status(node_id, dirty, updated_at)
    SELECT id, 1, updated_at FROM memory_nodes WHERE status = 'active';
  `);
}

export function ensureMemoryColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(memory_records)").all() as Row[]).map((row) => String(row.name)),
  );
  const additions: Array<[string, string]> = [
    ["session_id", "TEXT"],
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
    ["confidence", "REAL"],
    ["polarity", "TEXT"],
    ["extract_method", "TEXT CHECK (extract_method IN ('rule', 'llm'))"],
    ["claims_json", "TEXT"],
    ["markers_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["predicate_key", "TEXT"],
    ["pending_access_count", "INTEGER NOT NULL DEFAULT 0"],
    ["residence", "TEXT NOT NULL DEFAULT 'ltg'"],
    ["promoted_at", "TEXT"],
    ["expires_at", "TEXT"],
    ["write_reason", "TEXT NOT NULL DEFAULT 'legacy_write'"],
    ["write_source", "TEXT NOT NULL DEFAULT 'core'"],
    ["storage_state", "TEXT NOT NULL DEFAULT 'indexed'"],
    ["retention_changed_at", "TEXT"],
    ["quarantine_until", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE memory_records ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_memory_records_storage_state
     ON memory_records(storage_state, retention_changed_at)`,
  );
}

export function ensureDeltaColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(memory_index_delta)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  if (!columns.has("compacted")) {
    db.exec("ALTER TABLE memory_index_delta ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0");
  }
}

export function ensureBinaryVectors(db: DatabaseSync): void {
  const tables: Array<[string, string]> = [
    ["memory_embeddings", "memory_id"],
    ["node_embeddings", "node_id"],
    ["leaf_embeddings", "block_id"],
  ];
  for (const [table, idColumn] of tables) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name)),
    );
    if (!columns.has("vector_blob")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN vector_blob BLOB`);
    }
    const rows = db
      .prepare(
        `SELECT ${idColumn} AS id, model, vector_json FROM ${table}
       WHERE vector_blob IS NULL`,
      )
      .all() as Row[];
    const update = db.prepare(
      `UPDATE ${table} SET vector_blob = ? WHERE ${idColumn} = ? AND model = ?`,
    );
    for (const row of rows) {
      update.run(encodeVector(parseVector(row.vector_json)), row.id, row.model);
    }
  }
}

export function ensureHistoryColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(history_records)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  if (!existing.has("source_message_id")) {
    db.exec("ALTER TABLE history_records ADD COLUMN source_message_id TEXT");
  }
}

export function ensureEmbeddingTable(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(memory_embeddings)").all() as Row[];
  const primaryKeyColumns = columns
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
  if (primaryKeyColumns.join(",") === "memory_id,model") return;
  db.exec(`
    ALTER TABLE memory_embeddings RENAME TO memory_embeddings_legacy;
    CREATE TABLE memory_embeddings (
      memory_id TEXT NOT NULL REFERENCES memory_records(id),
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, model)
    );
    INSERT OR REPLACE INTO memory_embeddings
      (memory_id, model, dimensions, vector_json, updated_at)
    SELECT memory_id, model, dimensions, vector_json, updated_at
    FROM memory_embeddings_legacy;
    DROP TABLE memory_embeddings_legacy;
  `);
}

export function ensureNodeColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(memory_nodes)").all() as Row[]).map((row) => String(row.name)),
  );
  if (!existing.has("status")) {
    db.exec("ALTER TABLE memory_nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!existing.has("residence")) {
    db.exec("ALTER TABLE memory_nodes ADD COLUMN residence TEXT NOT NULL DEFAULT 'ltg'");
  }
}

export function ensurePerfAggregateColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(perf_aggregates)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  if (!existing.has("buckets_json")) {
    db.exec("ALTER TABLE perf_aggregates ADD COLUMN buckets_json TEXT NOT NULL DEFAULT '[]'");
  }
}

export function ensureRelationColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(node_relations)").all() as Row[]).map((row) => String(row.name)),
  );
  const additions: Array<[string, string]> = [
    ["residence", "TEXT NOT NULL DEFAULT 'ltg'"],
    ["status", "TEXT NOT NULL DEFAULT 'consolidated'"],
    ["stability", "REAL NOT NULL DEFAULT 1"],
    ["strength", "REAL NOT NULL DEFAULT 0.5"],
    ["direction", "TEXT NOT NULL DEFAULT 'both'"],
    ["fan_budget", "INTEGER NOT NULL DEFAULT 1"],
    ["activation_rule", "TEXT NOT NULL DEFAULT 'conductive'"],
    ["consolidation_source", "TEXT NOT NULL DEFAULT 'explicit'"],
    ["consolidated_at", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE node_relations ADD COLUMN ${name} ${definition}`);
  }
  if (!existing.has("direction")) {
    db.exec(`UPDATE node_relations SET direction = CASE
      WHEN relation_type IN ('causes', 'depends_on', 'is_a', 'part_of') THEN 'source->target'
      WHEN relation_type = 'derived_from' THEN 'target->source'
      ELSE 'both' END`);
  }
  if (!existing.has("activation_rule")) {
    db.exec(`UPDATE node_relations SET activation_rule = CASE
      WHEN relation_type IN ('contradicts', 'supersedes', 'exception_to') THEN 'regulatory'
      ELSE 'conductive' END`);
  }
  if (!existing.has("fan_budget")) {
    db.exec("UPDATE node_relations SET fan_budget = CASE WHEN relation_type = 'derived_from' THEN 0 ELSE 1 END");
  }
  db.exec("UPDATE node_relations SET consolidated_at = created_at WHERE consolidated_at IS NULL");
}

export function ensureRetrievalTraceColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(retrieval_traces)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  const additions: Array<[string, string]> = [
    ["contradicted_memory_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["rejected_memory_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["relation_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["task_id", "TEXT NOT NULL DEFAULT ''"],
    ["active_graph_budget_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["active_graph_usage_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["selections_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["expansions_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["budget_ledger_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["qpp_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["timings_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["filter_usage_json", "TEXT NOT NULL DEFAULT '{}'"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name))
      db.exec(`ALTER TABLE retrieval_traces ADD COLUMN ${name} ${definition}`);
  }
}
