# The arms get their own driver, and the round stays one experiment - 2026-09-17

**Status:** implemented
**Approved:** explicit
Date: 2026-09-17
Branch: feat/ooo-run-namespace
**Relates to:** [task-unit semantics design](../../design/task-unit-semantics.md),
[its obligation ledger](../../design/task-unit-semantics-obligations.md),
[the F1 cost sweep experiment](../../experiments/execution/ooo-cost-model-2026-09-17.md)

治理 meta-rule：[self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) ——
本规则变更本身也是一次受治理的决策（决策 + 替代方案 + 一个规则一个家）。

中文版: [2026-09-17-arms-get-their-own-driver.zh-CN.md](2026-09-17-arms-get-their-own-driver.zh-CN.md)

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

- **`src/integration/ooo-cycle.ts` keeps its A/B/C roles on purpose.** They are the experiment's
  independent variables, not an accident: A's check is outstanding while B runs, which is the
  out-of-order decision the design is about. No further generalisation is planned.
- **The research driver consumes the shared layer, not this function**: the same `BoardAdmission`, task
  coordinator, run surface and round log, driven from `evals/ooo-execution/`.
- **If a product path ever needs arbitrary plans**, that is a separate governed decision with its own
  slice, and it must answer what this record did not: whether a general driver belongs in `src/` at
  all, or whether the product only ever drives plans a host declared.
- **The boundary is pinned by tests, not by a comment.** `evals/ooo-execution/round-plan.test.ts`
  asserts both refusals, so whoever generalises the driver will see those cases flip and can change
  them deliberately rather than discovering the coupling in a paid round.
- **The duplication is gone for good**: any future need for the default plan reads
  `DEFAULT_ROUND_PLAN`.
- **Deferred by the operator, not forgotten: whether the round's roles should be split from its
  mechanism.** Deleting `runCycle` outright would remove S4's instrument, its five regression suites,
  the ledger's D7/D10 evidence and the only end-to-end carrier of the out-of-order dispatch — and
  four shared types live in the file (`Requirement`, `CaseRule`, `CycleWorker`, `WorkerMetrics`). The
  measured shape of the choice is that the **role layer** is about 54 references in ~150 lines
  (`aInstruction`/`bInstruction`/`aEditable`/`bEditable`, the `Record<"A"|"B">` maps, `installA`,
  `installB`, `patchVerifier`, `casesTail`, and the `let a / let b` flow), while the claim-submit-verify
  core `runTask` is already task-id-parameterised. F2b and F3 run first; the evidence for the split is
  then how much of that core the research driver actually had to duplicate.
- **The driver names no task, and that is checked two ways.** The A/B/C coupling this record is about
  cannot come back through the driver: it contains no `"A"`/`"B"`/`"C"` literal (the case in
  `plan-driver.test.ts` reads the driver's own source and fails on one, and the registered mutant
  `the-driver-falls-back-to-a-named-task` introduces one to prove it), and behaviourally the same plan
  under other ids (`gamma`, `alpha-2`, `zz`, `join`) runs identically in the plan's declared order —
  which also fails if the driver ever sorts ids. The ids in the test fixtures are labels for the arms'
  units, not roles: they live in the spec, and `ooo-cycle.ts` keeps the only fixed roles.

## What building the driver measured: the C arm has no mechanism yet (2026-09-17)

The driver was built as declared and it can run the B arm (one slot, the legal set's head, each unit to
acceptance) and the A arm (a plan of one unit) offline. It **cannot** run the C arm, and that is a
measurement rather than an unfinished slice:

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

So the driver reports `slotsRequested`, `slotsUsed` and `slotRefusal` on every run, and
`comparePlanSlots` sets `comparable: false` — refusing a time verdict — whenever a requested slot count
was not reached. A fallback run cannot be reported as the C arm, whatever the wall clock says. The
decision that follows is the operator's and is not taken here: either relax the per-run serialization
for a declared slot count (the comment above `selectableTasks` already describes a _neighbour_ rule,
which is narrower than the code's "any claim blocks selection"), or run F3 as A against B and record
that deterministic concurrency is unreachable through this seam. Until then the C arm is **blocked**,
not "not started".

## Verification

- `evals/ooo-execution/round-plan.test.ts` — 6 cases: the log names the plan it was given (checked by
  reverting the log to the literal `["A","B","C"]`, which fails it), the two refusals above, one plan
  value reaching both the store and the round, the spec mapping with its defaults, and the parser's
  refusals.
- `evals/ooo-execution/cycle.test.ts` — 23 cases, unchanged and green: the driver's behaviour is
  preserved.
