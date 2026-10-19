# Declaration storage and recovery

[中文](declaration-storage-and-recovery.zh-CN.md) · [Terms used](declaration-storage-and-recovery.terms.yaml)

**Status:** draft

**Authority:** [Task-Unit scope](../task-unit-semantics.md) and [declaration ownership decision](../../decisions/implemented/2026-10-02-declarations-have-one-owner.md).

## Default declaration authority

Declaration semantics and encoding belong to the protocol; execution freezing and restoration belong to its adopter. The store supplies one connection and transaction, while the board interprets coordination state, not another task body.

The default Task-Unit types, DDL, reads/writes and normalized equality belong to [task-unit-declaration-store.ts](../../../src/integration/task-unit-declaration-store.ts). `task_run_tasks` remains the sole task definition. Existing store methods are default-adapter compatibility forwarding, not a field contract every protocol must adopt.

## Frozen input receipts

Within the claim transaction, the default patch adopter records original input bytes, explicit budget/limits, permitted conclusion kinds and the execution declaration digest in a `task_run_facts` receipt of kind `task-unit.patch-inputs-frozen`, located by run/task/attempt.

Descriptions, dependencies and permission lists still come from the frozen task row; neither the receipt nor the board body duplicates those definitions. The claim, input receipt and claim fact commit together. Any freezing failure rolls back the entire transition. Legality and recovery queries do not backfill facts.

## Restoration and refusals

Restore the corresponding attempt from its original inputs and parameters and verify its declaration digest. Unknown receipt versions, invalid fields, mismatched digests or a missing receipt at acceptance are explicit refusals, not reasons to use the current workspace as fallback.

The host still supplies initial inputs for unclaimed tasks and re-supplies acceptance callbacks. A receipt does not persist functions or prove acceptance configuration was restored. Plan, execution declaration and delivered artifact retain distinct digest identities.

The ownership decision explains why typed tables are retained rather than copied into JSON. Peer-envelope protocol fields and payload migration remain a separate scope.
