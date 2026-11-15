import type { DatabaseSync } from "node:sqlite";
import type { MemoryChainProjection } from "./backend.ts";
import type { MemoryChainType } from "../types.ts";

/** Chain metadata from the local database. All member IDs came from an authorized engine read. */
export function readSqliteChainProjection(
  db: DatabaseSync,
  ids: readonly string[],
  sessionId: string | undefined,
): MemoryChainProjection {
  const memberships: MemoryChainProjection["memberships"] = new Map();
  if (
    !ids.length ||
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='nmg_local_memory'").get()
  )
    return { memberships, edges: [] };
  const idsJson = JSON.stringify(ids);
  const memberRows = db
    .prepare(
      `
    SELECT cm.memory_id, cm.chain_id, cm.position, c.chain_type, c.topic
    FROM memory_chain_members cm JOIN memory_chains c ON c.id=cm.chain_id
    WHERE cm.memory_id IN (SELECT value FROM json_each(?))
      AND c.status='active' AND (c.owner_session_id IS NULL OR c.owner_session_id=?)
    ORDER BY cm.memory_id, cm.chain_id, cm.position
  `,
    )
    .all(idsJson, sessionId ?? null);
  for (const row of memberRows) {
    const id = String(row.memory_id);
    const list = memberships.get(id) ?? [];
    list.push({
      chainId: String(row.chain_id),
      position: Number(row.position),
      chainType: String(row.chain_type) as MemoryChainType,
      topic: String(row.topic),
    });
    memberships.set(id, list);
  }
  const edges = db
    .prepare(
      `
    SELECT e.chain_id, e.source_memory_id, e.target_memory_id
    FROM memory_chain_edges e JOIN memory_chains c ON c.id=e.chain_id
    WHERE e.source_memory_id IN (SELECT value FROM json_each(?))
      AND e.target_memory_id IN (SELECT value FROM json_each(?))
      AND c.status='active' AND (c.owner_session_id IS NULL OR c.owner_session_id=?)
    ORDER BY e.rowid LIMIT 64
  `,
    )
    .all(idsJson, idsJson, sessionId ?? null)
    .map((row) => ({
      chainId: String(row.chain_id),
      sourceMemoryId: String(row.source_memory_id),
      targetMemoryId: String(row.target_memory_id),
      edgeType: "order" as const,
    }));
  return { memberships, edges };
}
