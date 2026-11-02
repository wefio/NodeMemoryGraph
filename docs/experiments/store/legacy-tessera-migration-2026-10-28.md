# Store schema and legacy tessera migration — 2026-10-28

[中文](legacy-tessera-migration-2026-10-28.zh-CN.md) · [Terms used](legacy-tessera-migration-2026-10-28.terms.yaml)

At revision `cd193624f10d72b69b010ca70de5d61c6f8cd09d`, isolated SQLite fixtures show two recovery gaps in the legacy `anchors` migration: coexistence skips legacy rows, and a failure after the table rename can leave legacy markers after retry. These observations do not establish that either state occurs in every installation. The fixture does not access a user's database.

## Schema and migration inventory

The [Store schema](../../../src/core/store/schema.ts) owns the main tables and composes [coordination schema](../../../src/core/store/coordination-schema.ts) and [task declarations](../../../src/integration/task-unit-declaration-store.ts). Its domains include history and semantic memory, graph and retrieval indexes, task coordination and run records, and file bookmarks. The [Store constructor](../../../src/core/store/base.ts) enables foreign keys and runs migration on writable open; read-only open does not migrate.

On a fresh in-memory database, `migrate` produced 57 ordinary tables, 5 virtual tables and 22 SQLite shadow tables. `PRAGMA user_version` was 0 and `PRAGMA foreign_key_check` returned no rows. These counts exclude `sqlite_` objects; the empty fresh fixture cannot establish integrity of a populated database. The schema is not one linear `user_version` sequence: `migrate` uses idempotent DDL, column probes and backfills. Vector and lexical FTS migration use savepoints; the legacy rename does not wrap its rename and marker rewrite in a common transaction. The agent-registry rebuild has its own transaction. This is a map of the inspected mechanisms, not an audit of every migration.

## Isolated scenarios

Run from the repository root at the recorded revision, with unmodified `src/core/store/schema.ts` and Node `v24.19.0`. The fixture describes the old behavior and refuses other revisions or a modified schema:

```sh
node --experimental-strip-types docs/experiments/store/legacy-tessera-migration-2026-10-28.mjs --run
```

The [fixture](legacy-tessera-migration-2026-10-28.mjs) creates a fresh in-memory schema, constructs synthetic old and new tables and a synthetic `anchor_ref` marker, runs migration twice, and asserts the observed counts. `old FTS` counts matches for the old row's unique token in the current tessera index. The empty-old case deliberately includes a marker referencing the absent row; it checks the marker branch, not a naturally observed database. The same-ID case gives the old and new rows different content. `null` means the old table no longer exists.

| Scenario | Old rows after retry | Tessera rows | Old markers | Old FTS matches | Observation |
| --- | ---: | ---: | ---: | ---: | --- |
| Old table only | null | 1 | 0 | 1 | Rename, marker-kind replacement and FTS lookup succeeded. |
| Both tables; old empty | 0 | 1 | 1 | 0 | Old table and marker remain. |
| Both tables; distinct IDs | 1 | 1 | 1 | 0 | The old row remains outside current tessera search. |
| Both tables; same ID | 1 | 1 | 1 | 0 | The conflicting old row remains; no merge policy is exercised. |
| Failure after rename, then retry | null | 1 | 1 | 1 | The row is searchable, but the old marker remains. |

The final case injects an exception immediately before the marker `UPDATE` after the rename has executed. It models that statement boundary; it is not a process-kill, power-loss or concurrent-writer test. The fixture checks marker kind, not whether historical marker attributes match current consumers. Coexistence cases show rows retained in `anchors`, not deleted, and do not decide which conflicting record should win.

## Implications and limits

The guard in [`migrateLegacyTesseraeTables`](../../../src/core/store/schema.ts) returns when `tesserae` exists, so neither legacy rows nor old marker kinds are reconciled in those states. A safe change needs a defined collision policy, atomicity and restart behavior, and regression tests that preserve rows, references and the FTS index. Do not delete an old table solely because the current local instance was observed empty; that observation is instance-specific and can change.

This is characterization evidence, not a migration fix or an authorization to change a live database. It does not test other historical schemas, every Store transaction, deployed cloud storage, or the user's database contents. Existing design remains at [memory tesserae](../../design/memory-tesserae-design.md).
