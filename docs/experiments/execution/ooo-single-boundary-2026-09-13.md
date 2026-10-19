# One transaction boundary in the store, and a check that keeps it - 2026-09-13

[English](ooo-single-boundary-2026-09-13.md) | [简体中文](ooo-single-boundary-2026-09-13.zh-CN.md) · [Terms](ooo-single-boundary-2026-09-13.terms.yaml)

Evidence boundary (2026-10-17 documentation review): this is a dated research
or fixture record. Table names, source positions, status statements, test counts
and unresolved-work labels belong to its snapshot, not current daemon `taskRun`
integration. No listed suite or mutation was rerun here, and historical/local
replay commands are not confirmed available in this checkout. The current
[task-unit contract](../../design/task-unit-semantics.md) owns product boundaries.

The integration contract requires that the store is the only place that runs BEGIN/COMMIT/ROLLBACK.
After the port primitive (previous record) four store methods still opened their own: the memory-chain
removal and the three external-embedding upserts. This slice moves them onto the boundary and makes the
invariant mechanical.

## What changed

- `removeMemoryFromChain`, `upsertExternalNodeEmbeddings`, `upsertExternalLeafEmbeddings` and
  `upsertExternalEmbeddings` call `writeTransaction()` instead of BEGIN/try/COMMIT/catch/ROLLBACK.
  `src/core/store/base.ts` now contains exactly one BEGIN, one COMMIT and one ROLLBACK, and all three
  are the boundary's own.
- The embedding upserts' cache refresh stays **outside and after successful commit**: a batch
  whose transaction did not commit must not warm the cache either. The conversion preserved that
  instead of quietly pulling it inside.
- The invariant is a test, not a convention: `the store runs its transaction boundary in exactly one
place` counts the three statements in the source and checks that the BEGIN and COMMIT belong to
  `writeTransaction` and that every `this.rollback()` call is one the boundary made.
  A passing behavioural suite alone does not establish that structural property;
  the source-pattern check is itself limited to the statements it recognizes.

## Evidence (re-runnable)

- `npm test` - **1467 passed, 0 failed**.
- `tests/core/store-transaction-port.test.ts` - **9 of 9** (eight refusals plus the one-boundary
  invariant).
- `node --experimental-strip-types --test "evals/ooo-execution/*.test.ts"` - 88 passed, 0 failed.
- `npm run mutation:teeth` - **27 of 27 mutants caught by name across 6 targets, 6 of 6 restored
  byte-identically, 0 inapplicable** (one added here: a method that opens its own transaction).
- `npm run check`, `npm run docs:check`, `npm run complexity:gate` - clean.

## What this does not do

The lifecycle half is still untouched: no operations port that does not carry `close()`, no borrowed
view for `status` (it must not migrate schema, publish handoffs or write), no daemon close order, and
the historically reported cancelled-round temporary-directory leak
(`src/integration/ooo-cycle.ts:814` returning before the cleanup `finally` at
line 1037). No source revision is pinned to those positions here, and this
review did not revalidate them as a current bug.
