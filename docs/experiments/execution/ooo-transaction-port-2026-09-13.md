# The store owns the transaction boundary, and a port is how work joins it - 2026-09-13

[English](ooo-transaction-port-2026-09-13.md) | [简体中文](ooo-transaction-port-2026-09-13.zh-CN.md) · [Terms](ooo-transaction-port-2026-09-13.terms.yaml)

Evidence boundary (2026-10-17 documentation review): this is a dated research
or fixture record. Table names, source positions, status statements, test counts
and unresolved-work labels belong to its snapshot, not current daemon `taskRun`
integration. No listed suite or mutation was rerun here, and historical/local
replay commands are not confirmed available in this checkout. The current
[task-unit contract](../../design/task-unit-semantics.md) owns product boundaries.

The design's "事务参与与连接生命周期" contract (docs/design/task-unit-semantics.md) requires that one
connection is not one transaction, that the store is the only place that runs BEGIN/COMMIT, and that
a caller already inside a transition joins it through a capability issued for that transition. This
slice implements that primitive and moves the one boundary the contract names by hand
(`putTaskBoardEntry`), with the refusals as tests.

## What changed

- `NmgStoreBase.writeTransaction(callback)` supplies the shared boundary for the
  migrated board-write path; the four methods listed under limits still used
  separate boundaries in this slice. It refuses to open a second
  transaction while one is live, refuses to run at all on a quarantined connection, and refuses a
  callback that returns a thenable - a port must not survive an await.
- `withPort(port, work)` joins the live transition. Validity is identity against the store's own
  open transaction, so a port from another store, a port whose callback has returned, and a port that
  was never issued are all refused by name. Nothing infers authority from a flag or a depth counter.
- A failure inside `withPort` marks the transaction rollback-only even when the caller catches it:
  the work up to the failure already happened, and only the outermost decides whether anything
  commits.
- A failed ROLLBACK keeps the original error and quarantines the connection, because its state is no
  longer known.
- `putTaskBoardEntry(input, port?)` is now a thin entry over `insertTaskBoardEntry`: standalone it
  opens the boundary, composed it joins the caller's, and reached inside a transition without a port
  it is refused rather than nested. Its own BEGIN and catch/ROLLBACK are gone, so there is one
  implementation for both paths.

## Evidence (re-runnable)

- `npm test` - **1463 passed, 0 failed** (1455 before this slice).
- `tests/core/store-transaction-port.test.ts` - **8 of 8**: the committed value is returned; a write
  inside a transition without a port is refused and leaves nothing; a transition cannot open another;
  another store's port is refused; a port used after its callback returned is refused; a thenable
  callback is refused; a swallowed failure still forbids the commit; a failed rollback quarantines
  the connection.
- `node --experimental-strip-types --test "evals/ooo-execution/*.test.ts"` - 88 passed, 0 failed.
- `npm run mutation:teeth` - **25 of 25 mutants caught by name across 6 targets, 6 of 6 restored
  byte-identically, 0 inapplicable** (two added here: a nested write transaction becoming allowed,
  and a swallowed failure still committing).
- `npm run check`, `npm run docs:check`, `npm run complexity:gate` - clean.

The original source review described publication after the outer commit and a
cancelled-round cleanup leak: `runCycle` returned after `gate.close()` at
src/integration/ooo-cycle.ts:814, before the default-directory cleanup `finally`
at line 1037. Passing suites alone do not establish every call's ordering. The
source revision of those positions is not supplied here, so this is an
attributed historical finding, not independent verification of a current leak.

The recorded progression is [task-table split](ooo-task-tables-2026-09-13.md),
this port slice, [round transition](ooo-round-transition-2026-09-13.md), then
[single boundary](ooo-single-boundary-2026-09-13.md). Their changing suite counts
belong to separate snapshots, not repeated measurements of identical inputs.

## What this does not do

- **The round still runs its own transaction.** `BoardAdmission.transaction()` is unchanged and does
  not yet thread a port into its composed board writes (deliver, judge, resolve, retention). The
  contract wants both boundaries changed, and doing it means every composed write inside a transition
  takes the port explicitly.
- **Four store methods still begin their own transactions** (`removeMemoryFromChain`,
  `upsertExternalNodeEmbeddings`, `upsertExternalLeafEmbeddings`, `upsertExternalEmbeddings`). They
  are outside the board path, but "the store is the single BEGIN owner" is not yet literally true.
- **The lifecycle half is not started**: no operations port without `close()`, no borrowed view for
  `status`, no daemon close order (stop new work, fence in-flight attempts, drain, checkpoint, close),
  and the cancelled-round directory leak above is still there.
