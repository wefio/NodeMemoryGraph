# The design's enumerated cases, made executable

[English](task-semantics-design-cases-2026-09-13.md) | [简体中文](task-semantics-design-cases-2026-09-13.zh-CN.md) · [Terms](task-semantics-design-cases-2026-09-13.terms.yaml)

**Related:** [task-unit semantics design](../../design/task-unit-semantics.md) ·
[decision record](../../decisions/implemented/2026-09-13-task-unit-semantics.md) ·
[slice 1: compiler and model](task-semantics-slice1-2026-09-13.md) ·
[one acceptance predicate](ooo-acceptance-predicate-2026-09-13.md)

## Historical checkpoint and reading path

The [retention companion](ooo-retention-2026-09-13.md) is now a concrete reading
route, not an unnamed branch prerequisite. The design's
[minimum discriminating cases and persistence/recomputation conditions](../../design/task-unit-semantics/next-slice-and-stop-conditions.md#next-executable-slices-and-stop-conditions)
define what this first slice must distinguish. This report maps those bullets
to tests, including missing/unmodelled parts; it does not claim every bullet is
fully implemented. Its research compiler/model and controlled board/round suites
are distinct evidence layers, not the product `taskRun` status contract.

All counts, pass labels, source details and "next slice" statements below belong
to this historical implementation checkpoint. No tests, mutation sweeps, raw
run artifacts or current product integration were reverified by this review.

The record reports commands run in the implementation worktree (`feat/task-semantics-cases`), each with its exit status:

| What                                                                                        | Result                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run check` (tsc + eslint + format + docs)                                              | 0                                                                                          |
| `node --test tests/integration/task-semantics-cases.test.ts`                                | 8 pass / 0 fail                                                                            |
| `tests/integration/task-semantics.test.ts`                                                  | 13 pass / 0 fail                                                                           |
| `tests/integration/task-semantics-model.test.ts`                                            | 7 pass / 0 fail                                                                            |
| `evals/ooo-execution/*.test.ts`                                                             | 88 pass / 0 fail                                                                           |
| `npm test` (product)                                                                        | 1444 pass / 0 fail                                                                         |
| `npm run complexity:gate`                                                                   | 5 changed code files, 0 methods above 15                                                   |
| `npm run docs:check`                                                                        | 187 files, 0 errors                                                                        |
| `npm run mutation:teeth` (`tools/mutation-teeth.ts`, `--json` for the machine-readable run) | 19 of 19 mutants caught by name across 4 targets; 4 of 4 targets restored byte-identically |

## Bullet by bullet

The product count 1444 is retained as reported. The later
[ledger readings](../verification/task-unit-semantics-ledger-readings-2026-10-14.md)
report 1457 and describe a separate 1446 → 1457 clock-window-fix transition.
No matched run/tree binding connects those counts here; the missing intermediate
history is not supplied or attributed by subtraction. Neither record is a new pass.

"Passed" below is confined to the named model/compiler or controlled suite;
it is not universal runtime verification or natural-task evidence.

| Design bullet                                                                                                                             | Where it is checked                                                                                                                 | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discriminating 1: P and T can be prepared, J waits for both                                                                               | `cases` case 1                                                                                                                      | Passed for "J waits for both". "Prepared" and two same-file candidates becoming mergeable are **not modelled**, and the model now names both (`preparation`, `mergeability`) instead of leaving them silently absent.                                                                                                                                                                                                                  |
| Discriminating 1: concurrent same-file candidates do not merge themselves                                                                 | `cases` case 1 (second half)                                                                                                        | Passed as far as the model goes: every plan is a permutation of the same task ids, never a shorter one, so this representation does not collapse their identities. It does not test text mergeability or prevent external filesystem writes.                                                                                                                                                                                                                                                                                     |
| Discriminating 2: a lost obligation or a widened permission is refused                                                                    | `cases` case 2                                                                                                                      | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Discriminating 2: a fake data dependency cannot be patched over by a control assumption                                                   | `cases` case 2                                                                                                                      | **This found a real hole.** `Requirement` documents itself as a precondition on a _dependency's_ accepted artifact, but `compileTaskUnits` only required the named task to exist somewhere in the plan. A unit could therefore declare a soft condition about a task it does not depend on, start without that input, and the plan still compiled. Now refused with obligation `input-closure` and reason "not a declared dependency". |
| Discriminating 3: a failed fusion keeps only the accepted prefix                                                                          | `cases` case 3                                                                                                                      | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Discriminating 3: a successor does not run ahead; a cancel is not swallowed by a batch claim                                              | `evals/ooo-execution/cancellation.test.ts`, `patch-cycle.test.ts`                                                                   | Checked there; the compiler has no notion of running.                                                                                                                                                                                                                                                                                                                                                                                  |
| Discriminating 4: drift, lease generation, cancel and late results must not publish wrongly                                               | `cases` case 4 (revision drift, cancellation) plus `evals/ooo-execution/recovery.test.ts`, `check-events.test.ts`, `replay.test.ts` | Passed where the compiler can see it; the lease and late-result halves are the round's and stay there.                                                                                                                                                                                                                                                                                                                                 |
| Discriminating 5: speculation's true/false/unknown outcomes                                                                               | `cases` case 5                                                                                                                      | Passed: accepted publishes, rejected is voided, undecidable stays unaccepted and blocks its dependent.                                                                                                                                                                                                                                                                                                                                 |
| Discriminating 6: degrade to the baseline; do not manufacture a wait                                                                      | `cases` case 6                                                                                                                      | Passed, and made explicit: the ordered mode is one plan order with zero rollbacks, and neither semantics module contains `setTimeout`, `setInterval`, `Date.now`, `new Date`, `Math.random` or `process.hrtime`. These checks keep elapsed waiting out of the pure model; they do not measure live waiting, CPU cost or end-to-end speedup.                                                                                                                                          |
| Persistence: field mapping catches budget-unit confusion, requires/deps confusion, unknown-field drops                                    | `cases` field-mapping test; slice 1's budget and alias cases                                                                        | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Persistence: two rounds with the same taskId must not collide                                                                             | not implemented                                                                                                                     | **Not represented at this checkpoint**, see below.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Persistence: retries do not double-deliver; retained entries survive TTL; status and dependency release agree                             | `tests/core/task-board-retention.test.ts`, `evals/ooo-execution/patch-cycle.test.ts`                                                | Passed (earlier slices).                                                                                                                                                                                                                                                                                                                                                                                                               |
| Persistence: a transaction failure does not write a verdict without its relation; JSONL export failure does not change the terminal state | `tests/core/task-board-deliverable.test.ts`, `evals/ooo-execution/round-log.ts` suites                                              | Checked there.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Recompute: deleting derived caches gives the same view; recomputation is idempotent                                                       | `cases` recomputation test                                                                                                          | Passed: identical digests and identical ready/blocked from the same facts.                                                                                                                                                                                                                                                                                                                                                             |
| Recompute: lease-boundary clock, concurrent single claim, crash-window unknown                                                            | `evals/ooo-execution/multiprocess.test.ts`, `recovery.test.ts`                                                                      | Checked there; `undecidable` never counts as accepted, so an unknown is not guessed as success.                                                                                                                                                                                                                                                                                                                                        |
| HA/MGR bullets                                                                                                                            | not started                                                                                                                         | Out of scope for this slice by the design's own words.                                                                                                                                                                                                                                                                                                                                                                                 |

## What the teeth check caught

The mutation harness now lives in the repository as `tools/mutation-teeth.ts` (`npm run mutation:teeth`),
as the later repository entry point. Its present existence does not reproduce the old register, test identities or counts. It reports three
outcomes per target — the clean run passes, each mutant fails the suite _and_ the named test is what
fails it, and the file is restored byte-identically. At the reported checkpoint, absent/duplicated markers were refused rather than
half-applied, and survivors were not credited as caught. This is the recorded
harness behavior, not a fresh test of every current failure/restore path.
Folding the two older local board-teeth scripts into it found a stale anchor of exactly the kind the
harness exists to expose: the board-verdict mutant still targeted the pre-#56 line, where `accepted()`
joined the verdict itself. Retargeting it — and then checking _which_ test actually fails, rather than
assuming — showed the rule is caught by `the board verdict is what accepts an artifact, not the round's
own column`.

The new mutant `assumption-may-carry-a-dependency` was **not** caught on the first run even though the
test that should catch it passes. The harness was the problem: each target listed one suite, and the
design's cases live in a new file, so the mutant was never run against them. The harness now takes a
list of suites per target. This is the same failure class as the stale anchor above — the check's own
coverage drifts when the thing it checks moves.

## What this does not do

- **No multi-round namespacing at this checkpoint.** The reported private store held one run: `ooo_probe_meta` has
  `CHECK(id=1)`, `ooo_probe_tasks` is keyed by `id` alone, and the board channel is the fixed
  `ooo-process-probe`. The design names these three as what cannot move into a shared database as-is
  (then line 229, not a stable current locator): equal task IDs across runs cannot
  be tested in that single-run representation. Namespacing was a prerequisite for
  shared transaction-store injection, not a tidy-up. The subsequent
  [research run-namespace report](ooo-run-namespace-2026-09-13.md) records that
  later slice; it is not a product namespace or new verification receipt.
- The recorded model excludes preparation, mergeability, real verification,
  external waits and wall clock in `UNMODELLED_BY_MODEL`. This is its scoped gap
  list, not an audit of all current callers.
- The reported passes cover the named checks on declared model plans/outcomes
  over at most four units. They do not establish every possible input/plan or
  prove an arbitrary Agent program correct (the design says so too).
