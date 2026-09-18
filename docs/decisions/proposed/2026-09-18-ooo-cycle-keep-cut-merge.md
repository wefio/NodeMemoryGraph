# `ooo-cycle.ts`: keep what is shared, merge what is duplicated, cut the A/B/C instrument

[中文](2026-09-18-ooo-cycle-keep-cut-merge.zh-CN.md)

**Status:** proposed
**Relates to:** [task-unit-semantics design](../../design/task-unit-semantics.md),
[its obligations ledger](../../design/task-unit-semantics-obligations.md),
[the arms get their own driver](../implemented/2026-09-17-arms-get-their-own-driver.md),
[the declared slot budget](../implemented/2026-09-18-declared-slot-budget.md),
[long detached checks](../implemented/2026-09-18-detached-long-checks.md)

Governing meta-rule: [self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md) —
this changes module structure and one Skill-adjacent convention (where an experiment lives), so it
carries its own decision, alternatives and acceptance criteria.

## Problem

`src/integration/ooo-cycle.ts` is 1,082 lines and 13 exports. It is the repository's largest single
file whose subject is an experiment. The disposition question was left open on purpose by
[the 2026-09-17 decision](../implemented/2026-09-17-arms-get-their-own-driver.md) — the operator deferred the
"role layer versus mechanism layer" split rather than forgetting it — and the ground has moved since:
the arms have their own driver, the daemon has a run surface (D13), the coordinator owns coordinated
writes and the run-entry binding (D11/D12), and the ordinary collaboration path no longer needs a
round at all (G1).

Measured with a throwaway script over `src/`, `evals/`, `tests/`, `tools/` (556 files; the script
and its JSON are in `.temp/`, untracked, because they are one-off):

| What was measured                                     | Result                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| References to the round's **fixed A/B/C names**       | **70**, spread over 17 of the 44 internal symbols                                                                                                                                  |
| Calls into the **store/board port** inside the module | **4** call sites, in 3 symbols (`trace`, `logContractError`, `runTask`)                                                                                                            |
| Symbols that touch neither (`pure`)                   | **24** — verification, case resolution, premise checks, composition                                                                                                                |
| Runtime callers of `runCycle` / `openRoundStore`      | **9 files each, all under `evals/ooo-execution/`**                                                                                                                                 |
| Callers under `src/`                                  | **type-only**: `WorkerMetrics`/`CycleWorker` (from `ooo-round-log.ts`), `Requirement` (from `task-semantics.ts`)                                                                   |
| Callers under `tests/`                                | **none**                                                                                                                                                                           |
| Cases the research suites pin against this module     | ~84, over 11 files (`cycle.test.ts` 46, `replay` 10, `patch-cycle` 10, `round-plan` 6, `notification` 4, `round-cli` 4, `cancellation` 3, `early-cancel` 1, plus 3 driver scripts) |
| Is it a registered mutation target?                   | **No** — 17 targets, and its siblings are among them (`ooo-board.ts`, `ooo-execution.ts`, `task-semantics*.ts`, `task-coordinator.ts`, `task-advisers.ts`)                         |
| Does any route own it?                                | No route matches it — but **no route matches `src/integration/**` at all**, including `ooo-board.ts`, so this says nothing about the round and is a separate pre-existing gap      |

So the module already behaves like a research instrument that happens to live in `src/`: nothing in
the product calls it, nothing in `tests/` calls it, no route owns it, no mutant guards it, and the
only thing that exercises it is the advisory research suites. Meanwhile the orchestration it contains
— prepare frozen work, claim, run the worker, verify the candidate against the frozen checks, compose
the changed files, run the parent check — is implemented a second time in
`evals/ooo-execution/plan-driver.ts` (`unitVerifier`, `runOneUnit`, `runParentCheck`), on the same
imports (`BoardAdmission`, `verifyCandidate`, `preparePatchWork`).

## Proposal

Three dispositions, each with the measurement that justifies it. The split is **not** "roles here,
mechanism there": the mechanism inside the module is 4 call sites, so there is nothing to split.

**Keep.** The shared primitives stay where they are — they are the product's, and both sides import
them: `ooo-board.ts` (admission, candidates, plan), `ooo-candidate.ts` (`verifyCandidate`),
`ooo-patch.ts` (`preparePatchWork`), `ooo-mutation.ts`, `ooo-round-log.ts`. The two types the product
consumes from the round module move to the module that owns their concept, which removes the last
`src/` → experiment edges:

- `WorkerMetrics` and `CycleWorker` → `src/integration/ooo-round-log.ts` (its only `src/` consumer);
- `Requirement` → `src/integration/task-semantics.ts` (its only `src/` consumer).

**Merge.** Two implementations become one:

- the candidate-verification orchestration: the round's `verifyPatch`/`patchVerifier`/
  `composedVerifier`/`compose`/`buildResult` and the driver's `unitVerifier`/`runOneUnit`/
  `runParentCheck` are the same responsibility over the same primitives, so it gets one home, and
  both the round and the arms' driver call it (each supplying its own plan, roles and reporting);
- the store/lease writes: the coordinator already owns them, so the round keeps only the port reads
  it needs and stops being a second writer path.

**Cut.** The S4 instrument leaves `src/`:

- the A/B/C role script (the 70 fixed-name references: `installA`/`installB`/`installC`,
  `dispatchPhase`, `outcome`, `reopenDependency`, `handlePushback`, `handleUnmetPrecondition`, …)
  and `openRoundStore` move to `evals/ooo-execution/` beside `plan-driver.ts`, together with the 11
  suites that pin them, so the instrument and its cases stay one thing;
- the store a round runs on is hosted the way D14 already hosts one for the drivers (through the
  daemon surface), not by a second opener.

Order: types first (they have product consumers), then the merge, then the move — and the ledger rows
that cite the moved suites (`C2`, `D10`, `D3` and friends) are updated in the same change, since a
citation is part of the obligation.

## Alternatives considered

- **Keep the module where it is.** Rejected: measured, it has no product caller, no route, no mutant
  and no `tests/` caller, and it duplicates the driver's orchestration. Leaving it in `src/` is a
  claim of product status that no evidence supports, and it keeps the two implementations apart.
- **Split the role layer from the mechanism layer.** Rejected **by measurement**: the mechanism
  inside the module is 4 store call sites in 3 symbols, while the role hard-coding is 70 references.
  A split would produce a tiny mechanism module and a large role module that nothing in `src/` calls —
  the same outcome as the cut, with an extra boundary to maintain.
- **Delete the instrument outright** instead of moving it. Rejected: it holds the only pins for
  several obligations (notably D10's early-cancel branch and C2's lease-boundary replay), and ~84
  cases that would have to be re-derived on the ordinary path first. Deleting is a later question,
  once the driver's cases cover those properties.
- **Generalise `runCycle` to arbitrary plans** (the 2026-09-17 alternative 乙). Still rejected: 42
  references to three fixed names made it a rewrite, and the driver now exists.

## Acceptance criteria

1. `rg "ooo-cycle" src/` returns only the module itself (after the type moves, no `src/` file imports
   it), and `npm run check` passes.
2. Every property the moved suites pin is still pinned, named: `early-cancel` (D10), `cancellation`
   (3 cases), `replay` (10), `notification` (4), `round-cli` (4), `round-plan` (6), `cycle` (46),
   `patch-cycle` (10). The evals suite runs green in the same change, first, not last.
3. The ledger's citations for the rows whose evidence moved name the new paths, and its counts still
   add up.
4. The merged orchestration is one implementation: the round and the driver both call it, and a test
   fails if either grows its own copy again (a named check, not a comment).
5. `npm run agent:verify` over the touched paths passes, and `npm run mutation:teeth` stays green
   (the module was not a target before and is not required to become one; if it becomes one, its
   mutants are named).

## Risks

- **The gate gets weaker, not stronger.** `evals/**` is in no `tsconfig` (the LSP is the only type
  gate) and its suites are advisory in CI, so moving a module there reduces its formal coverage. The
  measured counter-argument: today it is a mutation-target-less, route-less, `tests/`-less file whose
  only exercise is those same suites, so the move makes the real coverage explicit instead of
  implying product coverage. If the round's properties deserve blocking coverage, the honest fix is
  to pin them on the ordinary path (their owner), not to keep the file in `src/`.
- **The D and E arms may want the role machinery.** They are the reason the roles exist, and after the
  move they would have to reach into `evals/` — which is where those arms already live. This is the
  one place the current layout has an argument in its favour, and the reason the move keeps the role
  script intact rather than deleting it.
- **Two live facts could change the answer.** If a product path adopts `runCycle` (nothing does
  today), or if the arms' driver is retired in favour of the round (no evidence of that), the
  disposition should be re-read rather than followed.
- **An unrelated gap surfaced while measuring**: no route matches `src/integration/**`, including
  `ooo-board.ts` and `task-coordinator.ts`. That is a routing gap with its own decision, not part of
  this one, and it is recorded here only so the measurement above is not read as "the round is
  special".
