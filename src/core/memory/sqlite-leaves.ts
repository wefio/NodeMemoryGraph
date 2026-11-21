import type { DatabaseSync } from "node:sqlite";
import type { HistoryRecord } from "../types.ts";
import type { MemoryEntity, MemoryEntityQuery, SourceNeighbor } from "./backend.ts";
import { queryBounds, sqliteQueryWhere } from "./entity-rows.ts";

const PRIMARY_EVIDENCE = "json_extract(payload, '$.evidenceId')";

/** Publish the structural layout and retire the derived route vectors together. */
export function ensureSqliteLeafGroups(db: DatabaseSync): void {
  const names = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN
    ('nmg_memory_route_members', 'nmg_memory_route_vectors', 'nmg_memory_leaf_members',
     'nmg_memory_leaf_members_by_leaf', 'nmg_memory_leaf_evidence')`);
  const readNames = () => new Set(names.all().map(({ name }) => name));
  const needsMigration = (schema: ReturnType<typeof readNames>) =>
    schema.size !== 3 ||
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
        ON nmg_memory_leaf_members(namespace, leaf_id, ordinal, memory_id);
      CREATE INDEX IF NOT EXISTS nmg_memory_leaf_evidence
        ON nmg_memory_entities(namespace, ${PRIMARY_EVIDENCE}, id) WHERE kind='memory';`);
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
  const rows = db
    .prepare(
      `WITH seeds AS MATERIALIZED (
    SELECT m.namespace, m.id, m.scope AS leaf_scope, CAST(j.key AS INTEGER) AS seed_order,
      ${PRIMARY_EVIDENCE} AS evidence_id
    FROM json_each(?) j CROSS JOIN nmg_memory_entities m
      ON m.namespace=? AND m.key='memory:'||j.value
  ), matches AS (
    SELECT peer.memory_id AS peer_id, s.leaf_scope, s.seed_order, peer.ordinal
    FROM seeds s CROSS JOIN nmg_memory_leaf_members member
      ON member.namespace=s.namespace AND member.memory_id=s.id
    CROSS JOIN nmg_memory_leaf_members peer
      ON peer.namespace=member.namespace AND peer.leaf_id=member.leaf_id
    UNION ALL
    SELECT m.id, s.leaf_scope, s.seed_order, NULL FROM seeds s CROSS JOIN nmg_memory_entities m
      ON m.namespace=s.namespace AND m.kind='memory' AND ${PRIMARY_EVIDENCE}=s.evidence_id
    WHERE s.evidence_id <> ''
  ), peers AS (
    SELECT peer_id, leaf_scope, min(seed_order) AS seed_order, min(ordinal) AS ordinal
    FROM matches GROUP BY peer_id, leaf_scope
  )
  SELECT m.payload FROM peers p CROSS JOIN nmg_memory_entities m
    ON m.namespace=? AND m.key='memory:'||p.peer_id AND m.scope=p.leaf_scope
  WHERE ${sqliteQueryWhere(query)} AND m.id NOT IN (SELECT value FROM json_each(?))
  ORDER BY p.seed_order, p.ordinal NULLS LAST, json_extract(m.payload,'$.createdAt'), m.id LIMIT ?`,
    )
    .all(JSON.stringify(seedIds), namespace, namespace, JSON.stringify(excluded), limit);
  return rows.map(({ payload }) => ({ kind: "memory", value: JSON.parse(String(payload)) }));
}

/** Follow an ordinal supplied by the source, using the history and evidence indexes. */
export function readSqliteAdjacentSources(
  db: DatabaseSync,
  namespace: string,
  source: HistoryRecord,
  query: MemoryEntityQuery,
): SourceNeighbor[] {
  const { sessionId, sourceMessageId } = source;
  if (!sessionId || !sourceMessageId || !/^(?:0|[1-9][0-9]*)$/u.test(sourceMessageId)) return [];
  const ordinal = Number(sourceMessageId);
  if (!Number.isSafeInteger(ordinal + 1)) return [];
  const { limit } = queryBounds(query);
  // Unary + drops h.id's TEXT affinity so SQLite can seek the JSON expression index.
  return db
    .prepare(
      `WITH wanted(ordinal, relation) AS (VALUES (?, 'previous_turn'), (?, 'next_turn')),
      neighbors AS (
        SELECT m.*, w.relation FROM wanted w
        CROSS JOIN nmg_memory_entities h INDEXED BY nmg_memory_history_source
          ON h.namespace=? AND h.kind='history'
          AND coalesce(nullif(h.name, ''), json_extract(h.payload, '$.sourceMessageId'))=w.ordinal
          AND json_extract(h.payload, '$.sessionId')=?
        CROSS JOIN nmg_memory_entities m INDEXED BY nmg_memory_leaf_evidence
          ON m.namespace=h.namespace AND m.kind='memory'
          AND json_extract(m.payload, '$.evidenceId')=+h.id
      )
      SELECT payload, relation FROM neighbors WHERE ${sqliteQueryWhere(query)}
      ORDER BY relation DESC, id LIMIT ?`,
    )
    .all(String(ordinal - 1), String(ordinal + 1), namespace, sessionId, limit)
    .map(({ payload, relation }) => ({
      entity: { kind: "memory", value: JSON.parse(String(payload)) },
      relation: relation === "previous_turn" ? "previous_turn" : "next_turn",
    }));
}
