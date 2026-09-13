# Run-scoped round storage — 2026-09-13

The design's migration step 2 (`docs/design/task-unit-semantics.md`, "persistence"): a round's
storage is namespaced by run, so one store can hold several rounds, and every place that used to
be a singleton is keyed by `(run_id, …)`.

## What this does not do

- **The table is still one table.** `ooo_probe_tasks` holds the immutable manifest, the candidate
  bytes and the derived state in the same row; splitting it is the next step (B2), not this one.
- **The round still owns its SQLite file.** The store is opened by the round rather than injected
  from the daemon (B3). Namespacing makes the _later_ injection a change of owner, not a rewrite of
  every statement — that is the reason for the order.
- **`checkId` is deliberately not run-scoped.** It is the identity a round log records, and a
  replay runs under a new `runId` while reproducing the same attempts; uniqueness in the store is
  the `(run_id, task_id)` key. Scoping it first _broke_ replay (`replay asks for exactly the
recorded attempts: 2 !== 3`), which is how the constraint was found rather than assumed.
- **Acceptance is not restored from a migrated store's old column.** A pre-namespace store recorded
  the round's own verdict; that is the self-report the board's independent verdict replaced. The
  migration keeps the artifact and leaves it unaccepted — visible, not silently accepted.

## What changed

- `BoardAdmissionOptions { runId? }`; `ooo_probe_runs (run_id PK, policy, cancel_reason,
cancelled_at, created_at)` replaces `ooo_probe_meta (id PK CHECK(id=1))`; `ooo_probe_tasks` and
  `ooo_probe_checks` gain `run_id` with composite primary keys; the board channel is
  `ooo-probe:<runId>` instead of the constant `ooo-process-probe`.
- Adoption: a named run opens it; a store with exactly one run is continued (so existing behaviour
  is unchanged); a store with several runs **refuses** and asks to be named, because adopting the
  newest and starting another are both silent answers to somebody's evidence.
- `migrateToRunScope()` rebuilds the legacy tables in a transaction (rename → create → copy →
  drop), and throws rather than guessing if legacy rows exist without a `meta` row. A refused store
  closes its handle: on Windows the caller is told to open a different database, and an open handle
  would keep that file locked (found by the test's cleanup, then fixed).
- ~37 SQL sites now carry `run_id`; both prune paths and retention are per run.

## Evidence

`npm test` — **1452 passed, 0 failed** (product, includes the 4 new tests).
`tests/integration/ooo-run-namespace.test.ts` — **4 of 4**: two runs in one store do not collide,
do not see each other's rows, and cancel separately; a multi-run store refuses to guess; a one-run
store is still continued; a pre-namespace store is migrated in place keeping its run, its rows and
its terminal decision (which the migrated round then _enforces_, refusing a claim).
`npm run mutation:teeth` — **22 of 22 mutants caught by name across 6 targets, 6 of 6 restored
byte-identically, 0 inapplicable.**

Two things this exercise found rather than assumed:

1. The `claim-is-not-scoped-to-its-run` tooth **was not caught** by the first version of the test:
   `next()` and `accepted()` do not observe a neighbouring run's row. The assertion that does is a
   raw-row read of the other run's `owner` after this run claims the same task id. A tooth that
   runs and passes is the difference between a test that describes the change and one that pins it.
2. Scoping `checkId` by run looked like the obvious completion of "one row per run" and was wrong:
   replay is a _different_ run reproducing the _same_ attempts, and the round suites said so.

Both are recorded here rather than in the commit message, because a reviewer can re-run these
commands and a commit message is not evidence.
