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
| D1 | Only the owner opens, migrates, checkpoints and closes a Store | partly | the read-only open, the narrow port and the daemon's ordered close exist; the round still owns its own store (D7) |
| D2 | A port exposes no raw connection, SQL, transaction control or `close()` | proven | `RoundQueryPort` and `TransactionPort` in `src/integration/ooo-board.ts`; `tests/integration/ooo-round-query.test.ts` |
| D3 | A write inside an open transition without a port is refused | proven | `tests/core/store-transaction-port.test.ts`; mutant `nested-write-transaction-is-allowed` |
| D4 | status's borrowed view migrates nothing, publishes nothing, initialises nothing | proven | `tests/integration/ooo-round-query.test.ts`; mutant `the-status-read-path-opens-the-rounds-store` (the mutant opens the writer's path, and the suite catches it) |
| D5 | The two read paths agree on the same facts and the same evaluation time | proven | `tests/integration/ooo-read-paths-agree.test.ts` — **tooth owed** |
| D6 | A read-only open is protected by the handle, not by `query_only` | proven | `tests/core/store-readonly-open.test.ts`; mutant `the-read-only-factory-opens-a-writable-handle` |
| D7 | `round` consumes an operations port and never calls `close()`; the outer host owns the Store | owed, attempted | an attempt was made and reverted: see "What the D7 attempt found" below. The port surface is measured: `cancel, cancelled, withdrawHandoff, next, claim, putTaskBoardEntry, channel, now, submit, accepted, issueCheck, submitCheck, reopen` — everything the round touches, and no `close` |
| D8 | Daemon close order: stop new work, fence in-flight, revoke and drain, finish started transactions, checkpoint and close once | partly | `src/cli/service.ts` `close()` refuses new work, revokes the scheduled jobs and signals, and closes each store exactly once (`tests/cli/archive-shutdown.test.ts`, `tests/cli/service.test.ts`). The design's "fence in-flight" and "drain" steps have no test yet, and a synchronous `close()` cannot await them - that part is owed |
| D9 | `submit()` states the commit result separately from a notification failure | partly | implemented: `submit()` returns the verdict once the commit lands and records a post-commit notification failure in `lastNotificationFailure()` instead of throwing (`src/integration/ooo-board.ts`). Regression evidence: `evals/ooo-execution` 88/88. A dedicated test that makes the notification fail is **owed** |
| D10 | `runCycle`'s early-cancel branch is reachable, or it is dead code | proven | reachable, and pinned: `evals/ooo-execution/early-cancel.test.ts` fails with "the early-cancel path left its default store directory behind" when the branch's own release is removed, and the worker is never called. That mutation was run by hand in this pass and restored byte-identically; it is not yet registered in the mutation config, so this row is pinned by a recorded check rather than by a configured tooth |

## E. Optional HA/MGR integration (design: 复用 autodiff、HA 与 MGR)

**Closed as excluded from this slice, by the design's own sentence**, not deferred by me: the section
ends with "本节记录复用方向，不把已有实验引擎标成已接入任务运行时，不改变现有启用门控，也不新增开关".
The obligations below are therefore conditional ("可选 HA/MGR 接入时须证明"): they are owed by
whoever wires that integration, not by this slice.

1. an illegal best-scoring action is still refused;  2. a soft premise or `MemoryNode.requires`
gating cannot unlock a real task dependency;  3. closing or failing falls back to the rule policy;
4. state does not leak across session or branch;  5. a parameter or projection version change does
not reuse an old suggestion.

What the design does fix, and what this slice must not contradict: the reuse direction per owner
(autodiff's Tensor/UOp for cost or action scoring, HA for activation and context-retention scores,
MGR's traversal and what-if for sourced context or bounded hypotheses, the shared semantics layer
for the legal action set and acceptance), the boundary each one keeps, and the wiring order — legal
candidates from the shared semantics, then optional HA/MGR context or suggestions, then the shared
policy ranking *inside* the legal set, then re-validation at claim and commit. A suggestion outside
the set is refused, not scored higher; a new task or dependency needs an explicit plan revision; and
association uses the existing run/task/attempt and AG projection identities, not a second task id or
board kind.

## F. Later phase: the experiment arms

The design's A–E arms and its stopping conditions are `not started`. They need a real model, budgets
and repetitions, and the design forbids claiming a speedup without equal parent quality. Nothing in
this ledger may be reported as a result from them.

## What the D7 attempt found

The attempt was reverted, and the tree is back at the commit before it. Two findings are worth
keeping, because both are about the round's ownership rather than about the edit mechanics:

1. The round handed the store an **object it kept filling in**: `specs` was passed to the
   constructor and then assigned into task by task, so the store's behaviour depended on sharing
   that mutable object with its caller. A host-opened store breaks that path, which is why the
   first conversion produced 33 failures with `patch task has no host spec`. The port needs an
   explicit install point - an `installPatchTask(id, spec)` on the owner's object - and the round
   must call it instead of writing into a record it also handed over.
2. `evals/ooo-execution/round-runner.ts` has its own `openRoundStore` that **validates** a store
   rather than creating one. With the round no longer creating the store, the host has to create
   it, so the two same-named functions have to be told apart at the call site (the src factory
   aliased, the local validator left alone).

What the pass did verify before reverting: with both fixes the evals suite went from 33 failures to
4, and the remaining 4 were the `round-runner` name collision. The revert is not a verdict on the
refactor; it is my own rule for this node, declared before starting it: an unconverged conversion
of `evals/**` would leave the round's only real regression suite broken with no gate to notice.
Next attempt should carry the install point in the same change, and run the evals suite as the first
thing after the conversion, on a branch that can be thrown away.

## G. The product entry: collaboration absorbs OoO (design line 216, added after this ledger)

This section answers the question the earlier sessions kept circling, and it rules out the cheap
answer I would otherwise have reached for. OoO is an execution capability *inside* collaboration,
absorbed by the board, the shared task semantics, the execution lifecycle and the acceptance
facilities; an Agent uses it through an ordinary task handoff and never chooses or calls an
dedicated OoO tool. Explicitly forbidden: a new `ooo` tool, a dedicated channel, a second task
body, or a `board.runRound` wrapper - each of which would re-create a separate plan, state and
lifecycle. Ordinary board text does not become an executable task by itself: only a handoff that
enters through an existing operation, with a stated contract and execution authority, participates.

| node | obligation | state | evidence |
| --- | --- | --- | --- |
| G1 | An ordinary board handoff reaches the shared semantics, the execution facility and the acceptance path, with no `ooo_round` and no parallel task state | owed | this is the pre-condition for removing the tool, and it is not built |
| G2 | On that path, a real accepted artifact and the dependency release it unlocks | owed | B5 proves the predicate, not that the ordinary path reaches it |
| G3 | That path covers failure, cancellation, and the sequential fallback when nothing is independent | owed | the round covers these; the ordinary path does not exist yet |
| G4 | The old entry's necessary query and cancel capabilities are reachable from the existing facilities | partly | status reads through `openRoundQuery` (D4) and cancel exists on the board, but no ordinary path reaches them |
| G5 | `ooo_round` leaves the product tool directory, with the tool directory, adapter, docs and hidden-features registry updated together | owed, gated by G1-G4 | `ooo_round` is declared compatibility-only: no new features, no dual-write, and it must not become the surface anything new is built on |
| G6 | The task view is a projection of existing facts: no second editable task truth, and a model cannot confirm `accepted`, change a lease or overwrite a cancellation by patching state | partly | the state side is covered (B5, B6, D3, D4); the view's information classes and their owners are recorded in the design's table and are not asserted anywhere |
| G7 | One real handoff at a legal boundary, with another Agent session continuing the same parent task from the view plus retrievable evidence, judged by the fixed parent check | owed | the design puts this after G1, and it needs a real model and budget |

Two consequences for the nodes above it:

- D7 (the round borrowing its store) stays worth doing and is now also the node that would let a
  non-round host run the same operations, which is what G1 needs. It does not, by itself, move any G
  node: G1 is about which entry point exists, not about who closes a connection.
- The design's order is now: the B/C/D proofs, then the ordinary collaboration path (G1-G4), then the
  one real continuation (G7), and only then the A-E arms. The A-E arms are unchanged; the
  continuation check moved in front of them.



## Blocked, or not applicable, and why

- B7 has nothing to fail: no JSONL export exists on this branch.
- D7 is the one D node that is a refactor rather than a proof: the round must consume an operations
  port and stop closing the connection, which touches 46 `runCycle(` call sites, all of them in
  `evals/**` - a tree neither `tsc` nor the product suite covers. It needs its own pass with the
  evals suites run afterwards, because a silent breakage there would not fail any gate.
- The augmented contract itself (317 lines) is untracked in the shared checkout and is not on this
  branch, so this ledger cites the design by section rather than by line. Carrying it in is not mine
  to do alone: `docs/decisions/proposed/2026-09-13-task-unit-semantics.md` has the same author.
