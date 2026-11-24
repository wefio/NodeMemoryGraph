import type { DatabaseSync } from "node:sqlite";

/** Expose the selected namespace to the local read-only inspector directly from relational tables. */
export function useUnifiedInspectViews(db: DatabaseSync): boolean {
  if (
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='nmg_local_memory'").get()
  )
    return false;
  const nsSubquery = "(SELECT namespace FROM nmg_local_memory WHERE id=1)";
  db.exec(`CREATE TEMP VIEW memory_records AS
    SELECT id, node_id, statement, memory_type, tier, importance, status,
      created_at, source_actor, truth_status, residence, scope AS scope_json,
      evidence_role, access_count, NULLIF(last_accessed_at, '') AS last_accessed_at,
      NULLIF(expires_at, '') AS expires_at, NULLIF(supersedes_id, '') AS supersedes_id,
      NULLIF(storage_state, '') AS storage_state
    FROM nmg_memories
    WHERE namespace=${nsSubquery}`);
  db.exec(`CREATE TEMP VIEW memory_nodes AS
    SELECT id, canonical_name, kind, status, residence, summary
    FROM nmg_nodes
    WHERE namespace=${nsSubquery}`);
  db.exec(`CREATE TEMP VIEW history_records AS
    SELECT id, role, content, created_at
    FROM nmg_sources
    WHERE namespace=${nsSubquery}`);
  db.exec(`CREATE TEMP VIEW node_relations AS
    SELECT id, source_id AS source_node_id, target_id AS target_node_id,
      relation_type, weight AS strength, direction, status
    FROM nmg_memory_relations
    WHERE namespace=${nsSubquery} AND origin='node_edge'`);
  db.exec(`CREATE TEMP VIEW memory_evidence_links AS
    SELECT memory_id, source_id AS history_id
    FROM nmg_memory_evidence
    WHERE namespace=${nsSubquery}`);
  if (
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='nmg_memory_associations'")
      .get()
  )
    db.exec(`CREATE TEMP VIEW node_pair_signals AS
      SELECT left_node_id, right_node_id, co_retrieval_count, useful_count FROM nmg_memory_associations
      WHERE namespace=${nsSubquery}`);
  return true;
}
