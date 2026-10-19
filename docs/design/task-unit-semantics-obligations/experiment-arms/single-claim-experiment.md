# Historical F2b probe: one claim at a time

[中文](single-claim-experiment.zh-CN.md) · [Terms used](single-claim-experiment.terms.yaml)

**Authority:** [Parent scope](../experiment-arms.md).

## Historical F2b probe: one claim at a time

This record captures the first F2b driver probe, before the slot-budget decision. Its single-claim result is not the current contract: F2b-slot later added declared concurrency. The current policy is in the [slot-budget decision](../../../decisions/implemented/2026-09-18-declared-slot-budget.md) and the parent [F2b-slot row](../experiment-arms.md).

The original probe tried to run the fine plan in **N slots**. With `slots: 4` and three independent leading units, `plan-driver.ts` reported `slotsUsed: 1` and `slotRefusal: "wanted 4 slots, the board allowed one: no published handoff for this task"`. Three constraints caused this result at that time:

1. `selectableTasks` returned `[]` while any unaccepted task was claimed.
2. `publishReady` offered a handoff only for the selected task, and `claimableRow` refused a task that was not `next()` or had no handoff.
3. The board serialized actionable entries per channel; an undirected second handoff could not bypass that boundary.

The direct probe showed the transition: with nothing claimed, `candidates()` returned `["first","second"]`; after claiming `first`, it returned `[]` and `claim("second")` failed with `no published handoff for this task`; after `first` was accepted, `second` became claimable. Sequential execution still completed four units, four host checks and the parent check.

Two alternatives did not isolate the design's C arm, which changes only the slot count and legal order. Concurrent runs on one store allowed two claims, but also changed the channel, plan and serialization. Generating work without a claim contradicted the contract that an atomic claim/fence grants execution authority.

The 2026-09-18 decision chose a declared slot budget. The Store's per-channel serialization remains; when the budget exceeds one, directed handoffs let each startable task be claimed. `comparePlanSlots` refuses a time verdict when the requested slot count was not reached (`slotShortfalls` and `comparable: false`). Thus the original probe motivated the budget but does not describe current `publishReady` behavior.

The offline model predicted that one slot buys nothing, a chain or two-unit refinement loses at each granularity, and a saving in B would contradict the sweep. It has no quality term and fixes no model, budget or repetition. The paid pilot's evidence and limits are in the [pilot record](../../../experiments/execution/ooo-arms-pilot-2026-09-18.md); no gain beyond that record may be claimed.
