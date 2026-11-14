import { DatabaseSync } from "node:sqlite";
import { MAX_MEMORY_COMMIT_ENTITIES, type MemoryEntity } from "../memory/backend.ts";
import { mapHistory, mapMemoryRow, mapNode, mapRelation } from "./rows.ts";
import type { StoreRow } from "./search-ranking.ts";

/** Read a bounded, consistent graph from a current legacy schema without running migrations. */
export function readLegacyMemorySnapshot(path: string): MemoryEntity[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; BEGIN");
    if (db.prepare("SELECT 1 FROM memory_records WHERE storage_state <> 'indexed' LIMIT 1").get())
      throw new Error("Legacy snapshot contains dormant or quarantined memories");
    if (db.prepare("SELECT 1 FROM node_redirects LIMIT 1").get())
      throw new Error("Legacy snapshot contains node redirects");
    const limit = MAX_MEMORY_COMMIT_ENTITIES + 1;
    const histories = db.prepare("SELECT * FROM history_records ORDER BY id LIMIT ?").all(limit);
    const nodes = db.prepare("SELECT * FROM memory_nodes ORDER BY id LIMIT ?").all(limit);
    const memories = db.prepare("SELECT * FROM memory_records ORDER BY id LIMIT ?").all(limit);
    const edges = db.prepare("SELECT * FROM node_relations ORDER BY id LIMIT ?").all(limit);
    if (
      histories.length + nodes.length + memories.length + edges.length >
      MAX_MEMORY_COMMIT_ENTITIES
    )
      throw new Error(`Legacy snapshot exceeds ${MAX_MEMORY_COMMIT_ENTITIES} entities`);
    const evidence = db.prepare(
      "SELECT history_id FROM memory_evidence_links WHERE memory_id = ? ORDER BY history_id",
    );
    return [
      ...histories.map((row): MemoryEntity => ({
        kind: "history",
        value: mapHistory(row as StoreRow),
      })),
      ...nodes.map((row): MemoryEntity => ({ kind: "node", value: mapNode(row as StoreRow) })),
      ...memories.map((row): MemoryEntity => {
        const value = mapMemoryRow(row as StoreRow);
        const linked = evidence.all(value.id).map((link) => String(link.history_id));
        value.evidenceIds = [...new Set([value.evidenceId, ...linked])];
        return { kind: "memory", value };
      }),
      ...edges.map((row): MemoryEntity => ({ kind: "edge", value: mapRelation(row as StoreRow) })),
    ];
  } finally {
    db.close();
  }
}
