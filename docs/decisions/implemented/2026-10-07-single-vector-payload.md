# Persist one payload per embedding

[中文](2026-10-07-single-vector-payload.zh-CN.md)

**Status:** implemented
**Approved:** auto

## Problem

Embedding rows duplicate the same vector as JSON and a Float32 BLOB. Retrieval
loads both despite preferring the BLOB, and pure FTS queries load and decode
vectors whose scores are discarded. Smaller SQLite pages cannot remove these
redundancies and have data-dependent packing costs.

## Decision

Use the existing binary representation as the sole payload while retaining the
JSON column as a compatibility placeholder. The owning
[storage contract](../../design/design.md) defines migration and read semantics.
A version marker bounds migration work to the first writable upgrade; legacy
rows introduced later remain readable without forcing another full-table sweep.

Keep the existing decoder's binary-type preference rather than using unguarded
`COALESCE`: SQLite BLOB affinity permits text, and a mistyped binary value must
still fall back to JSON. Model presence, not JSON content, identifies Qwen
candidates. Existing Float32 precision, scoring, cache ownership, transactions,
evidence and graph/state behavior stay intact.

## Alternatives considered

- **Keep both formats indefinitely.** Duplicates storage and serialization work
  without adding retrieval fidelity: readers already prefer Float32.
- **Drop the JSON columns.** Requires table rebuilds and unnecessarily breaks
  binary-aware older readers that still select both columns.
- **Delete one embedding model or use Float16.** Changes retrieval coverage or
  precision instead of removing identical-payload duplication.
- **Change page size or vacuum automatically.** Does not address duplicate bytes
  and adds rebuild, free-space, WAL and deployment-specific risks.

## Consequences

The migration savepoint rolls back all vector changes, added columns and its
marker on failure, including inside a caller-owned transaction. Existing binary
bytes, keys and timestamps are preserved. Unverified legacy text is retained
when the binary shape does not match its declared dimensions.

The [storage regressions](../../../tests/core/store/vector-storage.test.ts)
cover atomic rollback, repeated opens, model-specific readers and writers,
legacy fallback, and Chinese/punctuation FTS without vector payload reads.
Deleting duplicate values releases logical storage; existing database files do
not necessarily shrink until a separately controlled compaction. The
[controlled storage probe](../../experiments/store/single-vector-payload-2026-10-07.md)
compares compacted endpoints without changing page size.

## Deferred

Cloud bridge/WASM/VFS compatibility and JSON-only external readers require their
source and a deployment-level test before rollout. Real-cloud size, latency,
upload behavior, backup recovery and page-size migration are not established
by local synthetic tests. Production databases are not migrated by this change's
repository verification.
