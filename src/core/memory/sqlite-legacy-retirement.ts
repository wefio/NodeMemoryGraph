import type { DatabaseSync } from "node:sqlite";

const LEGACY_MEMORY_TABLES = [
  "anchors",
  "anchors_fts",
  "memory_chain_edges",
  "memory_chain_members",
  "memory_chains",
  "memory_write_events",
  "memory_resolution_events",
  "memory_evidence_links",
  "memory_derivations",
  "claim_outcome_events",
  "claim_posteriors",
  "node_redirects",
  "node_transform_journals",
  "node_transforms",
  "session_archives",
  "state_key_aliases",
  "edge_activation_signals",
  "node_activation_signals",
  "edge_task_observations",
  "node_pair_signals",
  "node_retrieval_signals",
  "consolidation_events",
  "topology_proposals",
  "memory_maintenance_proposals",
  "maintenance_runs",
  "router_weights",
  "memory_embeddings",
  "node_embeddings",
  "leaf_embeddings",
  "memory_leaf_members",
  "memory_leaf_blocks",
  "leaf_block_status",
  "memory_index_delta",
  "embedding_index_state",
  "memory_fts_registry",
  "tesserae",
  "memory_records",
  "node_relations",
  "memory_nodes",
  "history_records",
  "store_metadata",
  "memory_fts",
  "memory_surface_fts",
  "memory_leaf_fts",
  "memory_node_fts",
  "tesserae_fts",
] as const;

export function hasLegacyMemoryTables(db: DatabaseSync): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM sqlite_schema WHERE type='table' AND
    name IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .get(JSON.stringify(LEGACY_MEMORY_TABLES));
}

export function ensureSqliteMemoryAssociations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS nmg_memory_associations (
    namespace TEXT NOT NULL, left_node_id TEXT NOT NULL, right_node_id TEXT NOT NULL,
    co_retrieval_count INTEGER NOT NULL, useful_count INTEGER NOT NULL,
    PRIMARY KEY(namespace, left_node_id, right_node_id));`);
}

export function importLegacySqliteAssociations(db: DatabaseSync, namespace: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO nmg_memory_associations
    SELECT ?, left_node_id, right_node_id, co_retrieval_count, useful_count FROM node_pair_signals`,
  ).run(namespace);
}

/** Called within the engine's publication transaction after the legacy backup and imports. */
export function retireLegacyMemoryTables(db: DatabaseSync): void {
  assertNoRetainedForeignKeys(db);
  db.exec("PRAGMA defer_foreign_keys=ON");
  for (const table of LEGACY_MEMORY_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  const broken = db.prepare("PRAGMA foreign_key_check").get();
  if (broken)
    throw new Error(`Retiring legacy memory leaves a broken foreign key in ${broken.table}`);
}

function assertNoRetainedForeignKeys(db: DatabaseSync): void {
  const tables = JSON.stringify(LEGACY_MEMORY_TABLES);
  const reference = db
    .prepare(
      `WITH retired AS (SELECT value FROM json_each(?))
     SELECT s.name AS source, f.[table] AS target
     FROM sqlite_schema s JOIN pragma_foreign_key_list(s.name) f
     WHERE s.type='table' AND lower(s.name) NOT IN (SELECT value FROM retired)
       AND lower(f.[table]) IN (SELECT value FROM retired)
     LIMIT 1`,
    )
    .get(tables);
  if (reference)
    throw new Error(
      `Cannot retire legacy table ${reference.target}: referenced by ${reference.source}`,
    );
}
