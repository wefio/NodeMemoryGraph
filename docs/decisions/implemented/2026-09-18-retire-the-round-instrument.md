# Retire the round instrument: distribute what has a home, delete the rest

[中文](2026-09-18-retire-the-round-instrument.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [task-unit-semantics design](../../design/task-unit-semantics.md),
[its obligations ledger](../../design/task-unit-semantics-obligations.md),
[the arms get their own driver](../implemented/2026-09-17-arms-get-their-own-driver.md),
[the declared slot budget](../implemented/2026-09-18-declared-slot-budget.md)

Governing meta-rule: [self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md).
This record replaces the disposition draft committed as `7821c5ed` ("keep / merge / cut"), which asked
whether to split the round's role layer from its mechanism; measurement answered that question and the
operator then chose distribution plus deletion over relocating the module.

## Problem

`src/integration/ooo-cycle.ts` (1 082 lines, 13 exports) is the S4 out-of-order instrument. The
[2026-09-17 decision](2026-09-17-arms-get-their-own-driver.md) deferred its disposition on purpose, and
the ground has moved since: the arms have their own driver, the daemon has a run surface (D13), the
coordinator owns coordinated writes and the run-entry binding (D11/D12), and the ordinary collaboration
path no longer needs a round (G1).

Measured over `src/`, `evals/`, `tests/`, `tools/` (556 files; the one-off script and its JSON are in
untracked `.temp/`, because they are not a maintained entry point):

- **70** references to the round's fixed A/B/C names, over **17** of its 44 internal symbols;
- only **4** calls into the store/board port inside the module, so the "role layer versus mechanism
  layer" framing had almost no mechanism to split — that alternative is rejected by measurement;
- `runCycle` and `openRoundStore` have **9 callers each, all under `evals/ooo-execution/`**; no `tests/`
  caller; the only `src/` callers are type imports;
- it is **not** a registered mutation target, although its siblings are (17 targets);
- its candidate-verification orchestration is implemented a **second time** in
  `evals/ooo-execution/plan-driver.ts` over the same imports.

The decisive question was whether the round carries a capability the driver lacks. It does not, for the
property the design is about. A one-off probe (`.temp/ooo-interleave-probe.ts`) ran a two-unit plan at
two slots where unit A's check sleeps ~3 s: B's worker window **1505 ms sits entirely inside A's check
window 3923 ms**, with `slotsUsed=2` and order `A-start, A-end, B-start, B-end`. "A's check is
outstanding while B works" is therefore expressible in the driver's own vocabulary of plan, slots and
per-unit checks — no roles required.

## Decision

Distribute the pieces that have a home, then delete the module and everything that only served it.

**Moved to its concept owner (the only two `src/` consumers the file had):**

- `Requirement` → `src/integration/task-semantics.ts`, which already defines preconditions over a
  dependency's accepted artifact and is the file that imported the type;
- `WorkerMetrics` → `evals/ooo-execution/plan-driver.ts`, its sole surviving consumer once the round and
  `ooo-round-log.ts` are gone. The product's run surface records no worker metrics today (measured: no
  `tokens`/`metrics`/`cost` in `src/integration/ooo-execution.ts`), so keeping a product home for it
  would be unused product surface.

**Evidence re-homed, because the implementer is product and only the harness was the round:**

- D9 (a post-commit notification failure is recorded, not thrown) is implemented by
  `src/integration/ooo-board.ts` (`lastNotificationFailure()`), not by the round. The evals suite said so
  itself: it drove a real round only because the artifact envelope is the board's business. The property
  is pinned on the board instead, in `tests/` where a product obligation belongs, and the hand mutation
  (drop the guard around the post-commit notification) must still fail it.
- The S4 interleaving gets its own case in `evals/ooo-execution/plan-driver.test.ts`: with two slots, one
  unit's worker runs while another unit's check is outstanding. This is the first end-to-end pin of that
  property on the mechanism the arms actually use; it fails if the driver's batch loop stops overlapping.

**Deleted (no home, nothing in `src/` calls it):**

- `src/integration/ooo-cycle.ts` and `src/integration/ooo-round-log.ts`;
- in `evals/ooo-execution/`: `round-runner.ts`, `round-compare.ts`, `round-spec.ts`, `live-cycle.ts`,
  `probe-check-duration.ts`, and the suites `cycle.test.ts`, `replay.test.ts`, `notification.test.ts`,
  `round-plan.test.ts`, `round-cli.test.ts`, `cancellation.test.ts`, `early-cancel.test.ts`;
- `DEFAULT_ROUND_PLAN` and the types with no surviving consumer (`CaseRule`, `CycleWorker`,
  `CheckRunner`, `CycleOptions`, `CycleResult`, `OooRoundOperations`, `WorkerResult`,
  `CheckOutcomeSummary`) — the 2026-09-17 record's five shared types reduce to the two that moved.

**Kept, and checked to be independent of the round:** `plan-driver.ts` and its suite, `round-client.ts`
and `round-host.ts` (D14's daemon evidence, which serve a store, not a round), `board-*.ts`,
`board-slots.test.ts`, `narrow-dispatch.test.ts`, `patch-cycle.test.ts`, `cost-model*`,
`families.test.ts`, `live-patch.ts`, `live-continuation.ts` (G7's executable check — measured to import
nothing from the round), `pilot.ts`, `rename-probe.ts`, `report-family.test.ts`.

**Ledger, in the same change:** D10 is rewritten as "no counterpart can fail" (the row's own wording was
about `runCycle`'s early-cancel branch, and with no round nothing borrows a store to close — the B7
precedent); D9's evidence names the board test; G4's cancel half points at the product test that already
covers it (`tests/integration/ooo-round-query.test.ts`, "the terminal decision outlives the host that
made it"); the ledger's stale closing paragraph is corrected. Nothing else cites the retired suites: of
the ~84 cases, only those three were obligation-bearing.

## Alternatives considered

- **Keep the module where it is.** Rejected: no product caller, no route, no mutant, no `tests/` caller,
  a second implementation of the driver's orchestration, and an instrument's subject in `src/`.
- **Split the role layer from the mechanism layer.** Rejected by measurement: 4 store call sites against
  70 role references, and the interleaving the roles existed for is already carried by the driver.
- **Relocate the module and its suites to `evals/` (the draft's "cut").** Rejected by the operator: it
  would create a 1 082-line module that nothing owns, and it preserves machinery whose only consumer was
  the round.
- **Keep `round.jsonl` replay and compare as research method.** Rejected by the operator: `plan-driver`
  replaces `round-runner`/`round-compare`, and the design already classes `round.jsonl` as an export ("可
  导出作研究重放", a file that decides no state), so replay served the instrument, not the product.
- **Delete outright without re-homing.** Rejected: D9's evidence and the interleaving property would go
  with it, and both can be pinned cheaply on the mechanisms that remain.

## Consequences

- `src/` no longer contains an experiment file; the round's 1 082 lines leave the product tree and the
  driver is the one research-side runner.
- The retry machinery the round carried — pushback, reopened dependencies, unmet preconditions,
  `handlePushback`/`reopenDependency`/`handleUnmetPrecondition` — is gone. No ledger row pinned it, and
  no product path used it, but the design's E arm (budgeted speculation) may need "discard and redo"; if
  it does, that is the E arm's own requirement, implemented on the driver, not a reason to keep this file.
- The ability to replay a real run from `round.jsonl` goes with it. Archived runs
  (`docs/experiments/execution/*`) remain as evidence of the experiments that happened; re-running them
  would mean rebuilding an export path for the driver.
- The `evals/` suite count drops by the twelve retired files, and the surviving driver suite carries the
  property the round was the only end-to-end carrier of.

## What the change was verified against

1. `rg "ooo-cycle" src evals tests tools` returns nothing (the name survives only in experiment records
   and decisions, where it describes history).
2. The board's post-commit notification test fails if the guard is removed, and D9's evidence names it.
3. The driver's interleaving case fails if the batch loop stops overlapping units.
4. `DEFAULT_ROUND_PLAN` and the eight unreferenced types have no remaining reference anywhere.
5. `npm run check`, `npm run docs:check`, `npm run test:product`, the surviving `evals/ooo-execution/`
   suites, `npm run mutation:teeth` and `npm run agent:verify` over the touched paths all pass.

## Risks

- **The instrument's own contract net is gone** (about 62 cases). They pinned the round's behaviour, not
  a design obligation, and `tests/` never covered the module; the replacement is the driver's own suite
  plus the two re-homed pins. If a future arm needs the round's semantics, it is rebuilt deliberately.
- **Two kinds of history now lack a live counterpart**: `early-cancel`'s branch and the replay format.
  Both are recorded as retired here rather than left as a stale row pointing at deleted files.
- **A separate pre-existing gap surfaced while measuring**: no route in `agent-context.yaml` matches
  `src/integration/**`, `ooo-board.ts` and `task-coordinator.ts` included. That is its own decision; it
  is named here only so this record's measurements are not read as "the round was special".
