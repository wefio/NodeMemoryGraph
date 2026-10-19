# G. Product entry: collaboration and the OoO evidence boundary

[中文](collaboration-product-entry.zh-CN.md) · [Terms used](collaboration-product-entry.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.md).

## G. Product entry: collaboration and the OoO evidence boundary

The intended product entry is an ordinary task-board handoff, not a dedicated `ooo` tool, channel, second task body or `board.runRound` wrapper. The [shared-layer and board design](../task-unit-semantics/shared-layer-and-task-board.md) owns that boundary. This ledger distinguishes product-path evidence from `BoardAdmission` research evidence; a passing research test does not prove a product caller exists.

| Node | Obligation | State | Evidence and limit |
| --- | --- | --- | --- |
| G1 | An ordinary product handoff reaches shared task semantics, execution and acceptance without `ooo_round` | Partly | The ordinary Pi path uses `nmg_board`, but `tests/integration/ooo-ordinary-handoff.test.ts` constructs `BoardAdmission` and proves the research instrument path. The [product call-path audit](product-call-path-audit-2026-09-20.md) does not establish a product caller for `dispatchPlan` or `task-semantics.ts`. |
| G2 | Accepting a product task releases a dependent only after the dependency is accepted | Owed | The product-path audit shows a managed task J with dependency P can be claimed through `taskRun` without producing or accepting P. `BoardAdmission`'s `deriveStatus` test proves the research path, not product dependency admission. |
| G3 | Product failure/cancellation preserves only the accepted prefix and the declared fallback order | Partly | `ooo-ordinary-failure.test.ts` and the finite model cover the research path. The daemon `taskRun` API records run/task cancellation, but its status returns raw facts and the product path is not wired to the research dispatch/derivation loop. |
| G4 | Run status and cancellation are reachable through the daemon surface | Proven, for raw run records | `tests/cli/task-run-surface.test.ts` exercises `taskRun` through the service. `taskRunStatus` returns manifest, tasks, facts and bindings; it does not derive ready/blocked/accepted. `ooo-round-query.test.ts` is a separate research-instrument read-path test. |
| G5 | Remove the dedicated `ooo_round` product tool and keep the ordinary board entry | Proven | The extension registration and its tests no longer expose `ooo_round`; `nmg_board` remains the handoff entry. `evals/ooo-execution` and `npm run ooo:round` are research surfaces, not product tools. |
| G6 | Keep task/run truth in typed facts and board state; do not let a model patch `accepted`, leases or cancellation as a second editable state | Partly | `task_run_*` tables, typed `taskRun` writes and the managed-write fence keep product run facts and board lifecycle under Store-owned transitions. The product API has no derived Task-Unit view yet; the research projection tests do not prove one is wired into the product. |
| G7 | Measure a real continuation using a second Agent session, retrieved evidence and the fixed parent check | Measured on the research path | The [2026-09-14 continuation experiment](../../experiments/execution/ooo-real-continuation-2026-09-14.md) accepted 4 of 5 tasks end to end; one continuation failed with an unparseable patch and its parent received no verdict. `live-continuation.ts` owns a research `NmgStoreBase`; this is experiment evidence, not product-runtime proof. |

The current product boundary is therefore narrower than the research design: ordinary board operations and daemon run records exist, but product dependency scheduling through the shared task semantics remains open. Do not turn the research measurements into a claim that a general multi-Agent runtime is enabled.
