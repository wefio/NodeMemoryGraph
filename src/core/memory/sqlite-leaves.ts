import type { DatabaseSync } from "node:sqlite";
import type { HistoryRecord } from "../types.ts";
import type { MemoryEntity, MemoryEntityQuery, SourceNeighbor } from "./backend.ts";
import { queryBounds } from "./entity-rows.ts";
import {
  MEMORY_SELECT_COLUMNS,
  buildMemoryQueryFilter,
  hydrateMemoriesFromRows,
} from "./sqlite-relational.ts";

/** Publish the leaf membership table and retire obsolete route vectors together. */
export function ensureSqliteLeafGroups(db: DatabaseSync): void {
  const names = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN
    ('nmg_memory_route_members', 'nmg_memory_route_vectors', 'nmg_memory_leaf_members',
     'nmg_memory_leaf_members_by_leaf')`);
  const readNames = () => new Set(names.all().map(({ name }) => name));
  const needsMigration = (schema: ReturnType<typeof readNames>) =>
    schema.size !== 2 ||
    schema.has("nmg_memory_route_members") ||
    schema.has("nmg_memory_route_vectors");
  if (!needsMigration(readNames())) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const schema = readNames();
    db.exec(`CREATE TABLE IF NOT EXISTS nmg_memory_leaf_members (
      namespace TEXT NOT NULL, memory_id TEXT NOT NULL, leaf_id TEXT NOT NULL, ordinal INTEGER,
      PRIMARY KEY(namespace, memory_id, leaf_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS nmg_memory_leaf_members_by_leaf
        ON nmg_memory_leaf_members(namespace, leaf_id, ordinal, memory_id);`);
    if (schema.has("nmg_memory_route_members")) {
      db.exec(`INSERT OR IGNORE INTO nmg_memory_leaf_members(namespace, memory_id, leaf_id)
        SELECT namespace, memory_id, leaf_id FROM nmg_memory_route_members;
        DROP TABLE nmg_memory_route_members;`);
    }
    db.exec("DROP TABLE IF EXISTS nmg_memory_route_vectors; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function importLegacySqliteLeaves(db: DatabaseSync, namespace: string): void {
  db.prepare(
    `INSERT INTO nmg_memory_leaf_members
    SELECT ?, memory_id, block_id, ordinal FROM memory_leaf_members WHERE true
    ON CONFLICT(namespace, memory_id, leaf_id) DO UPDATE
      SET ordinal=COALESCE(nmg_memory_leaf_members.ordinal, excluded.ordinal)`,
  ).run(namespace);
}

/** Imported groups and records from the same source turn both work without a model. */
export function readSqliteLeafPeers(
  db: DatabaseSync,
  namespace: string,
  seedIds: readonly string[],
  excluded: readonly string[],
  query: MemoryEntityQuery,
): MemoryEntity[] {
  const { limit } = queryBounds(query);
  const filter = buildMemoryQueryFilter(namespace, query, "m");
  const rows = db
    .prepare(
      `WITH seeds AS MATERIALIZED (
    SELECT m.namespace, m.id, m.scope AS leaf_scope, CAST(j.key AS INTEGER) AS seed_order,
      m.primary_evidence_id AS evidence_id
    FROM json_each(?) j CROSS JOIN nmg_memories m
      ON m.namespace=? AND m.id=j.value
  ), matches AS (
    SELECT peer.memory_id AS peer_id, s.leaf_scope, s.seed_order, peer.ordinal
    FROM seeds s CROSS JOIN nmg_memory_leaf_members member
      ON member.namespace=s.namespace AND member.memory_id=s.id
    CROSS JOIN nmg_memory_leaf_members peer
      ON peer.namespace=member.namespace AND peer.leaf_id=member.leaf_id
    UNION ALL
    SELECT m.id, s.leaf_scope, s.seed_order, NULL
    FROM seeds s CROSS JOIN nmg_memories m INDEXED BY nmg_memories_by_primary_evidence
      ON m.namespace=s.namespace AND m.primary_evidence_id=s.evidence_id
    WHERE s.evidence_id <> ''
  ), peers AS (
    SELECT peer_id, leaf_scope, min(seed_order) AS seed_order, min(ordinal) AS ordinal
    FROM matches GROUP BY peer_id, leaf_scope
  )
  SELECT ${MEMORY_SELECT_COLUMNS}
  FROM peers p CROSS JOIN nmg_memories m
    ON m.namespace=? AND m.id=p.peer_id AND m.scope=p.leaf_scope
  WHERE ${filter.sql} AND m.id NOT IN (SELECT value FROM json_each(?))
  ORDER BY p.seed_order, p.ordinal NULLS LAST, m.created_at, m.id LIMIT ?`,
    )
    .all(
      JSON.stringify(seedIds),
      namespace,
      namespace,
      ...filter.bind,
      JSON.stringify(excluded),
      limit,
    ) as Array<Record<string, unknown>>;
  if (!rows.length) return [];
  return hydrateMemoriesFromRows(db, namespace, rows).memories.map((value) => ({
    kind: "memory",
    value,
  }));
}

/** Follow a source ordinal when numeric, or row insertion order within the session otherwise. */
export function readSqliteAdjacentSources(
  db: DatabaseSync,
  namespace: string,
  source: HistoryRecord,
  query: MemoryEntityQuery,
): SourceNeighbor[] {
  const { sessionId, sourceMessageId } = source;
  if (!sessionId) return [];
  const { limit } = queryBounds(query);
  const filter = buildMemoryQueryFilter(namespace, query, "m");

  let rows: Array<Record<string, unknown>>;
  if (sourceMessageId && /^(?:0|[1-9][0-9]*)$/u.test(sourceMessageId)) {
    const ordinal = Number(sourceMessageId);
    if (!Number.isSafeInteger(ordinal + 1)) return [];
    rows = db
      .prepare(
        `WITH wanted(ordinal, relation) AS (VALUES (?, 'previous_turn'), (?, 'next_turn')),
      neighbors AS (
        SELECT ${MEMORY_SELECT_COLUMNS}, w.relation FROM wanted w
        CROSS JOIN nmg_sources h INDEXED BY nmg_sources_by_session_msg
          ON h.namespace=? AND h.session_id=? AND h.source_message_id=w.ordinal
        CROSS JOIN nmg_memories m INDEXED BY nmg_memories_by_primary_evidence
          ON m.namespace=h.namespace AND m.primary_evidence_id=h.id
        WHERE ${filter.sql}
      )
      SELECT * FROM neighbors
      ORDER BY relation DESC, id LIMIT ?`,
      )
      .all(
        String(ordinal - 1),
        String(ordinal + 1),
        namespace,
        sessionId,
        ...filter.bind,
        limit,
      ) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare(
        `WITH anchor(rowid) AS (
          SELECT rowid FROM nmg_sources WHERE namespace=? AND id=?
        ),
        wanted(id, relation) AS (
          SELECT id, 'previous_turn' FROM (
            SELECT h.id FROM anchor a
            CROSS JOIN nmg_sources h INDEXED BY nmg_sources_by_session
              ON h.namespace=? AND h.session_id=? AND h.rowid < a.rowid
            ORDER BY h.rowid DESC LIMIT 1
          )
          UNION ALL
          SELECT id, 'next_turn' FROM (
            SELECT h.id FROM anchor a
            CROSS JOIN nmg_sources h INDEXED BY nmg_sources_by_session
              ON h.namespace=? AND h.session_id=? AND h.rowid > a.rowid
            ORDER BY h.rowid ASC LIMIT 1
          )
        ),
        neighbors AS (
          SELECT ${MEMORY_SELECT_COLUMNS}, w.relation FROM wanted w
          CROSS JOIN nmg_memories m INDEXED BY nmg_memories_by_primary_evidence
            ON m.namespace=? AND m.primary_evidence_id=w.id
          WHERE ${filter.sql}
        )
        SELECT * FROM neighbors
        ORDER BY relation DESC, id LIMIT ?`,
      )
      .all(
        namespace,
        source.id,
        namespace,
        sessionId,
        namespace,
        sessionId,
        namespace,
        ...filter.bind,
        limit,
      ) as Array<Record<string, unknown>>;
  }

  if (!rows.length) return [];
  const { memories } = hydrateMemoriesFromRows(db, namespace, rows);
  return memories.map((value, idx) => ({
    entity: { kind: "memory", value },
    relation: rows[idx]!.relation === "previous_turn" ? "previous_turn" : "next_turn",
  }));
}
