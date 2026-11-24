# Authoritative relational SQLite store and decoupled compute graph

[简体中文](2026-11-24-authoritative-relational-memory-store.zh-CN.md) · [Terms used](2026-11-24-authoritative-relational-memory-store.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

The transitional relational pivot kept `nmg_memory_entities` (JSON blob rows) as
the hidden runtime authority while duplicating subset projections into SQLite
relational tables. That dual-write layout left three risks:

1. Relational hydration dropped extension fields (`truthStatus`,
   `extractMethod`, `claims`, `evidenceRole`, `writeReason`, `writeSource`,
   `openedAt`, `promotedAt`, `retentionChangedAt`, `quarantineUntil`, nullable
   `sourceSessionId`, ordered `markers`, and many-to-many `evidenceIds`),
   making dual reads unsafe.
2. Lifecycle actions (withdrawal, `forget` markers, and `quarantine`/`dormant`
   storage states) had to invalidate derived FTS5/vector indexes and relations
   uniformly without leaving stale postings behind.
3. Algorithm modules (`bm25f-neighborhoods.ts`, `ComputeGraph`) shared helper
   imports or lacked cache-safety guards for unfrozen mutable inputs,
   `sideEffect` operators, and async wave parallelism.

## Decision

SQLite memory storage cuts over completely to normalized relational tables as the
single source of truth (`nmg_sources`, `nmg_nodes`, `nmg_memories`,
`nmg_memory_evidence`, `nmg_memory_relations`, `nmg_memory_markers`,
`nmg_tesserae`, `nmg_state_aliases`, `nmg_write_events`,
`nmg_relation_proposals`, `nmg_claim_posteriors`, `nmg_claim_outcomes`,
`nmg_resolution_events`, `nmg_receipts`, and `nmg_schema_migrations`):

1. **Zero runtime dependency on `nmg_memory_entities`:** Runtime reads, writes,
   batch scans, receipts, chain projections, leaf context, FTS5/vector backfills,
   and inspection views operate solely on the normalized relational tables.
   `src/core/memory/sqlite-entity-migration.ts` is the sole compatibility reader;
   opening an unmigrated store runs a transactional versioned import, verifies
   per-kind counts, records schema version 2, and drops `nmg_memory_entities`.
   `openLocalMemory` writes a SQLite backup before opening when
   `nmg_memory_entities` is present.
2. **Distinguished provenance:** `nmg_sources.source_kind` separates genuine
   transcript evidence (`raw`), synthetic explicit-note sources (`explicit`), and
   conservatively recovered orphan references (`missing_recovered` with empty
   content) so synthetic or missing placeholders never impersonate transcript text.
3. **Lossless hydration and purge propagation:** `hydrateMemoriesFromRows()`
   restores all `MemoryRecord` fields, ordered markers, explicit relations, and
   ordered evidence IDs without silent defaults. Deletions, withdrawals,
   `forget` markers, and `quarantine`/`dormant` states immediately remove
   derived FTS5 rows and vector/chunk blobs and demote incident relations;
   `rebuildDerivedIndexes()` reconstructs FTS5 and prunes orphan vectors from
   the relational tables.
4. **On-demand graph projection:** `projectGraph()` executes SQL filtering,
   sorting, and pagination first, builds explicit and inferred graph edges in
   memory with `authority` (`"explicit" | "inferred"`) and `provenance`
   metadata, and reports cross-page `boundaryRelations` plus
   `page.truncatedRelationCount`.
5. **Storage–algorithm decoupling:** Pure date normalization moves out of
   `sqlite-text-index.ts` into `src/core/memory-normalization.ts` so algorithm
   modules import zero SQLite modules. `ComputeRegistry` supports operator
   `version` and `sideEffect` flags, `ComputeMemoCache` skips caching unfrozen
   mutable inputs/outputs and `sideEffect` subgraphs, and async graph execution
   runs independent nodes per topological wave in parallel.

## Alternatives considered

1. **Permanent dual-write with read adapters:** Rejected because dual-write doubles
   write amplification, risks schema divergence, and keeps unindexed JSON parsing
   on every fallback path.
2. **Fabricating placeholder transcript text for missing evidence during v1
   import:** Rejected because it violates provenance integrity between raw
   transcripts and recovered references.
3. **Always materializing full graph adjacency across pages in SQL:** Deferred for
   bounded `projectGraph` queries; emitting explicit cross-page
   `boundaryRelations` preserves pagination speed without silently losing
   cross-page edges.

## Consequences

- Removing or replacing `ComputeGraph` and retrieval scorers leaves all
  persistent memory storage, lifecycle transitions, migrations, exports, and
  index rebuilds intact in SQLite.
- Edge queries in `sqlite-relational.ts` use `INDEXED BY` hints on
  `nmg_memory_relations_edge_source` and `nmg_memory_relations_edge_target` so
  SQLite's planner selects index seeks instead of primary-key scans on small
  tables.
- `onlion` npm scripts that pass `--experimental-transform-types` remain unchanged
  for CI's Node 24 runtime, while Node 26 local verification invokes those test
  scripts directly with `node`.
