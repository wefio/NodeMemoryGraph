# One transaction boundary in the store, and a check that keeps it - 2026-09-13

The integration contract requires that the store is the only place that runs BEGIN/COMMIT/ROLLBACK.
After the port primitive (previous record) four store methods still opened their own: the memory-chain
removal and the three external-embedding upserts. This slice moves them onto the boundary and makes the
invariant mechanical.

## What changed

- `removeMemoryFromChain`, `upsertExternalNodeEmbeddings`, `upsertExternalLeafEmbeddings` and
  `upsertExternalEmbeddings` call `writeTransaction()` instead of BEGIN/try/COMMIT/catch/ROLLBACK.
  `src/core/store/base.ts` now contains exactly one BEGIN, one COMMIT and one ROLLBACK, and all three
  are the boundary's own.
- The embedding upserts' cache refresh stays **outside** the transaction, where it already was: a batch
  whose transaction did not commit must not warm the cache either. The conversion preserved that
  instead of quietly pulling it inside.
- The invariant is a test, not a convention: `the store runs its transaction boundary in exactly one
place` counts the three statements in the source and checks that the BEGIN and COMMIT belong to
  `writeTransaction` and that every `this.rollback()` call is one the boundary made. A behavioural
  test cannot see a second boundary that happens to work.

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
the confirmed cancelled-round temporary-directory leak (`src/integration/ooo-cycle.ts:814` returns
before the `finally` at line 1037 that removes the default directory).
