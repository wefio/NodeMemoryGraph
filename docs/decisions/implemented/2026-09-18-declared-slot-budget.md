# A run declares its slot budget, and a claim spends one - 2026-09-18

**Status:** implemented
**Approved:** explicit
Date: 2026-09-18
Branch: feat/ooo-run-namespace
**Relates to:** [task-unit semantics design](../../design/task-unit-semantics.md),
[its obligation ledger](../../design/task-unit-semantics-obligations.md),
[the arms get their own driver](2026-09-17-arms-get-their-own-driver.md)

治理 meta-rule：[self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) ——
本规则变更本身也是一次受治理的决策（决策 + 替代方案 + 一个规则一个家）。

中文版: [2026-09-18-declared-slot-budget.zh-CN.md](2026-09-18-declared-slot-budget.zh-CN.md)

## Problem

The design's C arm compares the same fine plan at a different **slot count** ("C 同一细计划、多槽 | 仅改变执行
槽数/合法顺序", `docs/design/task-unit-semantics.md:371`), and the design's main question has a concurrency
half. Building the arms' driver measured that the arm had no mechanism: with `slots: 4` on a plan whose
first three units are independent, the run reported `slotsUsed: 1` and refused the rest by name
("no published handoff for this task"). The measurement is in
[the ledger](../../design/task-unit-semantics-obligations.md#what-f2b-measured-a-run-can-hold-exactly-one-claim).

Three rules produced it, each in its own home:

1. `selectableTasks` (`src/integration/ooo-execution.ts`) returned `[]` while **any** unaccepted task was
   claimed. Its comment described a narrower **neighbour** rule ("a task whose earlier neighbour is still
   claimed blocks selection") that the code did not implement.
2. `publishReady` (`src/integration/ooo-board.ts`) published a handoff for the selected task only, and the
   claim refused any task that was not `next()` or had no published handoff.
3. The store serializes un-directed actionable entries per channel: an entry is `outstanding` only if no
   other open un-directed actionable exists, the next one is `pending`, and `claimTaskBoardEntry` refuses a
   `pending` entry until the outstanding one is claimed, resolved or expires (`src/core/store/base.ts`).
   That is the D14 boundary, chosen so one action faces an agent at a time (ledger, D14 row).

## Decision

A run **declares how many claims it may hold at once**, and a claim spends one of them. The count is
`slots`, default `1` — the rule the repository already had.

- `selectableTasks(plan, slots)` is the legal set the shared rules already made, minus the tasks already
  claimed, and it is empty while `claimed >= slots`. An ordering step may rank this set; it may not widen or
  narrow it. The claimed count is over the same pending tasks the previous rule counted.
- `startableTasks(plan, slots)` is that ordered set cut to `slots - claimed`, and it is the only part a
  claim licence may name. The cut is applied **after** ordering, so a ranking still decides which legal task
  comes first and a budget cannot hand the rule's own order the candidate pool.
- `deriveStatus(units, facts, slots)` reports the same cut as `ready`, so the status query and the start
  rule cannot disagree about what may be started.

Nothing else is relaxed. A claimed task's dependency is unaccepted while the claim is in flight, so a
dependent still cannot start early (`valid`/`ready` unchanged); "at most one task may be waiting on an
external event in the licensed forecast" is a different rule and is untouched; acceptance, the fences and
the leases are untouched. A claim is in flight until its task is accepted, which is what takes it out of
the pending set the budget is spent on.

## Alternatives considered

The C arm needs N claims to coexist, so the store's per-channel serialization had to be answered. Two ways
were available:

- **(a1) allow N outstanding un-directed actionables per channel.** This changes the product Task Board's
  push semantics — the pessimistic order D14 chose deliberately, whose purpose is that an agent has one
  action in front of it. Rejected: the cost is product-visible and the benefit is one experiment.
- **(a2) publish each unit's handoff directed at its own claimant.** A directed entry (`to != null`) is
  exempt from serialization by construction — the store's own comment on the rule says so: "Directed
  entries and notify-only kinds are not serialised (point-to-point, parallel-safe)". The store and D14 then
  stay exactly as they are, and each slot's work is offered point-to-point, which is what it already was:
  the driver's board owner is per task.

(a2) is the shape the next slice uses, so this record's decision costs one rule layer here. Rejected too:
**(b)** run F3 as A vs B only and record that concurrency is unreachable through this seam — the design's
main question has a concurrency half, so that would leave it unanswered while the cheap mechanism exists.

## Consequences

- Default `1` reproduces the previous behaviour exactly, so every existing assertion holds: the rule that a
  claim blocks selection is now `claimed >= slots`, which at one slot is the same predicate as before, and
  the product round passes no slot count at all. The rule's comment and the code now state the same rule.
- The status query becomes budget-aware. That is the only product-visible surface this touches, and at the
  default it answers what it answered before.
- What a run owes for a larger budget: it must have the handoffs published and directed, and it must not
  read a run that fell back to one claim as a multi-slot run. The arms' driver keeps reporting the
  requested and the reached count and refuses a time comparison when a requested count was not reached.
- Teeth: four named mutants on the new rule — a spent budget does not close selection, a claimed task stays
  on offer, the budget is not cut from the startable set, and zero or half a slot is accepted as a budget —
  each caught by the case that names it (`tools/mutation-teeth.ts`, target `src/integration/ooo-execution.ts`
  and `src/integration/task-semantics.ts`).

## Implementation state

The rule layer and the board layer are in, and no caller other than the arms' driver passes a count
other than the default, so no gate or switch changed for the product path.

- **Rules and status read**: `selectableTasks(plan, slots)`, `startableTasks(plan, slots)`,
  `nextTask(plan, slots)`, `remainingSlots(plan, slots)` and `deriveStatus(units, facts, slots)` in
  `src/integration/ooo-execution.ts` and `src/integration/task-semantics.ts`.
- **Admission**: `BoardAdmissionOptions.slots` (default 1, checked before the store is opened) and
  `handoffTarget`; a count above 1 without a target is refused by name. `publishReady` publishes a
  handoff for every startable task and keeps it across a republish, and the claim licence is
  `startable()`. With the default the publication is the un-directed broadcast handoff it was.
- **Driver**: `evals/ooo-execution/plan-driver.ts` declares the spec's slot count to the admission
  layer and names each unit's claimant with one function (`ownerOf`), so the offer and the claim
  cannot disagree. Its batch loop needed no other change, and it still reports a count it did not
  reach instead of reporting a time.
- **Evidence**: `evals/ooo-execution/board-slots.test.ts` (3 cases: two claims held at once and the
  store's own `serialState`/`to` as the reason they can be, the default licence being the head, and a
  claim's acceptance freeing a dependent while the other slot is held); `plan-driver.test.ts` replaces
  its "the requested slot count is not reached" case with one that reaches it and measures the
  overlap; `narrow-dispatch.test.ts` (6) and `tests/integration/task-semantics.test.ts` cover the rule.
- **Teeth**: 111 of 111 mutants caught by the named test, 17 of 17 targets restored. The new ones are
  the budget and claim-window mutants in `src/integration/ooo-execution.ts`, the
  licence/publication/target mutants in `src/integration/ooo-board.ts`, and the driver's declared
  budget.

The measured arm comparison is still owed: the spec pair for F2c and the paid pilot for F3 (a
separately fixed model, budget and repetitions).
