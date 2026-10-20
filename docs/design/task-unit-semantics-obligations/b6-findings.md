# B6 finding: managed writes and the runner integration gap

[中文](b6-findings.zh-CN.md) · [Terms used](b6-findings.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.md).

## B6 finding: managed writes and the runner integration gap

B6 requires a lifecycle write on a managed entry to update the board and append its run fact in the same coordinated transaction. A generic board verb is also the normal way to claim, deliver, judge and resolve an ordinary unbound handoff, so rejecting every such verb would break the product path. The Store must decide whether an entry is managed from its recorded binding, not from the caller's assertion.

The current daemon path records `entry-bound` through `bindRunEntry()` and creates/adopts an entry through `createBoundEntry()` in one transaction. `coordinatedEntryWrite()` routes lifecycle verbs for adopted entries through the coordinator; direct writes outside that scope are refused. The transaction port joins the board update and run fact atomically. An unbound entry continues to use the ordinary board path. See the [run-record design](../task-unit-semantics/run-record-ownership.md) and D11–D13 in the [lifecycle evidence](lifecycle-and-integration-prerequisites/host-lifecycle-run-records-and-daemon-clients.md).

The evidence has two paths. The research-instrument test `tests/integration/ooo-managed-fence.test.ts` reaches `BoardAdmission` directly because its caller-side `live()` check could refuse first and mask a broken Store guard; its commit-window case retires the claim during verification so `commitArtifact()` must re-check afterward. That test proves only the research board's fence. Product-path tests `tests/integration/ooo-managed-adopt.test.ts` and `tests/integration/ooo-managed-write.test.ts` exercise atomic create-and-bind, refusal cases, and the board transition/run fact succeeding or failing together through the daemon coordinator. Neither path proves that every research runner is integrated.

## Research-runner boundary

The research drivers still use separate storage paths: `plan-driver.ts` constructs `BoardAdmission` with its research `databasePath`, while `live-continuation.ts` opens `NmgStoreBase` directly. Neither uses daemon `taskRun`, so their writes do not pass through the managed-entry coordinator. The evidence drivers' daemon-client boundary is a separate D14 result and does not close this runner gap. A managed-write proof for the daemon must not be reported as proof that these research runners are integrated.

The rule's design owner is [run-record ownership](../task-unit-semantics/run-record-ownership.md); current proof rows are in the [persistence ledger](persistence.md). The optional source-level mutant names are maintained in [`tools/mutation-teeth.ts`](../../../tools/mutation-teeth.ts).
