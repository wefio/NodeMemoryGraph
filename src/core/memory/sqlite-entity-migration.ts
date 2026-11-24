import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntity } from "./backend.ts";
import {
  RELATIONAL_SCHEMA_VERSION,
  ensureRelationalTables,
  upgradeTransitionalRelationalTables,
} from "./sqlite-schema.ts";
import {
  createRelationalWriters,
  writeReceiptRow,
  writeRelationalEntity,
  writeSourceRow,
} from "./sqlite-relational-writes.ts";

interface MigrationSummary {
  readonly schemaVersion: number;
  readonly entityCount: number;
  readonly countsByKind: Record<string, number>;
  readonly recoveredMissingSources: number;
  readonly retiredEntityTable: boolean;
}

/** Return true when the legacy `nmg_memory_entities` JSON-blob table is still present. */
export function hasUnmigratedEntityTable(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='nmg_memory_entities'")
      .get(),
  );
}

function isVersionMigrated(db: DatabaseSync, namespace: string, version: number): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM nmg_schema_migrations WHERE namespace=? AND version=?")
      .get(namespace, version),
  );
}

function collectMissingSourceIds(entities: readonly MemoryEntity[]): Map<string, string> {
  const existingHistoryIds = new Set<string>();
  const missing = new Map<string, string>();
  for (const entity of entities) {
    if (entity.kind === "history") existingHistoryIds.add(entity.value.id);
  }
  for (const entity of entities) {
    if (entity.kind !== "memory") continue;
    const refs = entity.value.evidenceIds.length
      ? entity.value.evidenceIds
      : entity.value.evidenceId
        ? [entity.value.evidenceId]
        : [];
    for (const sourceId of refs) {
      if (sourceId && !existingHistoryIds.has(sourceId) && !missing.has(sourceId)) {
        missing.set(sourceId, entity.value.createdAt);
      }
    }
  }
  return missing;
}

const EXACT_COUNT_VERIFICATIONS: ReadonlyArray<readonly [string, string]> = [
  ["memory", "SELECT count(*) AS n FROM nmg_memories WHERE namespace=?"],
  ["node", "SELECT count(*) AS n FROM nmg_nodes WHERE namespace=?"],
  [
    "edge",
    "SELECT count(*) AS n FROM nmg_memory_relations WHERE namespace=? AND origin='node_edge'",
  ],
  ["tessera", "SELECT count(*) AS n FROM nmg_tesserae WHERE namespace=?"],
  ["stateAlias", "SELECT count(*) AS n FROM nmg_state_aliases WHERE namespace=?"],
  ["writeEvent", "SELECT count(*) AS n FROM nmg_write_events WHERE namespace=?"],
  ["receipt", "SELECT count(*) AS n FROM nmg_receipts WHERE namespace=?"],
  ["relationProposal", "SELECT count(*) AS n FROM nmg_relation_proposals WHERE namespace=?"],
  ["claimPosterior", "SELECT count(*) AS n FROM nmg_claim_posteriors WHERE namespace=?"],
  ["claimOutcome", "SELECT count(*) AS n FROM nmg_claim_outcomes WHERE namespace=?"],
  ["resolutionEvent", "SELECT count(*) AS n FROM nmg_resolution_events WHERE namespace=?"],
];

function verifyNamespaceMigrationCounts(
  db: DatabaseSync,
  namespace: string,
  expected: ReadonlyMap<string, number>,
  recoveredMissingSources: number,
): void {
  const countOf = (sql: string): number => Number(db.prepare(sql).get(namespace)?.n ?? 0);
  for (const [kind, sql] of EXACT_COUNT_VERIFICATIONS) {
    const actual = countOf(sql);
    const target = expected.get(kind) ?? 0;
    if (actual !== target) {
      throw new Error(
        `Migration count mismatch for ${namespace} (${kind}): expected ${target}, got ${actual}`,
      );
    }
  }
  const actualMemRels = countOf(
    "SELECT count(*) AS n FROM nmg_memory_relations WHERE namespace=? AND origin <> 'node_edge'",
  );
  const expectedMemRels = expected.get("memoryRelation") ?? 0;
  if (actualMemRels < expectedMemRels) {
    throw new Error(
      `Migration count mismatch for ${namespace} (memoryRelation): expected >= ${expectedMemRels}, got ${actualMemRels}`,
    );
  }
  const actualSources = countOf("SELECT count(*) AS n FROM nmg_sources WHERE namespace=?");
  const minSources = (expected.get("history") ?? 0) + recoveredMissingSources;
  if (actualSources < minSources) {
    throw new Error(
      `Migration count mismatch for ${namespace} (history): expected >= ${minSources}, got ${actualSources}`,
    );
  }
}

function migrateNamespaceFromEntities(db: DatabaseSync, namespace: string): MigrationSummary {
  const rows = db
    .prepare("SELECT kind, payload FROM nmg_memory_entities WHERE namespace=? ORDER BY rowid")
    .all(namespace) as Array<{ kind: string; payload: string }>;

  const counts = new Map<string, number>();
  const entities: MemoryEntity[] = [];
  const w = createRelationalWriters(db);

  for (const row of rows) {
    const kind = String(row.kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const parsed = JSON.parse(String(row.payload));
    if (kind === "receipt") {
      writeReceiptRow(w.upsertReceipt, namespace, parsed);
    } else {
      entities.push({ kind: kind as MemoryEntity["kind"], value: parsed });
    }
  }

  for (const entity of entities) {
    writeRelationalEntity(w, namespace, entity);
  }

  const missingSources = collectMissingSourceIds(entities);
  for (const [id, createdAt] of missingSources) {
    const exists = db
      .prepare("SELECT 1 FROM nmg_sources WHERE namespace=? AND id=?")
      .get(namespace, id);
    if (!exists) {
      writeSourceRow(
        w.upsertSource,
        namespace,
        {
          id,
          sessionId: null,
          sourceMessageId: null,
          role: "explicit",
          content: "",
          sourceRef: null,
          createdAt,
        },
        "missing_recovered",
      );
    }
  }

  verifyNamespaceMigrationCounts(db, namespace, counts, missingSources.size);
  return {
    schemaVersion: RELATIONAL_SCHEMA_VERSION,
    entityCount: rows.length,
    countsByKind: Object.fromEntries(counts),
    recoveredMissingSources: missingSources.size,
    retiredEntityTable: false,
  };
}

function recordMigration(db: DatabaseSync, namespace: string, summary: MigrationSummary): void {
  db.prepare(
    "INSERT OR REPLACE INTO nmg_schema_migrations (namespace, version, migrated_at, summary_json) VALUES (?, ?, ?, ?)",
  ).run(namespace, RELATIONAL_SCHEMA_VERSION, new Date().toISOString(), JSON.stringify(summary));
}

function dropLegacyEntityTableIfPresent(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX IF EXISTS nmg_memory_kind;
    DROP INDEX IF EXISTS nmg_memory_node;
    DROP INDEX IF EXISTS nmg_memory_node_name;
    DROP INDEX IF EXISTS nmg_memory_history_source;
    DROP INDEX IF EXISTS nmg_memory_scope_node;
    DROP INDEX IF EXISTS nmg_memory_scope_name;
    DROP INDEX IF EXISTS nmg_memory_user_profile;
    DROP INDEX IF EXISTS nmg_memory_state;
    DROP INDEX IF EXISTS nmg_memory_event_time;
    DROP INDEX IF EXISTS nmg_memory_edge_source;
    DROP INDEX IF EXISTS nmg_memory_edge_target;
    DROP INDEX IF EXISTS nmg_memory_leaf_evidence;
    DROP INDEX IF EXISTS nmg_memory_history_session;
    DROP INDEX IF EXISTS nmg_memory_embedding_order;
    DROP INDEX IF EXISTS nmg_memory_history_sequence;
    DROP TABLE IF EXISTS nmg_memory_entities;
    DROP TABLE IF EXISTS nmg_relational_backfill;
  `);
}

const EXPECTED_RELATIONAL_INDEX_COUNT = 22;

/**
 * Ensure the authoritative relational v2 schema is active, migrate any remaining
 * `nmg_memory_entities` rows with post-import count verification, and retire the legacy table.
 */
export function ensureAuthoritativeRelationalSchema(db: DatabaseSync, namespace: string): void {
  const hasEntities = hasUnmigratedEntityTable(db);
  const indexCount = Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM sqlite_schema
         WHERE type='index'
           AND tbl_name IN (
             'nmg_sources', 'nmg_nodes', 'nmg_memories', 'nmg_memory_evidence',
             'nmg_memory_relations', 'nmg_memory_markers', 'nmg_tesserae',
             'nmg_write_events', 'nmg_claim_posteriors'
           )
           AND name LIKE 'nmg_%'`,
      )
      .get()?.n ?? 0,
  );
  const alreadyMigrated =
    !hasEntities &&
    indexCount === EXPECTED_RELATIONAL_INDEX_COUNT &&
    Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='nmg_schema_migrations'").get()) &&
    isVersionMigrated(db, namespace, RELATIONAL_SCHEMA_VERSION);
  if (alreadyMigrated) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    upgradeTransitionalRelationalTables(db);
    ensureRelationalTables(db);
    if (hasUnmigratedEntityTable(db)) {
      const namespaces = db
        .prepare("SELECT DISTINCT namespace FROM nmg_memory_entities")
        .all()
        .map((row) => String(row.namespace));
      if (!namespaces.includes(namespace)) namespaces.push(namespace);
      for (const ns of namespaces) {
        if (isVersionMigrated(db, ns, RELATIONAL_SCHEMA_VERSION)) continue;
        const summary = migrateNamespaceFromEntities(db, ns);
        recordMigration(db, ns, { ...summary, retiredEntityTable: true });
      }
      dropLegacyEntityTableIfPresent(db);
    } else if (!isVersionMigrated(db, namespace, RELATIONAL_SCHEMA_VERSION)) {
      recordMigration(db, namespace, {
        schemaVersion: RELATIONAL_SCHEMA_VERSION,
        entityCount: 0,
        countsByKind: {},
        recoveredMissingSources: 0,
        retiredEntityTable: false,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
