# STG Shared Store v2: Project File, Session-Scoped Rows

[English](stg-shared-store-v2-2026-08-12.md) | [简体中文](stg-shared-store-v2-2026-08-12.zh-CN.md) · [Terms](stg-shared-store-v2-2026-08-12.terms.yaml)

**Status:** Current source confirms one STG SQLite file per project with session-scoped row visibility. The 2026-08-12 storage-cost figures and rollout/test labels below are historical reports, not current measurements or verification receipts.

**Updated:** 2026-10-16

**Supersedes:** [STG isolated store](stg-isolated-store.md), which used one session-private file per session.

## Current source contract

- `stgStorePath(projectDir, sessionId)` resolves to `<project>/.nmg/stg.sqlite`; `sessionId` no longer participates in the filename.
- `memory_records.session_id` supplies application-level row visibility. A query with a session ID can see shared rows (`session_id IS NULL`) and rows for that session; a query without one sees only shared rows. This is a filtering contract, not authentication or protection from a local caller that can supply another session ID.
- `cached_from_ltg` copies are project-shared search hints; they are not LTG authority. Session-owned STG rows are removed through the explicit purge path; the project file remains.
- Writable stores use WAL and checkpoint with `PRAGMA wal_checkpoint(TRUNCATE)` on close. The constructor also attempts a best-effort checkpoint on open when a non-empty WAL remains.

These facts are source-checked in [`src/core/stg.ts`](../../src/core/stg.ts), [`src/core/store/base.ts`](../../src/core/store/base.ts), and the session-filtered retrieval/write paths. The design details and trust boundary are in [Shared-store design](stg-shared-store-v2-2026-08-12/shared-store-design.md).

## Historical motivation and evidence boundary

The 2026-08-12 report compared a per-session-file design with a project-shared database. It reported 1,765 session database files, about 1.5 GB of WAL, about 900 MB of repeated schema/FTS overhead, and an empty sampled `memory_records` table. Those are dated observations, not a fresh measurement of the current checkout. The design rationale was to avoid multiplying empty database files while preserving session visibility at the row level.

The report also records a historical anonymous-read leak: a predicate that treated a missing session ID as “any session” exposed private provisional rows. The corrected two-branch visibility rule is described in the child document. Session IDs are supplied by the client/harness and trusted by the daemon; they are not issued or authenticated by this storage design.

The earlier migration plan and industry comparisons are kept as historical context only. They do not establish database-product benchmarks or authorize a future cloud/sync architecture.

## Current source and test references

- [Project-local STG path and purge entry point](../../src/core/stg.ts)
- [STG retrieval and row visibility](../../src/core/store/retrieval.ts)
- [Store schema, connection pragmas, and WAL checkpoint lifecycle](../../src/core/store/base.ts)
- [Write path](../../src/core/store/writes.ts)
- [STG v2 tests](../../tests/core/stg-v2.test.ts)

Test files are cited as owners; this document does not assert a current test pass. See [implementation lineage](implementation-lineage.md) for the curated history-to-owner index.