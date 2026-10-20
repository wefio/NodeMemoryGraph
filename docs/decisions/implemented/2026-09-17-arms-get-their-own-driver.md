# The arms get their own driver, and the round stays one experiment - 2026-09-17

**Status:** implemented
**Approved:** explicit
**Superseded by:** [The dispatch loop is shared](2026-09-19-dispatch-loop-is-shared.md), [Retire the round instrument](2026-09-18-retire-the-round-instrument.md)
**Relates to:** [task-unit semantics design](../../design/task-unit-semantics.md),
[its obligation ledger](../../design/task-unit-semantics-obligations.md),
[the F1 cost sweep experiment](../../experiments/execution/ooo-cost-model-2026-09-17.md)

治理 meta-rule：[self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) ——
本规则变更本身也是一次受治理的决策（决策 + 替代方案 + 一个规则一个家）。

中文版: [2026-09-17-arms-get-their-own-driver.zh-CN.md](2026-09-17-arms-get-their-own-driver.zh-CN.md) · [Terms used](2026-09-17-arms-get-their-own-driver.terms.yaml)

Later disposition: The shared dispatch decision moved the execution loop out of the arm driver, and the round-retirement decision deleted `src/integration/ooo-cycle.ts` and its round-specific suites. The measurements and choices below describe their dated snapshots, not current source inventory.

## Problem

The design's A–D arms compare **different granularities** on the same parent task: A is the original
parent task, B and C are a legal refinement of it. A refinement is a _different plan_, so the arms need
a round that can run an arbitrary legal plan. The only round the repository has was written for one
specific experiment.

```
const plan: ProbePlan = [
  ["A", "", [], "isolated-artifact", "protocol-regression", null],
  ["B", "", [], "isolated-artifact", null, null],
  ["C", "", ["A", "B"], "isolated-artifact", null, null],
];
```

That plan looked like a constant to parameterise, and the first plan for this slice said exactly that:
"make `plan` an option and the arms become data". Measurement refuted it.
`src/integration/ooo-cycle.ts` is 1 063 lines with **42** references to the three fixed names:

| Kind                | Examples                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Option shape        | `aInstruction` / `bInstruction` / `aEditable` / `bEditable` — two patch tasks, by name   |
| Per-task maps       | `noChangeCases?: Record<"A" \| "B", …>`, `mutations`, `visible`, `admitted`, `requires`  |
| Roles in the flow   | issue **A**'s check, run **B** while it is outstanding, repair **A**, promote **C**      |
| Invariants threaded | `"A" \| "B"` through the patch verifier, the case resolution and the unmet-premise check |

The driver _is_ the experiment, so generalising it is a rewrite rather than a rename. A second, smaller
hazard came out of the same reading: the research runner
(`evals/ooo-execution/round-runner.ts`) carried a **byte-identical copy** of that plan as `ROUND_PLAN`,
and another process cancels and queries a round by opening the store the plan shaped — so a copy that
drifted would let an operator fence a round whose plan is not the one it is running.

## Decision

**The arms get their own research-side driver in `evals/ooo-execution/`, and
`src/integration/ooo-cycle.ts` stays the specific external-window experiment it is.** The design's own
ordering decides it: "先做语义判定，**不先搭建通用调度平台**", and "研究枚举与成本模拟保持 advisory". A
generic plan-driven scheduler on the product side is exactly the platform that sentence postpones, and
the arms are research.

In the same change, the plan's **legibility half** landed, because the drift hazard is real and
independent of any driver:

- `DEFAULT_ROUND_PLAN` is exported once from `src/integration/ooo-cycle.ts`; `ROUND_PLAN` is gone, and
  the runner imports the one home instead of re-declaring it.
- `CycleOptions.plan?: ProbePlan` is the plan a round runs, and the round's log names **the plan it was
  given** instead of the literal `["A","B","C"]` — a report that disagreed with the run would be worse
  than no report.
- `openRoundStore(databasePath, plan)` opens a store for a plan, so a store and its round can share one
  value.
- A spec may declare `plan`, so a plan is data rather than an edit to a research script (S3's goal).
  The parser checks **shape only**: what a plan may contain — duplicate ids, unknown dependencies,
  self-dependencies, cycles, permission widening — stays the shared compiler's to refuse, in one home.

## Alternatives considered

**乙: generalise `src/integration/ooo-cycle.ts` to arbitrary plans.** Rejected for now, for the 42
couplings above and for the design's ordering: it would turn a named experiment into a general
scheduler on the product path before the semantics are settled, and it would put the arms' needs into
the product's own driver. It is not rejected forever — see the consequences.

**Leave the plan as a constant and express granularity inside the existing A/B roles.** Rejected as
dishonest: the coarse arm would have to be "the same three units with a bigger instruction", which is
the design's own negative example ("仅把测试分成普通与边界两组、串行换会话，不能证明发现并发"). It would
spend tokens on a comparison that cannot answer the question.

**Make the plan injectable and stop there (no new driver).** Rejected as insufficient, and the tests
now say why: a four-unit plan with no `A`/`B`/`C` roles fails with `plan refused by the shared
semantics: … a patch spec exists for a task that is not in the plan`, and so does a plan whose join is
renamed from `C`. The legibility half alone cannot run the arms.

## Consequences

- At this decision's snapshot, `src/integration/ooo-cycle.ts` kept A/B/C roles as the experiment's
  independent variables: A's check was outstanding while B ran. The instrument and its round-specific
  roles were later retired; this is not a statement about current source.
- The research arm driver consumed shared task/board rules. The later [shared-dispatch decision](2026-09-19-dispatch-loop-is-shared.md)
  also moved the plan-dispatch loop into the shared layer; the arm-specific declarations and measurements
  remain in `evals/ooo-execution/`.
- **If a product path ever needs arbitrary plans**, that is a separate governed decision with its own
  slice, and it must answer what this record did not: whether a general driver belongs in `src/` at
  all, or whether the product only ever drives plans a host declared.
- At this decision's snapshot, `evals/ooo-execution/round-plan.test.ts` pinned the two plan refusals and
  the default plan was centralized as `DEFAULT_ROUND_PLAN`. The round-retirement decision later removed
  that suite and constant with the instrument; the claims here are historical, not current test coverage.
- **Resolved 2026-09-18: role/mechanism split.** The operator chose distribution plus deletion rather
  than splitting the roles from their mechanism; see [the retirement decision](2026-09-18-retire-the-round-instrument.md).
  The original estimate was that deleting `runCycle` would remove S4's instrument, five regression
  suites, D7/D10 evidence and the end-to-end out-of-order carrier, while four shared types remained in
  the file. The measured role layer had about 54 references in ~150 lines; the core `runTask` was already
  task-id-parameterised. These counts explain the dated choice and are not a current module inventory.

## What the driver measured on 2026-09-17: the C arm was blocked at that snapshot

At that snapshot, the driver could run the B arm (one slot, the legal set's head, each unit to
acceptance) and the A arm (a plan of one unit) offline, but it **could not** run the C arm. This was a
measurement of the then-current claim path, not an unfinished slice:

- `BoardAdmission.candidates()` returns the ordered legal set — `["first","second"]` for two
  independent units — but it returns `[]` the moment one of them is claimed, and `claim("second")`
  then raises `no published handoff for this task`. After the first unit is accepted, `candidates()`
  returns `["second"]` and the claim succeeds. Sequential execution is otherwise unaffected: four
  units, four host checks, the parent accepted.
- The rules that produce it live in three places, each already documented: `selectableTasks`
  (`src/integration/ooo-execution.ts`) returns `[]` while any unaccepted task is claimed — pinned by
  the registered mutant `a-live-claim-does-not-block-selection` — `publishReady` publishes a handoff
  for the selected task only, and `claimableRow` refuses anything that is not `next()`.
- The design asks for the slot count to be the _only_ difference between B and C ("C 同一细计划、多槽 |
  仅改变执行槽数/合法顺序"), so the two alternatives that need no shared-layer change do not satisfy it:
  N concurrent **runs** on one store works (measured: two `BoardAdmission` instances on one database
  each held a claim at once) but changes the channel and the plan; and generating a candidate without
  a claim contradicts the design's own rule that the atomic claim is what grants execution authority.

The driver reported `slotsRequested`, `slotsUsed` and `slotRefusal`; `comparePlanSlots` set
`comparable: false` whenever the requested count was not reached, so fallback runs could not be reported
as the C arm. The [declared-slot-budget decision](2026-09-18-declared-slot-budget.md) later added a
per-run multi-slot claim budget and directed handoffs, resolving this mechanism blocker. That change did
not itself establish a paid C-arm comparison; the later F3 pilot reports the comparison, directionally
only, in [its experiment record](../../experiments/execution/ooo-arms-pilot-2026-09-18.md).

## Verification at the 2026-09-17 snapshot

- `evals/ooo-execution/round-plan.test.ts` — 6 cases: the log named the supplied plan, the two refusals
  above, one plan value reached both store and round, and the spec mapping/parser cases passed.
- `evals/ooo-execution/cycle.test.ts` — 23 cases, unchanged and green at that snapshot.

Both suites were removed with the round instrument on 2026-09-18; this is historical verification, not a current test inventory.

## What the later supersession leaves standing

Later records supersede separate parts of this decision: [the shared-dispatch decision](2026-09-19-dispatch-loop-is-shared.md)
moved plan execution to the shared layer, and [the retirement decision](2026-09-18-retire-the-round-instrument.md)
deleted the old `ooo-cycle` instrument and its suites. What remains is the arm-specific declaration and
measurement record; the product still does not own a general planning platform.
