# F. Later phase: the experiment arms

[中文](experiment-arms.zh-CN.md) · [Terms used](experiment-arms.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.md).

## F. Later phase: the experiment arms

The A–E arms have offline evidence and paid measurements where the design calls for them. The offline model checks semantics and cost shape; it does not predict real-model quality. Paid results remain bounded by their model, task family, instrument and sample size; the linked experiment records own the numbers and caveats.

| Step | State | Evidence boundary |
| --- | --- | --- |
| F1: advisory offline cost model | Proven | `evals/ooo-execution/cost-model.ts`, its tests and the [sweep record](../../experiments/execution/ooo-cost-model-2026-09-17.md). The sweep owns the cost predictions; do not treat them as paid measurements. |
| F2a: one plan source | Proven | `PlanDriverSpec.plan` is the driver input and the frozen run manifest is the persisted plan. Round-specific carriers were retired with the old instrument ([decision](../../decisions/implemented/2026-09-18-retire-the-round-instrument.md)); the driver decision records the single-home choice ([decision](../../decisions/implemented/2026-09-17-arms-get-their-own-driver.md)). |
| F2b: arbitrary legal plans | Proven | `evals/ooo-execution/plan-driver.ts` takes its ordered legal set from `BoardAdmission.candidates()`. `plan-driver.test.ts` and the registered mutations cover the driver; it must not re-derive legality. |
| F2c: parent-family selection | Proven | The coarse and fine report families are exercised by `evals/ooo-execution/families.test.ts`; the `pipeline` family was held out until after the driver. The parent check composes child acceptance, and a failed child check rejects the parent. |
| F2b-slot: declared concurrency budget | Proven | `slots` defaults to 1; the ordered startable set is cut to the declared budget. Budgets above 1 require `handoffTarget`, so each actionable handoff is directed. Coverage is in `board-slots.test.ts`, `narrow-dispatch.test.ts`, `plan-driver.test.ts` and `tests/integration/task-semantics.test.ts`; the [decision](../../decisions/implemented/2026-09-18-declared-slot-budget.md) owns the policy. |
| F3: real-model A/B/C pilot | Measured; directional only | The pilot used `deepseek/deepseek-v4-flash`, A=3, B=3, C=2, eight runs and 23 model calls; all eight parent checks accepted. One model and one held-out family provide no general quality comparison. See the [pilot record](../../experiments/execution/ooo-arms-pilot-2026-09-18.md). |
| F4: fusion legality, accounting and session policy | Proven offline; live mechanism measured | The shared rules and driver policy are exercised by the fusion tests. `createPiSessionRunner`, `piSessionWorker` and `--session-runner` supply session reuse across units. In the six-run D arm, quality was equal; the ~1.9 s median wall difference was smaller than the 2.2 s within-arm spreads, while tokens were effectively tied. The separate four-unit cap experiment measured an 8.451 s wall saving in the two-rep pair; the third rep used a newer prompt, and token/cost comparisons remain unresolved. See the [pilot](../../experiments/execution/ooo-arms-pilot-2026-09-18.md) and [archive](../../experiments/execution/archive/ooo-arms-2026-09-19/README.md). |
| F5: bounded speculation lifecycle | Proven offline; paid E arm measured with no gain | One declared pending fact, no speculative successor and no irreversible operation are the first-arm bounds. `speculationOutcome` publishes on true, discards and closes the branch session on false, and waits on unknown. The E arm ran twice; the evidence-backed run had 0/3 publishable candidates when the fact held, so no speedup or gain is claimed. See the [pilot](../../experiments/execution/ooo-arms-pilot-2026-09-18.md) and [archive](../../experiments/execution/archive/ooo-arms-2026-09-19/README.md). |

### Historical F2b single-claim probe

The first driver probe found that a run could hold only one claim. That was the measured precondition for F2b-slot, not the current slot-budget contract. See [the probe and its later status](experiment-arms/single-claim-experiment.md).
