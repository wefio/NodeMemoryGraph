# The design's first slice: a shared pure-data compiler and a finite offline model

[English](task-semantics-slice1-2026-09-13.md) | [简体中文](task-semantics-slice1-2026-09-13.zh-CN.md) · [Terms](task-semantics-slice1-2026-09-13.terms.yaml)

**Related:** [task-unit semantics design](../../design/task-unit-semantics.md) ·
[decision record](../../decisions/implemented/2026-09-13-task-unit-semantics.md) ·
[OoO bootstrap design](../../design/ooo-execution-bootstrap.md) ·
[what the wait is worth](wait-value-2026-09-12.md)

Measured 2026-09-13. Zero model tokens: no provider was contacted for any number below, and
the two new modules import no store, no database, and no network.

## Question

This records the first research compiler/model checkpoint, not the state of
all current callers or product `taskRun` status. Line counts, tests and mutation
results are historical; this review ran none of them or their reproduction
commands. The [subsequent cases report](task-semantics-design-cases-2026-09-13.md)
records later input-closure checks and explicit unmodelled areas.

The design's first slice is specified as a **shared pure-data compiler plus a finite offline
execution model**: no model calls, no board-table change, no new store. Two claims in it are
checkable without any of that, so this run checked them instead of restating them:

1. Does compiling the existing contracts produce a view that **refuses unsupported mappings
   with a location** instead of silently dropping them?
2. Can **one acceptance predicate** serve both the status query and dependency release, and
   does a model built on it show fusion's cost rather than asserting it?

## What was built

| file                                             | lines | role                                                                                                                                                                                         |
| ------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integration/task-semantics.ts`              | 552   | the compiler: derives `TaskUnit[]` from `ProbePlan` + `PatchTaskSpec` + cycle `Requirement`s; freezes nothing itself (`preparePatchWork` still does); owns the single `isAccepted` predicate |
| `src/integration/task-semantics-model.ts`        | 179   | the model: enumerates legal settlement orders for `ordered` / `out-of-order` / `fused` over ≤4 units and counts waits, rollbacks, retries                                                    |
| `tests/integration/task-semantics.test.ts`       | 322   | 12 cases                                                                                                                                                                                     |
| `tests/integration/task-semantics-model.test.ts` | 132   | 7 cases                                                                                                                                                                                      |

At the first-slice checkpoint no runtime path called these modules. The design's migration order puts the compiler and
the model first and the runners last; this is that first step and it is deliberately inert.

## Evidence

| check          | command                                                                                                | result                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| types          | `npm run check`                                                                                        | 0 errors                                                                |
| complexity     | `npm run complexity:gate`                                                                              | `4 changed code file(s) … 0 method(s) above 15`                         |
| lint / format  | `npx eslint src/integration/task-semantics*.ts`, `npm run format:check`                                | clean                                                                   |
| compiler suite | `node --experimental-strip-types --test --test-concurrency=1 tests/integration/task-semantics.test.ts` | 12 pass, 0 fail                                                         |
| model suite    | `… tests/integration/task-semantics-model.test.ts`                                                     | 7 pass, 0 fail                                                          |
| mutation teeth | `npm run mutation:teeth` (historical label; "then a local script", see below)                                     | 8 of 8 mutants caught **by name**; both files restored byte-identically |

The teeth check now lives in the repository as `tools/mutation-teeth.ts` (`npm run mutation:teeth`),
as a later repository entry point. The record also describes a local script at
landing; its exact historical invocation/ordering is not supplied here. Retaining
the named mutants/expected cases does not establish an identical register or
reproduce the 8/8 reading in a current checkout. It reports which mutants are applicable in the checkout it
runs in, so a target whose code lives on another branch is reported as not applicable rather than
counted as caught.

The teeth check reports three outcomes rather than one: the clean run must pass, each mutant
must fail the suite under the expected test's name, and the mutated file must come back
byte-identical. A mutant whose anchor is absent is reported as unclaimed, not as caught.

## The budget mutant under the original test inputs

The first `budget` mutant — delete the loop that refuses unknown keys inside `spec.budget` —
was **not caught**, and the suite still exited 0 with the mutation in place. The reason was not
a weak assertion: `maxBytes` and `maxOutputTokens` are top-level spec fields, so they were
refused by the neighbouring `SPEC_FIELDS` check and the inner loop was never reached. The
old selected inputs did not distinguish the mutant: they failed before reaching
the changed loop. That is test-input non-discrimination, not semantic equivalence
of the programs for every input; the next cases demonstrate an observable difference.

Two cases were added (`budget.bytesPerFile`, `limits.deadlineMs`, and a `perFile` above
`MAX_PATCH_BUDGET`), after which the same mutant is caught. The general lesson is recorded
because it generalises: **a mutant that fails nothing is not always a missing assertion; it can
be a neighbouring check doing the work**. Naming the expected failing test helps
identify the exercised rule; it does not alone prove full coverage or equivalence.

## What the model shows (two units, `D` depends on `P`)

Reported `compareModes` counts on a `P → D` plan with predefined outcomes.
`waits` counts model events, not elapsed time; the range is across legal
settlement orders, not a statistical confidence interval or independent runs.
`fused` is this model's label, not proof of real model-session reuse:

| outcomes                   | mode         | orders | waits | rollbacks |
| -------------------------- | ------------ | ------ | ----- | --------- |
| `P` accepted, `D` accepted | ordered      | 1      | 1..1  | 0..0      |
|                            | out-of-order | 1      | 1..1  | 0..0      |
|                            | fused        | 2      | 0..1  | 0..0      |
| `P` rejected, `D` accepted | ordered      | 1      | 1..1  | 0..0      |
|                            | out-of-order | 1      | 1..1  | 0..0      |
|                            | fused        | 2      | 0..1  | 0..1      |

The fused plan that starts `D` before `P` settles records `waits: 0, rollbacks: 1, retries: 1`
and accepts nothing when `P` is rejected, while the plan that waits records `waits: 1,
rollbacks: 0`. Fusion therefore buys order freedom and pays in rollback — the model states the
trade rather than assuming it is free. Note also that the fused mode's _floor_ is zero
rollbacks in both tables: fusion may still choose to wait, which is why the comparison is
reported as a spread and not as a single best case.

## What this does not establish

- No model call, no wall clock, no real verification, and no external wait is modelled
  (the recorded `UNMODELLED_BY_MODEL` names the wall-clock, verification and
  external-wait gaps); the enumeration cap is four units.
- The two defects named at the first-slice checkpoint were **not fixed by it**: `accepted()` in
  `src/integration/ooo-board.ts` joins the board verdict while dependency release reads
  `artifact !== null`, and `ooo_probe_tasks` mixes immutable input, candidate bytes, and
  derivable state. The compiler encodes the single predicate that would fix the first; switching
  that research round onto it was subsequent work, not a present audit conclusion.
- The compiler refuses a read or write path outside the frozen files, an out-of-range budget, an
  unknown requirement kind, a cycle, and a spec without a verifier. It does not yet refuse a
  refinement whose _data_ dependencies are missing, because the design has no parent-obligation
  mapping to check against — the refinement check here takes a host-declared split.
  The cases report's specific `input-closure` repair is not a substitute for
  proving that broader parent-obligation mapping.

## Reproduction

These preserved commands target the historical implementation branch, not an
arbitrary current worktree, and were not executed here. Consult the current
operating owner before an authorized run; no identical counts or source layout
are guaranteed by keeping this block.

```bash
cd <worktree on this branch>
npm run prompts:generate          # generated prompts are not tracked
npm run check && npm run complexity:gate && npm run format:check
node --experimental-strip-types --test --test-concurrency=1 tests/integration/task-semantics.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/task-semantics-model.test.ts
npm run mutation:teeth   # every mutant from slices 1-3, checked by name
```
