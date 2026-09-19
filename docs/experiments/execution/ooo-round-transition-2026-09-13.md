# A round's transition and the board write inside it - 2026-09-13

The design's integration contract says the composed write entries reuse one implementation: standalone
they open the transaction boundary, and inside a transition they join it through the port the store
issued. This slice does the round's half.

## What changed

- `BoardAdmission.transaction()` no longer runs BEGIN/COMMIT/ROLLBACK of its own: it delegates to the
  store's `writeTransaction()`, so the round's transitions _are_ the store's boundary.
- `publish()` and `publishReady()` take the optional port and hand it to `putTaskBoardEntry()`, so a
  publication made inside a transition is part of that transition instead of a second BEGIN (which the
  store refuses rather than nesting).

No caller publishes inside a transition today — publishing happens after the outer commit, which is
what the design's static review says and what the green suites before this change confirmed. The point
of the change is that the rule no longer depends on that ordering: a publication reached inside a
transition now joins it, and a publication reached without a port is refused by name.

## Evidence (re-runnable)

- `npm test` - **1466 passed, 0 failed**.
- `tests/integration/ooo-transition-atomicity.test.ts` - **3 of 3**: a publication commits with the
  transition; the round's own publication rolls back when the transition fails after it (the check a
  second BEGIN cannot pass); a publication without a port inside a transition is refused and writes
  nothing.
- `node --experimental-strip-types --test "evals/ooo-execution/*.test.ts"` - 88 passed, 0 failed.
- `npm run mutation:teeth` - **26 of 26 mutants caught by name across 6 targets, 6 of 6 restored
  byte-identically, 0 inapplicable** (one added here: a round publication that opens its own
  transaction).
- `npm run check`, `npm run docs:check`, `npm run complexity:gate` - clean.

A commit-hygiene note, because it was caught by accident rather than by a gate: B2's adaptation of
`tests/integration/ooo-run-namespace.test.ts` (the raw reads that follow the new projection) was left
out of B2's commits, so the branch as pushed had a red suite in it. It is committed separately now, and
the failure mode is worth remembering: a refactor that moves a table can break a test in a file the
refactor never touched.

## What this does not do

- **Four store methods still begin their own transactions** (`removeMemoryFromChain`,
  `upsertExternalNodeEmbeddings`, `upsertExternalLeafEmbeddings`, `upsertExternalEmbeddings`), so "the
  store is the single BEGIN owner" is still not literally true.
- **The lifecycle half is not started**: no operations port carrying no `close()`, no borrowed view for
  `status` (it must not migrate schema, publish handoffs or write), no daemon close order, and the
  confirmed cancelled-round temporary-directory leak (`src/integration/ooo-cycle.ts:814` returns before
  the `finally` at line 1037 that removes the default directory).
