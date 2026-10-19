# Shared-Store Design: Row Visibility and Lifecycle

[English](shared-store-design.md) | [简体中文](shared-store-design.zh-CN.md) · [Terms](shared-store-design.terms.yaml) · Parent: [STG shared-store v2](../stg-shared-store-v2-2026-08-12.md)

**Status:** Current source confirms the project-local file and read-filter shape below. The design rationale, incident counts, and rollout labels are historical; session IDs are not an authentication mechanism.

## Storage layout and visibility

```text
<project>/.nmg/stg.sqlite                 # one file per project
memory_records.session_id:
  NULL       → shared row (including cached_from_ltg hints)
  session ID → row visible to that session
```

- Different projects use different files.
- A query with a session ID may see `session_id IS NULL OR session_id = ?`.
- A query without a session ID may see only `session_id IS NULL`; it must not become an unrestricted read.
- `cached_from_ltg` copies are shared project-local hints; LTG remains authoritative. Session-owned rows are removed by the explicit session purge path.

The current retrieval predicates are in [`src/core/store/retrieval.ts`](../../../src/core/store/retrieval.ts), and the shared store path/purge wrapper is in [`src/core/stg.ts`](../../../src/core/stg.ts).

## Historical anonymous-read leak

The 2026-08-12 report records a daemon RPC observation in which the old predicate `(? IS NULL OR session_id IS NULL OR session_id = ?)` exposed private provisional rows when no session ID was supplied. It was replaced by two explicit branches: with a session ID, shared rows plus that session's rows; without one, shared rows only. This is a dated incident record; current code remains the authority for every read path.

## Trust and security boundary

A `sessionId` is a visibility selector supplied by the client/harness. The daemon applies the row filters but this design does not issue or authenticate the identifier. A local caller able to submit another session ID is outside the protection supplied by the SQL predicate. The design reduces accidental omissions by centralizing the daemon/store path; it is not equivalent to database-enforced row-level security.

The historical design also proposed that a globally visible STG row should arise through an explicit shared-cache or consolidation path, not through an accidentally omitted argument. That is a design invariant, not a claim that every current write API independently enforces it. Verify the specific write owner before relying on a required-session rule.

## Lifecycle and WAL handling

| Operation | Current owner/path |
|---|---|
| Create/open STG | One project file via `createStgStore()` |
| Copy LTG search hints | `copyLtgSubsetToStg()` writes `cached_from_ltg` markers |
| Remove one session's STG rows | `purgeSessionFromStg()` delegates to store purge |
| Close writable store | `NmgStore.close()` attempts `wal_checkpoint(TRUNCATE)` before closing |
| Recover residual WAL after an unclean exit | Constructor best-effort checkpoints a non-empty WAL |

A checkpoint does not authenticate the session or alter row-visibility semantics. Current code and tests, not the historical rollout table, establish behavior.

## Source and test references

- [Project-local STG helpers](../../../src/core/stg.ts)
- [Session-filtered read paths](../../../src/core/store/retrieval.ts)
- [Session-scoped writes and purge implementation](../../../src/core/store/writes.ts)
- [Store constructor, pragmas, close, and checkpoint-on-open](../../../src/core/store/base.ts)
- [STG v2 behavior tests](../../../tests/core/stg-v2.test.ts)