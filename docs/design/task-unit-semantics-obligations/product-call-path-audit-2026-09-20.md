# Product call-path audit (2026-09-20)

[中文](product-call-path-audit-2026-09-20.zh-CN.md) · [Terms used](product-call-path-audit-2026-09-20.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.md).

## Product call-path audit (2026-09-20)

Verified against `e3508a37`, and re-run unchanged at `c01d3fe`, without changing runtime code or buying
model runs. The question is which
existing rules a product operation enforces, not whether another executor or another rule language is needed.

The rules already exist: `acceptedDependency`/`selectableTasks`/`startableTasks` in
[`ooo-execution.ts`](../../../src/integration/ooo-execution.ts) cover accepted dependencies and eligible
concurrency; `sharedSessionLegal` and [`nextSessionMove`](../../../src/integration/ooo-fusion-plan.ts)
cover session continuation. The ordinary Pi product path already wakes an existing Agent session through
`deliverWake` in [the extension](../../../.pi/extensions/nmg/index.ts); the Agent uses the existing
`nmg_board` operations to claim and deliver, with an independent judge. Absence of a product caller for
`dispatchPlan` is not evidence that these rules or this execution path are absent.

There is a concrete boundary between the product lifecycle operation and dependency admission:
[`task-run-surface.test.ts`](../../../tests/cli/task-run-surface.test.ts)'s `registerAndFreeze` freezes
`J.dependencies = ["P"]`. Its case `a managed entry's lifecycle write goes through the run, and the run
records it` then adopts and successfully claims J through `NmgService.invoke`, without producing or
accepting P. The observed facts are `entry-bound` and `board-claim`. Thus this managed claim call enforces
registration, binding and cancellation, but does not itself enforce the dependency-acceptance predicate.
The test proves that narrow behavior; it does not justify replacing the existing predicates or treating
every ordinary handoff as a dependency-scheduled task.

Likewise, `claimTaskBoardEntry` and `resolveTaskBoardEntry` call `promoteNextSerialPending`; the promotion
is a handoff becoming available after claim/closure, not a dependency becoming satisfied by acceptance.
`judgeTaskBoardEntry` independently binds a verdict to the artifact digest. These existing operations
must not be described as missing, or their different transitions treated as interchangeable.

The extracted loop's eight tests use `StubBoard` for candidate selection, claims and verdicts. One also
uses a real Store to verify per-task/attempt/entry session facts. They establish the loop and the fact
write, not a product implementation of `DispatchBoard`. Relevant verification, run from the worktree:

```sh
node --experimental-strip-types --test tests/integration/ooo-dispatch.test.ts tests/integration/ooo-fusion-plan.test.ts tests/integration/ooo-session-facts.test.ts tests/cli/task-run-surface.test.ts
```

Result: **41 passed, 0 failed**. The service tests invoke the product service in-process; they are not
network calls to the user's running daemon, and the fusion-plan tests are pure-rule evidence.

The separately observed live daemon at `2026-09-20T11:54Z` answered `nmg daemon status --json` with
`compatible: true`, but its advertised `methods` omitted `taskRun`; the worktree's service implements
that method. This is an installed-instance capability observation, not evidence that the source method
is missing. The shared daemon was not restarted. Product deployment and source-level test coverage are
separate claims.
