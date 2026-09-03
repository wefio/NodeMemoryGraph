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

import { ftsIndexedText, surfaceIndexedText } from "./search-ranking.ts";
import { recallTriggersFromStoredMarkers } from "../recall-triggers.ts";
import { encodeVector, parseVector } from "./vector-codec.ts";

type Row = Record<string, string | number | Uint8Array | null>;

/**
 * Forward-migrate stores created before the anchors → tesserae rename (PR #19):
 * the old `anchors` table becomes `tesserae` in place so existing bookmarks and
 * their markers survive. Runs before the main idempotent DDL so the later
 * `CREATE TABLE IF NOT EXISTS tesserae` is a no-op against the renamed table.
 * FTS index and triggers are rebuilt under the new names; the old FTS5
 * external-content table is dropped because FTS5 content tables cannot be
 * renamed reliably. Existing `anchor_ref` markers are rewritten to
 * `tessera_ref` in place (the open-string markers channel, no schema change).
 */
export function migrateLegacyTesseraeTables(db: DatabaseSync): void {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  if (tables.has("tesserae") || !tables.has("anchors")) return;
  db.exec(`
    DROP TRIGGER IF EXISTS anchors_fts_ai;
    DROP TRIGGER IF EXISTS anchors_fts_ad;
    DROP TRIGGER IF EXISTS anchors_fts_au;
    DROP TABLE IF EXISTS anchors_fts;
    ALTER TABLE anchors RENAME TO tesserae;
  `);
  db.exec(`
    UPDATE memory_records
    SET markers_json = REPLACE(markers_json, '"anchor_ref"', '"tessera_ref"')
    WHERE markers_json LIKE '%anchor_ref%';
  `);
}

export function migrate(db: DatabaseSync): void {
  migrateLegacyTesseraeTables(db);
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
      session_id TEXT,
      predicate_key TEXT,
      scope_json TEXT NOT NULL DEFAULT '{}',
      valid_from TEXT,
      valid_until TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      resolution TEXT NOT NULL DEFAULT 'resolved'
        CHECK (resolution IN ('open', 'resolved', 'reopened')),
      opened_at TEXT,
      related_memory_ids_json TEXT NOT NULL DEFAULT '[]',
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

    CREATE TABLE IF NOT EXISTS memory_resolution_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memory_records(id),
      from_resolution TEXT NOT NULL,
      to_resolution TEXT NOT NULL,
      opened_at TEXT,
      related_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT,
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

    CREATE TABLE IF NOT EXISTS claim_posteriors (
      memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      claim_index INTEGER NOT NULL,
      claim_text TEXT NOT NULL,
      prior_confidence REAL NOT NULL,
      alpha REAL NOT NULL,
      beta REAL NOT NULL,
      independent_vote_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, claim_index)
    );

    CREATE TABLE IF NOT EXISTS claim_outcome_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      claim_index INTEGER NOT NULL,
      semantic_task_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('benchmark', 'task', 'tool', 'user')),
      source_lineage TEXT NOT NULL,
      evidence_id TEXT REFERENCES history_records(id) ON DELETE SET NULL,
      collection_origin TEXT NOT NULL DEFAULT 'legacy'
        CHECK (collection_origin IN ('controlled', 'legacy', 'natural')),
      outcome TEXT NOT NULL CHECK (outcome IN ('supported', 'contradicted')),
      weight REAL NOT NULL CHECK (weight > 0 AND weight <= 1),
      active_graph_id TEXT REFERENCES retrieval_traces(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE (memory_id, claim_index, semantic_task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_claim_outcome_events_task
      ON claim_outcome_events(semantic_task_id, created_at);

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

    CREATE TABLE IF NOT EXISTS node_transform_journals (
      transform_id TEXT PRIMARY KEY REFERENCES node_transforms(id),
      snapshot_json TEXT NOT NULL,
      expected_json TEXT NOT NULL,
      rolled_back_at TEXT
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
      disclosed_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      attributed_memory_ids_json TEXT NOT NULL DEFAULT '[]',
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
      signals_drained_at TEXT,
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

    CREATE TABLE IF NOT EXISTS maintenance_runs (
      id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      considered_nodes INTEGER NOT NULL,
      rows_touched INTEGER NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      duration_ms REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_maintenance_runs_created_at
      ON maintenance_runs(created_at);

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
      evidence_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      observations INTEGER NOT NULL,
      estimated_gain REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      actuated_transform_id TEXT,
      actuation_error TEXT,
      actuated_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_maintenance_proposals (
      id TEXT PRIMARY KEY,
      defect_type TEXT NOT NULL CHECK (defect_type IN ('content', 'retrieval', 'scope')),
      action TEXT NOT NULL CHECK (
        action IN ('merge', 'observe', 'rescope', 'rewrite', 'split', 'supersede')
      ),
      target_memory_ids_json TEXT NOT NULL,
      evidence_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_trace_ids_json TEXT NOT NULL DEFAULT '[]',
      proposed_statement TEXT,
      proposed_scope_json TEXT,
      policy_id TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      policy_source_hash TEXT NOT NULL,
      minimum_long_horizon_score REAL NOT NULL CHECK (
        minimum_long_horizon_score >= 0 AND minimum_long_horizon_score <= 1
      ),
      long_horizon_score REAL NOT NULL CHECK (long_horizon_score >= 0 AND long_horizon_score <= 1),
      evaluation_kind TEXT NOT NULL CHECK (evaluation_kind IN ('held_out', 'matched_replay')),
      evaluation_ref TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('accepted', 'pending', 'rejected')),
      review_reason TEXT,
      reviewed_at TEXT,
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

    CREATE TABLE IF NOT EXISTS store_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_id UNINDEXED,
      statement,
      node_name,
      evidence,
      tokenize = 'unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_surface_fts USING fts5(
      content,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram'
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

    CREATE TABLE IF NOT EXISTS task_board_entries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      -- Legacy internal column kept for schema compatibility with existing
      -- stores. It is no longer generated, read, or exposed: ordering and the
      -- opaque continuation cursor are derived from (created_at, id), where
      -- the id embeds a per-channel monotonic counter that never recycles
      -- (see task_board_counters). New writes store 0 here.
      sequence INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT NOT NULL,
      source_session_id TEXT,
      kind TEXT NOT NULL CHECK (
        kind IN ('blocker', 'decision', 'goal', 'handoff', 'note', 'question', 'result')
      ),
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution TEXT
    );

    -- Global monotonic counter for task-board entry ids. Kept in a separate
    -- table so deletion (expiry/resolve) never recycles a counter: the id
    -- embeds the counter, so same-millisecond entries stay in insertion order
    -- deterministically AND the id is globally unique across all channels
    -- (the entries table uses id as its PRIMARY KEY).
    CREATE TABLE IF NOT EXISTS task_board_counters (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      counter INTEGER NOT NULL DEFAULT 0
    );

    -- Memory tesserae (bookmarks): content-anchored file locations a memory
    -- points into. Independent searchable source (label/path/snippet FTS);
    -- memory ↔ tessera linkage rides the open-string markers channel
    -- (TESSERA_REF_MARKER), so no schema coupling to memory_records is needed
    -- here beyond an optional soft memory_id back-pointer. Snippet is the
    -- relocation key — line numbers are never persisted (they drift on edit).
    CREATE TABLE IF NOT EXISTS tesserae (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      snippet TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      kind TEXT,
      memory_id TEXT,
      created_at TEXT NOT NULL,
      -- 64-bit SimHash of the target file at tessera write time (16 lowercase
      -- hex). Drift tolerance: when the snippet no longer matches in the path,
      -- compare this fingerprint against current files to find the document
      -- after a small edit or move. Stored TEXT because the full unsigned
      -- 64-bit range cannot round-trip through SQLite INTEGER (see simhash.ts).
      file_simhash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tesserae_path ON tesserae(path);
    CREATE INDEX IF NOT EXISTS idx_tesserae_memory ON tesserae(memory_id) WHERE memory_id IS NOT NULL;
    CREATE VIRTUAL TABLE IF NOT EXISTS tesserae_fts USING fts5(
      label,
      snippet,
      path UNINDEXED,
      content = 'tesserae',
      content_rowid = 'rowid',
      tokenize = 'unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS tesserae_fts_ai AFTER INSERT ON tesserae BEGIN
      INSERT INTO tesserae_fts (rowid, label, snippet, path) VALUES (new.rowid, new.label, new.snippet, new.path);
    END;
    CREATE TRIGGER IF NOT EXISTS tesserae_fts_ad AFTER DELETE ON tesserae BEGIN
      INSERT INTO tesserae_fts (tesserae_fts, rowid, label, snippet, path)
      VALUES ('delete', old.rowid, old.label, old.snippet, old.path);
    END;
    CREATE TRIGGER IF NOT EXISTS tesserae_fts_au AFTER UPDATE ON tesserae BEGIN
      INSERT INTO tesserae_fts (tesserae_fts, rowid, label, snippet, path)
      VALUES ('delete', old.rowid, old.label, old.snippet, old.path);
      INSERT INTO tesserae_fts (rowid, label, snippet, path) VALUES (new.rowid, new.label, new.snippet, new.path);
    END;

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
    CREATE INDEX IF NOT EXISTS idx_memory_maintenance_proposals_status_created
      ON memory_maintenance_proposals(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_edge_task_observations_pair
      ON edge_task_observations(left_node_id, right_node_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_board_task_status_created
      ON task_board_entries(task_id, status, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_task_board_expiry
      ON task_board_entries(expires_at);
  `);
  ensureMemoryColumns(db);
  ensureHistoryColumns(db);
  ensureClaimOutcomeColumns(db);
  ensureEmbeddingTable(db);
  ensureTesseraColumns(db);
  ensureNodeColumns(db);
  ensureRelationColumns(db);
  ensureTopologyProposalColumns(db);
  ensureRetrievalTraceColumns(db);
  ensureNodeRetrievalSignalColumns(db);
  ensurePerfAggregateColumns(db);
  ensureDeltaColumns(db);
  ensureLeafSummaryColumns(db);
  ensureNodeSummaryColumns(db);
  ensureBinaryVectors(db);
  ensureTaskBoardColumns(db);
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
  ensureFtsTextFormat(db);
}

const FTS_TEXT_FORMAT_KEY = "fts_text_format";
const FTS_TEXT_FORMAT = "unicode61-han-bigram-recall-trigger-surface-trigram-v3";

/** One-time, versioned rebuild; normal store opens perform one metadata lookup. */
function ensureFtsTextFormat(db: DatabaseSync): void {
  const current = db
    .prepare("SELECT value FROM store_metadata WHERE key = ?")
    .get(FTS_TEXT_FORMAT_KEY) as Row | undefined;
  if (String(current?.value ?? "") === FTS_TEXT_FORMAT) return;

  const rows = db
    .prepare(
      `SELECT m.id, m.statement, m.markers_json, n.canonical_name, h.content,
              r.rowid AS registry_rowid
       FROM memory_records m
       JOIN memory_nodes n ON n.id = m.node_id
       JOIN history_records h ON h.id = m.evidence_id
       JOIN memory_fts_registry r ON r.memory_id = m.id
       WHERE m.storage_state = 'indexed'`,
    )
    .all() as Row[];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM memory_fts").run();
    db.prepare("DELETE FROM memory_surface_fts").run();
    const insert = db.prepare(
      "INSERT INTO memory_fts(memory_id, statement, node_name, evidence) VALUES (?, ?, ?, ?)",
    );
    const insertSurface = db.prepare(
      "INSERT INTO memory_surface_fts(rowid, content) VALUES (?, ?)",
    );
    for (const row of rows) {
      insert.run(
        String(row.id),
        ftsIndexedText(String(row.statement)),
        ftsIndexedText(String(row.canonical_name)),
        ftsIndexedText(
          `${String(row.content)} ${recallTriggersFromStoredMarkers(row.markers_json).join(" ")}`.trim(),
        ),
      );
      insertSurface.run(
        Number(row.registry_rowid),
        surfaceIndexedText(
          `${String(row.statement)} ${String(row.canonical_name)} ${String(row.content)} ${recallTriggersFromStoredMarkers(row.markers_json).join(" ")}`,
        ),
      );
    }
    db.prepare(
      `INSERT INTO store_metadata(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(FTS_TEXT_FORMAT_KEY, FTS_TEXT_FORMAT);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
    ["resolution", "TEXT NOT NULL DEFAULT 'resolved'"],
    ["opened_at", "TEXT"],
    ["related_memory_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
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
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_memory_records_session
     ON memory_records(session_id)`,
  );
}

/** Tessera drift fingerprint: adds `file_simhash` to stores created before
 *  ticket 8 (CREATE TABLE IF NOT EXISTS is a no-op against the existing table). */
export function ensureTesseraColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(tesserae)").all() as Row[]).map((row) => String(row.name)),
  );
  if (!columns.has("file_simhash")) {
    db.exec("ALTER TABLE tesserae ADD COLUMN file_simhash TEXT");
  }
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

/** Semantic block summaries: nullable LLM-written index text on leaf blocks
 *  plus a dedicated FTS index over it. The structural `summary` column stays
 *  untouched as the no-LLM fallback; `semantic_members_key` fingerprints the
 *  membership the summary was written from so stale summaries are detectable. */
export function ensureLeafSummaryColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(memory_leaf_blocks)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  if (!columns.has("semantic_summary")) {
    db.exec(`
      ALTER TABLE memory_leaf_blocks ADD COLUMN semantic_summary TEXT;
      ALTER TABLE memory_leaf_blocks ADD COLUMN semantic_summary_model TEXT;
      ALTER TABLE memory_leaf_blocks ADD COLUMN semantic_members_key TEXT;
      ALTER TABLE memory_leaf_blocks ADD COLUMN semantic_summary_at TEXT;
    `);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_leaf_fts USING fts5(
      block_id UNINDEXED,
      summary,
      tokenize = 'unicode61'
    );
  `);
}

/** Node-level semantic summaries: one LLM-written index text per node, built
 *  from the node's leaf-block summaries. `semantic_member_count` records the
 *  indexed member count at generation time — refresh is hysteresis-driven
 *  (enough new members, or aged with any change), not fingerprint-strict,
 *  because the summary is index metadata: bounded staleness costs a little
 *  recall, never correctness. */
export function ensureNodeSummaryColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(memory_nodes)").all() as Row[]).map((row) => String(row.name)),
  );
  if (!columns.has("semantic_summary")) {
    db.exec(`
      ALTER TABLE memory_nodes ADD COLUMN semantic_summary TEXT;
      ALTER TABLE memory_nodes ADD COLUMN semantic_summary_model TEXT;
      ALTER TABLE memory_nodes ADD COLUMN semantic_member_count INTEGER;
      ALTER TABLE memory_nodes ADD COLUMN semantic_summary_at TEXT;
    `);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_node_fts USING fts5(
      node_id UNINDEXED,
      summary,
      tokenize = 'unicode61'
    );
  `);
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

export function ensureClaimOutcomeColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(claim_outcome_events)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  if (!existing.has("evidence_id")) {
    db.exec(
      "ALTER TABLE claim_outcome_events ADD COLUMN evidence_id TEXT REFERENCES history_records(id) ON DELETE SET NULL",
    );
  }
  if (!existing.has("collection_origin")) {
    db.exec(
      "ALTER TABLE claim_outcome_events ADD COLUMN collection_origin TEXT NOT NULL DEFAULT 'legacy' CHECK (collection_origin IN ('controlled', 'legacy', 'natural'))",
    );
  }
}

/** Claim columns for task-board lease-based claiming (added after the fact). */
export function ensureTaskBoardColumns(db: DatabaseSync): void {
  // Legacy stores created before the opaque-id migration still carry the
  // UNIQUE(task_id, sequence) constraint (sqlite_autoindex_..._2) and the
  // sequence-based index. New writes store sequence=0 (the column is legacy),
  // so the unique constraint would reject the second entry of any channel.
  // Rebuild the table without it when detected.
  const autoindexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_board_entries' AND name LIKE 'sqlite_autoindex_%'",
    )
    .all() as Array<{ name: string }>;
  const hasLegacySequenceUnique = autoindexes.length > 1;
  if (hasLegacySequenceUnique) {
    rebuildTaskBoardEntries(db);
  }
  const existing = new Set(
    (db.prepare("PRAGMA table_info(task_board_entries)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  if (!existing.has("claimed_by")) {
    db.exec("ALTER TABLE task_board_entries ADD COLUMN claimed_by TEXT");
  }
  if (!existing.has("claimed_at")) {
    db.exec("ALTER TABLE task_board_entries ADD COLUMN claimed_at TEXT");
  }
  if (!existing.has("claim_expires_at")) {
    db.exec("ALTER TABLE task_board_entries ADD COLUMN claim_expires_at TEXT");
  }
  // Directed delivery (A2A-compatible find→direct protocol): entry.to is the
  // stable agent_name (A2A AgentCard name) that should be woken for this
  // entry. Only that agent's LLM is woken; everyone else sees it on read but
  // stays silent. NULL/absent = ordinary broadcast to subscribers. Uses the
  // stable agent name, never sessionId (session changes on reload). Column
  // name stays `to` via SQLite bracket escaping ([to]) because `to` is a
  // reserved word.
  if (!existing.has("to")) {
    db.exec("ALTER TABLE task_board_entries ADD COLUMN [to] TEXT");
  }
  // Reply-gated serial handoff state: per channel at most one outstanding
  // actionable (handoff/question/blocker, un-directed). New actionables go
  // 'pending' (read-visible, not woken) until the outstanding one is replied
  // (system auto-ack, before claim) or resolved; stale after
  // NMG_BOARD_SERIAL_TIMEOUT_MS so a never-answered handoff cannot deadlock
  // the channel. Directed entries are exempt (point-to-point, parallel-safe).
  if (!existing.has("serial_state")) {
    db.exec(
      "ALTER TABLE task_board_entries ADD COLUMN serial_state TEXT " +
        "CHECK (serial_state IN ('outstanding', 'pending', 'stale'))",
    );
  }
  // Delivery receipts: which session a wake already reached for an entry — the
  // authoritative "already notified, do not re-notify" record (replaces the
  // ephemeral notified[] array in board-wake-state.json). (session_id,
  // entry_id) is unique, so re-acking is idempotent, not an error (cf. Pub/Sub
  // exactly-once semantics).
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_board_deliveries (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'wake',
      delivered_at TEXT NOT NULL,
      UNIQUE(entry_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_board_deliveries_session
      ON task_board_deliveries(session_id, entry_id);
  `);
  // Suppression registry (do-not-send list): a session opted out of wake
  // notices for a channel. Fed by explicit unsubscribe; checked before every
  // delivery (cf. email suppression lists).
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_board_suppressions (
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      unsubscribed_at TEXT NOT NULL,
      PRIMARY KEY (session_id, task_id)
    );
    -- Acknowledgment registry: an agent records that it has seen and accepted
    -- an entry and owes no reply ("确认但不用回"). One row per (entry, agent).
    -- Idempotent like deliveries; re-acking updates the timestamp/reason.
    CREATE TABLE IF NOT EXISTS task_board_acks (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      reason TEXT,
      UNIQUE(entry_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_board_acks_entry
      ON task_board_acks(entry_id);
    -- Explicit subscription registry (channel membership): a session that has
    -- joined a named channel receives wake notices for it. Topic-based
    -- pub/sub membership — the channel wakes only its members, never
    -- non-members. The world channel is the default member channel for every
    -- session (see task_board_suppressions for opting out of it); named
    -- channels require an explicit subscribe to join.
    CREATE TABLE IF NOT EXISTS task_board_subscriptions (
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      subscribed_at TEXT NOT NULL,
      PRIMARY KEY (session_id, task_id)
    );
    -- Agent registry (A2A AgentCard local edition): stable unique id (routing)
    -- + mutable display agent_name. Industry practice (A2A AgentCard id field,
    -- Microsoft resolve-by-id): names are not unique/stable, so the registry is
    -- keyed by id; agent_name is a human-readable, runtime-renamable label.
    CREATE TABLE IF NOT EXISTS task_board_agents (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      description TEXT,
      version TEXT,
      url TEXT,
      capabilities TEXT,
      skills TEXT,
      supported_interfaces TEXT,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // v2 migration: the registry was keyed by agent_name (session fallback);
  // rebuild keyed by stable id with agent_name as display, backfilling id =
  // agent_name so existing rows survive. Run before any new-code INSERT.
  const agentColumns = db.prepare("PRAGMA table_info(task_board_agents)").all() as Row[];
  if (!agentColumns.some((row) => String(row.name) === "id")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE task_board_agents RENAME TO task_board_agents_legacy");
      db.exec(`CREATE TABLE task_board_agents (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        description TEXT,
        version TEXT,
        url TEXT,
        capabilities TEXT,
        skills TEXT,
        supported_interfaces TEXT,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.exec(`INSERT INTO task_board_agents (
          id, agent_name, description, version, url, capabilities, skills,
          supported_interfaces, last_seen_at, created_at
        ) SELECT
          agent_name, agent_name, description, version, url, capabilities, skills,
          supported_interfaces, last_seen_at, created_at
        FROM task_board_agents_legacy`);
      db.exec("DROP TABLE task_board_agents_legacy");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // ── Memory chains: static ordered-reference DAG forests over memory_records ──
  // A chain is a small, independent, internally-acyclic sequence of memory
  // references; node reuse gives cross-chain intersection (a memory may belong
  // to many chains). Time chains order by event_time (position derived from it
  // at write time); logical chains carry explicit write-time order. Chains store
  // dependencies only — inference/reasoning is the reasoner's job, not theirs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chains (
      id TEXT PRIMARY KEY,
      chain_type TEXT NOT NULL CHECK (chain_type IN ('temporal', 'logical')),
      topic TEXT NOT NULL,
      owner_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_chain_members (
      chain_id TEXT NOT NULL REFERENCES memory_chains(id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, memory_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chain_members_chain ON memory_chain_members(chain_id, position);
    CREATE INDEX IF NOT EXISTS idx_chain_members_memory ON memory_chain_members(memory_id);
    -- Directed edges of a memory chain (DAG): source → target pointers.
    -- Branching = one source with several targets; merging = several sources
    -- into one target. The DAG invariant (no cycle) is enforced at write time.
    CREATE TABLE IF NOT EXISTS memory_chain_edges (
      chain_id TEXT NOT NULL REFERENCES memory_chains(id) ON DELETE CASCADE,
      source_memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      target_memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      edge_type TEXT NOT NULL DEFAULT 'order' CHECK (edge_type IN ('order')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, source_memory_id, target_memory_id),
      CHECK (source_memory_id != target_memory_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chain_edges_chain ON memory_chain_edges(chain_id);
    CREATE INDEX IF NOT EXISTS idx_chain_edges_source ON memory_chain_edges(source_memory_id);
  `);
}

/** Rebuild `task_board_entries` without the legacy UNIQUE(task_id, sequence)
 *  constraint (old stores created before the opaque-id migration). Data is
 *  preserved; the legacy sequence column is kept with its new DEFAULT 0. */
function rebuildTaskBoardEntries(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE task_board_entries_new (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT NOT NULL,
      source_session_id TEXT,
      kind TEXT NOT NULL CHECK (
        kind IN ('blocker', 'decision', 'goal', 'handoff', 'note', 'question', 'result')
      ),
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      [to] TEXT,
      serial_state TEXT CHECK (serial_state IN ('outstanding', 'pending', 'stale'))
    );
    INSERT INTO task_board_entries_new (
      id, task_id, sequence, agent_id, source_session_id, kind, content, status,
      created_at, expires_at, resolved_at, resolved_by, resolution, claimed_by,
      claimed_at, claim_expires_at, [to], serial_state
    ) SELECT
      id, task_id, sequence, agent_id, source_session_id, kind, content, status,
      created_at, expires_at, resolved_at, resolved_by, resolution, claimed_by,
      claimed_at, claim_expires_at, [to], serial_state
    FROM task_board_entries;
    DROP TABLE task_board_entries;
    ALTER TABLE task_board_entries_new RENAME TO task_board_entries;
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_task_board_task_status_created " +
      "ON task_board_entries(task_id, status, created_at, id)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_board_expiry ON task_board_entries(expires_at)");
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
    db.exec(
      "UPDATE node_relations SET fan_budget = CASE WHEN relation_type = 'derived_from' THEN 0 ELSE 1 END",
    );
  }
  db.exec("UPDATE node_relations SET consolidated_at = created_at WHERE consolidated_at IS NULL");
}

export function ensureTopologyProposalColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(topology_proposals)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  if (!existing.has("evidence_memory_ids_json")) {
    db.exec(
      "ALTER TABLE topology_proposals ADD COLUMN evidence_memory_ids_json TEXT NOT NULL DEFAULT '[]'",
    );
  }
  const additions: Array<[string, string]> = [
    ["actuated_transform_id", "TEXT"],
    ["actuation_error", "TEXT"],
    ["actuated_at", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name))
      db.exec(`ALTER TABLE topology_proposals ADD COLUMN ${name} ${definition}`);
  }
}

export function ensureRetrievalTraceColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(retrieval_traces)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  const additions: Array<[string, string]> = [
    // session_id was added to CREATE TABLE with session isolation (P0) but
    // missing here, so pre-isolation databases never received the column.
    ["session_id", "TEXT"],
    ["disclosed_memory_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["attributed_memory_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
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
    // Pair-signal materialization marker: NULL = retrieval-pair signals for
    // this trace have not been drained into node_pair_signals /
    // edge_task_observations yet (deferred to maintenance).
    ["signals_drained_at", "TEXT"],
    // Per-query summary-routing signal (detailed tier): which nodes the
    // node-summary FTS index matched and whether they also reached the base
    // result set. Persisted from RetrievalTraceInput.nodeRouteSignal.
    ["node_route_signal_json", "TEXT NOT NULL DEFAULT '[]'"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name))
      db.exec(`ALTER TABLE retrieval_traces ADD COLUMN ${name} ${definition}`);
  }
}

/** Aggregate tier of the summary-routing signal: per-node counters of how
 *  often the node-summary FTS index matched (summary_routed_count) and of
 *  those matches, how often the node also reached the base result set
 *  (summary_recalled_count). routed − recalled per node is the IR gap — the
 *  summary index kept finding nodes the base retrieval missed. */
export function ensureNodeRetrievalSignalColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(node_retrieval_signals)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  const additions: Array<[string, string]> = [
    ["summary_routed_count", "INTEGER NOT NULL DEFAULT 0"],
    ["summary_recalled_count", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name))
      db.exec(`ALTER TABLE node_retrieval_signals ADD COLUMN ${name} ${definition}`);
  }
}
