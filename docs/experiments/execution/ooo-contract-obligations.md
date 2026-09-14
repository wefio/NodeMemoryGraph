# The contract's obligations, one node per line

**Status:** living ledger. Each row is one obligation from `docs/design/task-unit-semantics.md`;
progress is counted in rows moved to `proven`, not in edits made.

How a row earns `proven`: it names a test that fails when the code satisfying it is broken. Where
such a mutation is registered, the mutant's name is given, because a test that cannot fail is a
description rather than a pin. Every mutant name below was read from
`tools/mutation-teeth.ts`, not recalled. Rows follow the design's own order, which is the work order.

## A. Offline semantics (the design's first slice, already landed)

| node | obligation | state | evidence |
| --- | --- | --- | --- |
| A1 | The compiler returns a legal plan or a refusal naming task, field and obligation | proven | `tests/integration/task-semantics.test.ts` |
| A2 | The offline model dispatches without publishing or storing run state | proven | `tests/integration/task-semantics-model.test.ts` |
| A3 | The design's six discriminating cases are executable | proven | `tests/integration/task-semantics-cases.test.ts` |
| A4 | Field mapping catches budget-unit confusion, requires/deps confusion and silently dropped keys | proven | mutants `budget-inner-alias-is-dropped`, `over-maximum-budget-is-accepted`, `assumption-may-carry-a-dependency` |

## B. Persistence (design: "进入持久化接入时另须证明")

| node | obligation | state | evidence |
| --- | --- | --- | --- |
| B1 | Two rounds with the same taskId do not collide | proven | `tests/integration/ooo-run-namespace.test.ts`; mutant `claim-is-not-scoped-to-its-run` |
| B2 | A retry does not deliver twice | proven | `tests/core/task-board-deliverable.test.ts`; mutants `stale-claim-may-deliver-again`, `deliverer-may-judge-its-own-work` |
| B3 | A transaction failure cannot write a verdict without its association | proven | `tests/integration/ooo-transition-atomicity.test.ts`; mutants `a-method-opens-its-own-transaction`, `nested-write-transaction-is-allowed`, `swallowed-failure-still-commits` |
| B4 | A retained board entry is not cleared by TTL | proven | `tests/core/task-board-retention.test.ts`; mutants `prune-ignores-retention`, `bounded-pin-never-expires` |
| B5 | The status query and dependency release call one predicate | proven | `tests/integration/ooo-acceptance-one-predicate.test.ts`; mutants `the-board-read-path-stops-calling-the-predicate`, `the-board-decides-acceptance-on-its-own` |
| B6 | A generic board operation cannot bypass a managed task's fence | proven | `tests/integration/ooo-managed-fence.test.ts` — **tooth owed** |
| B7 | JSONL export failure does not change the terminal state | not applicable yet | no JSONL export exists on this branch to fail |
| B8 | The field-mapping checks catch the three confusions | proven | A4: the offline compiler owns this check |

## C. Recomputation (design: "重算检查须证明")

| node | obligation | state | evidence |
| --- | --- | --- | --- |
| C1 | Deleting every derived cache yields the same view | proven | `tests/integration/ooo-task-tables.test.ts`; mutant `derived-rebuild-is-a-no-op` |
| C2 | A lease crossing its boundary invalidates the old view | proven | `evals/ooo-execution/recovery.test.ts`; mutant `stale-claim-may-deliver-again` |
| C3 | Concurrent readers of one ready task: one legal claim | proven | `tests/integration/ooo-managed-fence.test.ts` — **tooth owed** |
| C4 | An unknown external result in a crash window is not guessed | owed | the plan's wait-event semantics have to be read first |

## D. Lifecycle and integration pre-conditions (design: 事务参与与连接生命周期, 当前实现与接入前置条件)

| node | obligation | state | evidence |
| --- | --- | --- | --- |
| D1 | Only the owner opens, migrates, checkpoints and closes a Store | partly | the read-only open and the narrow port exist; the daemon's single close path does not (D8) |
| D2 | A port exposes no raw connection, SQL, transaction control or `close()` | proven | `RoundQueryPort` and `TransactionPort` in `src/integration/ooo-board.ts`; `tests/integration/ooo-round-query.test.ts` |
| D3 | A write inside an open transition without a port is refused | proven | `tests/core/store-transaction-port.test.ts`; mutant `nested-write-transaction-is-allowed` |
| D4 | status's borrowed view migrates nothing, publishes nothing, initialises nothing | proven | `tests/integration/ooo-round-query.test.ts` — **tooth owed** |
| D5 | The two read paths agree on the same facts and the same evaluation time | owed | each path is tested for its own properties only |
| D6 | A read-only open is protected by the handle, not by `query_only` | proven | `tests/core/store-readonly-open.test.ts`; mutant `the-read-only-factory-opens-a-writable-handle` |
| D7 | `round` consumes an operations port and never calls `close()`; the outer host owns the Store | owed | no operations port exists yet |
| D8 | Daemon close order: stop new work, fence in-flight, revoke and drain, finish started transactions, checkpoint and close once | owed | gated by D7 |
| D9 | `submit()` states the commit result separately from a notification failure | owed | the design's own reading of the afterCommit path |
| D10 | `runCycle`'s early-cancel branch is reachable, or it is dead code | owed | the leak is fixed; the mutation check says no test reaches that branch |

## E. Optional HA/MGR integration (design: 复用 autodiff、HA 与 MGR)

Five obligations, all `deferred by design` — that section closes with "这些不扩大首个离线语义切片":
an illegal best-scoring action is still refused, a soft premise cannot unlock a real dependency,
closing or failing falls back to the rule policy, state does not leak across session or branch, and
a parameter or projection version change does not reuse an old suggestion.

## F. Later phase: the experiment arms

The design's A–E arms and its stopping conditions are `not started`. They need a real model, budgets
and repetitions, and the design forbids claiming a speedup without equal parent quality. Nothing in
this ledger may be reported as a result from them.

## Blocked, or not applicable, and why

- B7 has nothing to fail: no JSONL export exists on this branch.
- D5, D7, D8 and D9 are one area — the borrow and close contract — and D7 gates D8.
- The augmented contract itself (317 lines) is untracked in the shared checkout and is not on this
  branch, so this ledger cites the design by section rather than by line. Carrying it in is not mine
  to do alone: `docs/decisions/proposed/2026-09-13-task-unit-semantics.md` has the same author.
