# Remaining obligations and decisions

[中文](remaining-obligations.zh-CN.md) · [Terms used](remaining-obligations.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.md).

## Remaining obligations and decisions

The store-owned run-record path is implemented; the research runner is not wired to it. Do not collapse those into one completion claim.

## Current product boundary

The daemon owns product run manifests, task rows, facts and bindings. `taskRunStatus` returns those records; it does not derive `ready`, `blocked` or `accepted`. `task-coordinator.ts` fences managed board transitions and records the matching run fact in the same transaction. The daemon's ordinary board verbs route managed entries through that coordinator, while unbound handoffs keep their ordinary path.

The product call-path audit found no caller of `dispatchPlan` or `task-semantics.ts`; it also showed a dependent task can be claimed through `taskRun` without its dependency first being accepted. Consequently G2 remains owed, and the product-side shared-semantics/dispatch path is not complete.

The research paths remain separate: `evals/ooo-execution/plan-driver.ts` constructs `BoardAdmission` with its research `databasePath`, and `live-continuation.ts` opens `NmgStoreBase`. The evidence drivers `board-worker.ts`, `board-deliver.ts` and `board-judge.ts` use `round-client` to reach board verbs through `round-host`; that daemon-client boundary does not make `plan-driver` or `live-continuation` clients of product `taskRun`. B6's remaining work is therefore the runner integration, not another store guard or a second public write verb.

## Open design obligations

- **Product task semantics:** decide and implement whether the ordinary product handoff should call the shared task compiler/dispatcher, then make dependency acceptance, failure, cancellation and ordered fallback follow that path. Until then, G1 and G3 are only partly covered and G2 is owed.
- **Product task view:** the product API currently exposes raw run/task/fact/binding records, not a derived `TaskUnit` view. Keep Task IR as a proposed read-only internal view; do not add a second persisted or model-editable task truth. G6 is partly covered by the run-record and managed-write boundaries.
- **Research-runner adoption:** if the research runner is to move to the daemon, it must use the existing `taskRun` and managed-board operations. Keep its current evidence labelled as research-only until that integration is implemented and tested.
- **Optional HA/MGR:** the adviser port and nine offline seam proofs do not connect an HA or MGR implementation, change a gate or enable a switch. Any such connection needs a separately owned design and evidence.

## Completed boundary work and historical evidence

D11–D13 establish Store-owned run records, coordinated writes, managed-entry binding and the daemon `taskRun` surface. D14 establishes a daemon-client route for the evidence drivers, not for the research plan/continuation runners. The [product-entry ledger](collaboration-product-entry.md) gives the row-level scope.

The old round instrument was retired on 2026-09-18. D7 and D10 are not applicable to that removed subject; the [historical D7 conversion findings](d7-findings.md) do not validate the current product path. B7 has no failure to test because this branch has no board/`taskRun` JSONL export.

The F-arm measurement phase is closed, with bounded results and limits in the [experiment-arm ledger](experiment-arms.md), the [pilot](../../experiments/execution/ooo-arms-pilot-2026-09-18.md) and its [archive](../../experiments/execution/archive/ooo-arms-2026-09-19/README.md). F3 is directional only, the D-arm result does not establish general fusion savings, and the paid E arm showed no realized gain for its measured shape. No general multi-Agent runtime or quality improvement follows from those experiments.
