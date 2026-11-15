import { DatabaseSync } from "node:sqlite";
import { MAX_MEMORY_COMMIT_ENTITIES, type MemoryEntity } from "../memory/backend.ts";
import {
  mapHistory,
  mapMemoryRow,
  mapMemoryWriteEvent,
  mapNode,
  mapRelation,
  parseScope,
} from "./rows.ts";
import type { StoreRow } from "./search-ranking.ts";
import { stateAliasId } from "../memory/model.ts";
import type { TesseraRecord } from "../types.ts";

/** Read a consistent graph from a current legacy schema without changing the source. */
export function readLegacyMemorySnapshot(
  path: string,
  options: { fullSqlite?: boolean } = {},
): MemoryEntity[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; BEGIN");
    if (db.prepare("SELECT 1 FROM memory_records WHERE storage_state <> 'indexed' LIMIT 1").get())
      throw new Error("Legacy snapshot contains dormant or quarantined memories");
    if (db.prepare("SELECT 1 FROM node_redirects LIMIT 1").get())
      throw new Error("Legacy snapshot contains node redirects");
    const limit = options.fullSqlite ? -1 : MAX_MEMORY_COMMIT_ENTITIES + 1;
    const histories = db.prepare("SELECT * FROM history_records ORDER BY id LIMIT ?").all(limit);
    const nodes = db.prepare("SELECT * FROM memory_nodes ORDER BY id LIMIT ?").all(limit);
    const memories = db.prepare("SELECT * FROM memory_records ORDER BY id LIMIT ?").all(limit);
    const edges = db.prepare("SELECT * FROM node_relations ORDER BY id LIMIT ?").all(limit);
    const aliases = db
      .prepare("SELECT * FROM state_key_aliases ORDER BY alias_key, scope_json LIMIT ?")
      .all(limit);
    const audit = options.fullSqlite
      ? db.prepare("SELECT * FROM memory_write_events ORDER BY id").all()
      : [];
    const tesserae = options.fullSqlite
      ? db.prepare("SELECT * FROM tesserae ORDER BY id").all()
      : [];
    if (
      !options.fullSqlite &&
      histories.length + nodes.length + memories.length + edges.length + aliases.length >
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
      ...audit.map((row): MemoryEntity => ({
        kind: "writeEvent",
        value: mapMemoryWriteEvent(row as StoreRow),
      })),
      ...tesserae.map((row): MemoryEntity => ({
        kind: "tessera",
        value: mapLegacyTessera(row as StoreRow),
      })),
      ...aliases.map((row): MemoryEntity => {
        const aliasKey = String(row.alias_key);
        const scope = parseScope(String(row.scope_json));
        return {
          kind: "stateAlias",
          value: {
            id: stateAliasId(aliasKey, scope),
            aliasKey,
            scope,
            canonicalKey: String(row.canonical_key),
            createdAt: String(row.created_at),
          },
        };
      }),
    ];
  } finally {
    db.close();
  }
}

function mapLegacyTessera(row: StoreRow): TesseraRecord {
  return {
    id: String(row.id),
    path: String(row.path),
    snippet: String(row.snippet),
    label: String(row.label),
    createdAt: String(row.created_at),
    ...(row.kind === null ? {} : { kind: String(row.kind) }),
    ...(row.memory_id === null ? {} : { memoryId: String(row.memory_id) }),
    ...(row.file_simhash === null ? {} : { fileSimhash: String(row.file_simhash) }),
  };
}
