import type { DatabaseSync } from "node:sqlite";

const memoryFields = {
  node_id: "nodeId",
  statement: "statement",
  memory_type: "memoryType",
  tier: "tier",
  importance: "importance",
  status: "status",
  created_at: "createdAt",
  source_actor: "sourceActor",
  truth_status: "truthStatus",
  residence: "residence",
  scope_json: "scope",
  evidence_role: "evidenceRole",
  access_count: "accessCount",
  last_accessed_at: "lastAccessedAt",
  expires_at: "expiresAt",
  supersedes_id: "supersedesId",
  storage_state: "storageState",
};

/** Expose the selected namespace to the local read-only inspector and graph queries. */
export function useUnifiedInspectViews(db: DatabaseSync): boolean {
  if (
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='nmg_local_memory'").get()
  )
    return false;
  view(db, "memory_records", "memory", memoryFields);
  view(db, "memory_nodes", "node", {
    canonical_name: "canonicalName",
    kind: "kind",
    status: "status",
    residence: "residence",
    summary: "summary",
  });
  view(db, "history_records", "history", {
    role: "role",
    content: "content",
    created_at: "createdAt",
  });
  view(db, "node_relations", "edge", {
    source_node_id: "sourceNodeId",
    target_node_id: "targetNodeId",
    relation_type: "type",
    strength: "strength",
    direction: "direction",
    status: "status",
  });
  db.exec(`CREATE TEMP VIEW memory_evidence_links AS
    SELECT record.id AS memory_id, evidence.value AS history_id
    FROM nmg_memory_entities record JOIN json_each(record.payload, '$.evidenceIds') evidence
    WHERE record.kind='memory' AND record.namespace=(SELECT namespace FROM nmg_local_memory WHERE id=1)`);
  return true;
}

function view(db: DatabaseSync, name: string, kind: string, fields: Record<string, string>) {
  const columns = Object.entries(fields).map(
    ([column, field]) => `json_extract(payload, '$.${field}') AS ${column}`,
  );
  db.exec(`CREATE TEMP VIEW ${name} AS SELECT id, ${columns.join(", ")}
    FROM nmg_memory_entities WHERE kind='${kind}'
      AND namespace=(SELECT namespace FROM nmg_local_memory WHERE id=1)`);
}
