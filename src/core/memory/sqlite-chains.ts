import type { DatabaseSync } from "node:sqlite";
import type { MemoryChainProjection } from "./backend.ts";
import type { MemoryChainType } from "../types.ts";

export function ensureSqliteMemoryChains(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nmg_memory_chains (
      namespace TEXT NOT NULL, id TEXT NOT NULL, chain_type TEXT NOT NULL,
      topic TEXT NOT NULL, owner_session_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(namespace, id)
    );
    CREATE TABLE IF NOT EXISTS nmg_memory_chain_members (
      namespace TEXT NOT NULL, chain_id TEXT NOT NULL, memory_id TEXT NOT NULL,
      position INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(namespace, chain_id, memory_id)
    );
    CREATE INDEX IF NOT EXISTS nmg_memory_chain_members_by_memory
      ON nmg_memory_chain_members(namespace, memory_id);
    CREATE TABLE IF NOT EXISTS nmg_memory_chain_edges (
      namespace TEXT NOT NULL, chain_id TEXT NOT NULL, source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL, edge_type TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(namespace, chain_id, source_memory_id, target_memory_id)
    );
    CREATE INDEX IF NOT EXISTS nmg_memory_chain_edges_by_source
      ON nmg_memory_chain_edges(namespace, source_memory_id);
  `);
}

export function importLegacySqliteChains(db: DatabaseSync, namespace: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO nmg_memory_chains
    SELECT ?, id, chain_type, topic, owner_session_id, status, created_at FROM memory_chains`,
  ).run(namespace);
  db.prepare(
    `INSERT OR IGNORE INTO nmg_memory_chain_members
    SELECT ?, chain_id, memory_id, position, note, created_at FROM memory_chain_members`,
  ).run(namespace);
  db.prepare(
    `INSERT OR IGNORE INTO nmg_memory_chain_edges
    SELECT ?, chain_id, source_memory_id, target_memory_id, edge_type, created_at
    FROM memory_chain_edges ORDER BY rowid`,
  ).run(namespace);
}

/** Chain metadata from the local database. All member IDs came from an authorized engine read. */
export function readSqliteChainProjection(
  db: DatabaseSync,
  namespace: string,
  ids: readonly string[],
  sessionId: string | undefined,
): MemoryChainProjection {
  const memberships: MemoryChainProjection["memberships"] = new Map();
  if (!ids.length) return { memberships, edges: [] };
  const idsJson = JSON.stringify(ids);
  const memberRows = db
    .prepare(
      `
    SELECT cm.memory_id, cm.chain_id, cm.position, c.chain_type, c.topic
    FROM nmg_memory_chain_members cm JOIN nmg_memory_chains c
      ON c.namespace=cm.namespace AND c.id=cm.chain_id
    WHERE cm.namespace=? AND cm.memory_id IN (SELECT value FROM json_each(?))
      AND c.status='active' AND (c.owner_session_id IS NULL OR c.owner_session_id=?)
    ORDER BY cm.memory_id, cm.chain_id, cm.position
  `,
    )
    .all(namespace, idsJson, sessionId ?? null);
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
    FROM nmg_memory_chain_edges e JOIN nmg_memory_chains c
      ON c.namespace=e.namespace AND c.id=e.chain_id
    WHERE e.namespace=? AND e.source_memory_id IN (SELECT value FROM json_each(?))
      AND e.target_memory_id IN (SELECT value FROM json_each(?))
      AND c.status='active' AND (c.owner_session_id IS NULL OR c.owner_session_id=?)
    ORDER BY e.rowid LIMIT 64
  `,
    )
    .all(namespace, idsJson, idsJson, sessionId ?? null)
    .map((row) => ({
      chainId: String(row.chain_id),
      sourceMemoryId: String(row.source_memory_id),
      targetMemoryId: String(row.target_memory_id),
      edgeType: "order" as const,
    }));
  return { memberships, edges };
}
