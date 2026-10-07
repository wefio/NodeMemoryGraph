# Keep lexical FTS postings, not duplicate full text

[中文](2026-10-07-contentless-lexical-fts.zh-CN.md)

**Status:** implemented
**Approved:** explicit

## Problem

`memory_fts` stored transformed statements, node names and evidence in its
content shadow table, although authoritative memory/history fields already
existed. The surface-trigram index was already contentless. Removing both
indexes, conflating identical evidence, or indexing only one source field would
change retrieval or provenance rather than eliminate a redundant payload.

## Decision

- Make lexical FTS5 `content = '', contentless_delete = 1`, retaining the same
  columns, tokenizer, Han-bigram transformation, positions and document sizes.
  Raw FTS columns return NULL; original statements and evidence remain in their
  owning tables, with distinct IDs, actors, scopes, timestamps and relationships.
- Add nullable, uniquely indexed `memory_fts_registry.lexical_rowid`. The
  registry's own rowid still belongs to surface FTS. Preserve existing lexical
  rowids during migration, including BM25 ties and bounded candidate selection;
  ordinary refreshes retain the lexical index's append-order behavior.
- Route reads and deletions through the appropriate rowid mapping. Inspector
  and current read-only store code detect the actual FTS schema using metadata,
  supporting unmigrated legacy databases and a writer's atomic upgrade.
- Rebuild both indexes from canonical statements, node names, history content
  and recall-trigger markers in one savepoint. Registry column/index additions,
  postings and the `fts_storage_format = contentless-registry-v1` marker commit
  together. Keep the existing `fts_text_format` version: token semantics did not
  change. Failure restores the previous schema, rows and markers, and a caller's
  transaction can roll back the migration.
- Atomically refresh each document's two indexes and mappings. Completed store
  opens repair missing mappings without rebuilding the corpus; deleted records
  are excluded from registration and repair so forgetting is not undone by reopen.
  Dormant, restored and deleted records use the same shared removal path.
- Do not change page size, vector representations, source fields, durability or
  run automatic `VACUUM`.

## Alternatives considered

- **External-content FTS:** transformed Han bigrams and evidence-plus-trigger
  fields do not directly equal the authoritative rows. A materialized external
  content table would simply move the duplicate payload.
- **Reuse the surface registry rowid for lexical FTS:** refreshes historically
  append lexical documents while surface rowids remain stable. Collapsing the
  two mappings changes equal-score order and limit-selected evidence.
- **Intern history and statement text across tables:** potentially useful for
  identical bytes, but requires a separate shared-payload API and lifecycle
  migration. Distinct evidence must never be merged; summaries can differ from
  sources. This phase deliberately removes only FTS full-text copies.
- **Drop FTS or deduplicate its field postings:** would alter Chinese retrieval,
  surface anchors, BM25 field lengths or recall quality.

## Consequences

The [bounded local experiment](../../experiments/store/contentless-fts-2026-10-07.md)
removed 418,580 logical UTF-8 FTS text bytes from 300 synthetic records while
keeping original fields, vector tables, rankings, both rowid mappings and row
counts. Allocated bytes did not shrink during migration; fixture-only compaction
reduced that endpoint's allocation by about 20.0%. This is not a cloud or latency
estimate.

The existing surface FTS already requires SQLite's contentless-delete support;
this does not introduce a newer engine floor. The layout nevertheless requires
matching registry-aware code on every reader/writer. Older code reading
`memory_fts.memory_id` receives NULL, and old deletions cannot identify documents.
Do not mix old writers with the migrated database or roll back only the binary.
Upgrade integrations together; migrate a disposable copy first and retain a
consistent backup. Current read-only compatibility is not old-executable
compatibility.

Eleven regressions cover payload removal, positive Chinese/trigger BM25 parity,
tie order, provenance, refresh and deletion, dormant restoration, two rollback
boundaries, outer transactions, unchanged opens, inspector compatibility and a
live read-only connection across a writer upgrade. The legacy retrieval fixture
now creates the actual old full-content table instead of using a predicate that
silently cannot delete a contentless row.

## Deferred

Cross-table text interning, cloud/WASM deployment, backup recovery, crash-time
multi-process upgrades, production compaction, latency and official recall
benchmarks have not been validated or implemented by this batch.
