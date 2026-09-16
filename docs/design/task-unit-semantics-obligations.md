# The contract's obligations, one node per line

**Authority:** living ledger for `docs/design/task-unit-semantics.md` — each row is one
obligation from that design; progress is counted in rows moved to `proven`, not in edits made.

Counts at this revision, computed from the rows below rather than from memory: **A** 4 proven, 0 partly, 0 owed (4 rows); **B** 6 proven, 1 partly, 0 owed (8 rows); **C** 4 proven, 0 partly, 0 owed (4 rows); **D** 10 proven, 0 partly, 0 owed (10 rows); **G** 7 proven, 0 partly, 0 owed (7 rows). **E** is recorded as excluded by the design's own sentence, **F** not started. The latest pass moved C3, D5, G3, G4 and G6 to proven, rewrote B6 to the half it can enforce, and added six mutants (40 of 40 caught, up from 33). B6's owed half is a slice rather than a guard: see the section at the end.

Verification commands, run in the worktree that holds this branch, with the values they returned at this
revision (re-run them rather than trusting the numbers; the harness writes no log file):

- `node --experimental-strip-types --test --test-concurrency=4 "evals/ooo-execution/"*.test.ts` -> 90 pass, 0 fail, exit 0
- `npm run test:product` -> 1354 pass, 0 fail, exit 0
- `node --experimental-strip-types tools/mutation-teeth.ts` -> 40 of 40 caught, 7 of 7 restored byte-identically, exit 0
- `node --experimental-strip-types --test --test-concurrency=4 tests/integration/ooo-ordinary-failure.test.ts tests/integration/ooo-managed-fence.test.ts tests/integration/ooo-read-paths-agree.test.ts tests/integration/ooo-round-query.test.ts tests/integration/ooo-task-tables.test.ts` -> 5, 3, 1, 2 and 4 pass, 0 fail, exit 0

How a row earns `proven`: it names a test that fails when the code satisfying it is broken. Where
such a mutation is registered, the mutant's name is given, because a test that cannot fail is a
description rather than a pin. Every mutant name below was read from
`tools/mutation-teeth.ts`, not recalled. Rows follow the design's own order, which is the work order.

## A. Offline semantics (the design's first slice, already landed)

| node | obligation                                                                                     | state  | evidence                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| A1   | The compiler returns a legal plan or a refusal naming task, field and obligation               | proven | `tests/integration/task-semantics.test.ts`                                                                      |
| A2   | The offline model dispatches without publishing or storing run state                           | proven | `tests/integration/task-semantics-model.test.ts`                                                                |
| A3   | The design's six discriminating cases are executable                                           | proven | `tests/integration/task-semantics-cases.test.ts`                                                                |
| A4   | Field mapping catches budget-unit confusion, requires/deps confusion and silently dropped keys | proven | mutants `budget-inner-alias-is-dropped`, `over-maximum-budget-is-accepted`, `assumption-may-carry-a-dependency` |

## B. Persistence (design: "进入持久化接入时另须证明")

| node | obligation                                                           | state          | evidence                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | Two rounds with the same taskId do not collide                       | proven         | `tests/integration/ooo-run-namespace.test.ts`; mutant `claim-is-not-scoped-to-its-run`                                                                                       |
| B2   | A retry does not deliver twice                                       | proven         | `tests/core/task-board-deliverable.test.ts`; mutants `stale-claim-may-deliver-again`, `deliverer-may-judge-its-own-work`                                                     |
| B3   | A transaction failure cannot write a verdict without its association | proven         | `tests/integration/ooo-transition-atomicity.test.ts`; mutants `a-method-opens-its-own-transaction`, `nested-write-transaction-is-allowed`, `swallowed-failure-still-commits` |
| B4   | A retained board entry is not cleared by TTL                         | proven         | `tests/core/task-board-retention.test.ts`; mutants `prune-ignores-retention`, `bounded-pin-never-expires`                                                                    |
| B5   | The status query and dependency release call one predicate           | proven         | `tests/integration/ooo-acceptance-one-predicate.test.ts`; mutants `the-board-read-path-stops-calling-the-predicate`, `the-board-decides-acceptance-on-its-own`               |
| B6   | A generic board write cannot move a managed round's own state, and cannot take the live claim it holds | partly | the state half is structural and asserted (`tests/integration/ooo-managed-fence.test.ts`: the round's owner, attempt, acceptance and terminal reason stay its own facts, and a generic claim on its entry changes none of them). The claim it holds is not structural and is tooth-backed: `a-live-claim-can-be-taken-by-another-agent` - the store's CAS stops requiring the holder to be the claimant, and the same test's direct second reader then succeeds. Owed: the design's own sentence, that a generic write on a managed entry is applied *inside the coordinating transaction*; the section at the end records why that is a slice of its own and not a guard |
| B7   | JSONL export failure does not change the terminal state              | not applicable | no JSONL export exists on this branch to fail                                                                                                                                |
| B8   | The field-mapping checks catch the three confusions                  | proven         | A4: the offline compiler owns this check                                                                                                                                     |

## C. Recomputation (design: "重算检查须证明")

| node | obligation                                                  | state  | evidence                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ----------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | Deleting every derived cache yields the same view           | proven | `tests/integration/ooo-task-tables.test.ts`; mutant `derived-rebuild-is-a-no-op`                                                                                                                                                                                                                                                                                      |
| C2   | A lease crossing its boundary invalidates the old view      | proven | `evals/ooo-execution/recovery.test.ts`; mutant `stale-claim-may-deliver-again`                                                                                                                                                                                                                                                                                        |
| C3   | Concurrent readers of one ready task: one legal claim | proven | `tests/integration/ooo-managed-fence.test.ts`. The test now reaches the board directly as well, because the round's own `live()` check refuses first and a mutant that broke only the store would have survived: a second reader on its own connection calls `claimTaskBoardEntry` and is refused, which is what makes "one legal claim" a property of the store rather than of one caller's discipline. Mutant `a-live-claim-can-be-taken-by-another-agent` (caught) |
| C4   | An unknown external result in a crash window is not guessed | proven | `tests/integration/ooo-external-window.test.ts`. `externalReady` refuses to make an event ready while a check for that task is outstanding ("managed check requires bound terminal evidence"), so the window cannot be closed by announcing it; after a restart the stored fact is still `external_ready = 0` with no artifact, and an invented event name is refused |

## D. Lifecycle and integration pre-conditions (design: 事务参与与连接生命周期, 当前实现与接入前置条件)

| node | obligation                                                                                   | state  | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | Only the owner opens, migrates, checkpoints and closes a Store                               | proven | the round borrows its store and never closes it (D7), the read-only open is its own capability, and the daemon's close now refuses to drop accepted calls and is idempotent (D8). The narrow port and the borrowed status view carry the rest                                                                                                                                                                                                                                                                                                                                           |
| D2   | A port exposes no raw connection, SQL, transaction control or `close()`                      | proven | `RoundQueryPort` and `TransactionPort` in `src/integration/ooo-board.ts`; `tests/integration/ooo-round-query.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D3   | A write inside an open transition without a port is refused                                  | proven | `tests/core/store-transaction-port.test.ts`; mutant `nested-write-transaction-is-allowed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D4   | status's borrowed view migrates nothing, publishes nothing, initialises nothing              | proven | `tests/integration/ooo-round-query.test.ts`; mutant `the-status-read-path-opens-the-rounds-store` (the mutant opens the writer's path, and the suite catches it)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D5   | The two read paths agree on the same facts and the same evaluation time | proven | `tests/integration/ooo-read-paths-agree.test.ts`. The comparison is no longer vacuous: the case accepts a task through the round's own host-verified path first, then requires both paths to report the same acceptance *and the same artifact bytes*. Mutant `the-offline-reader-decides-acceptance-on-its-own` (the borrowed port answers `{}` from its own rule; caught) |
| D6   | A read-only open is protected by the handle, not by `query_only`                             | proven | `tests/core/store-readonly-open.test.ts`; mutant `the-read-only-factory-opens-a-writable-handle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D7   | `round` consumes an operations port and never calls `close()`; the outer host owns the Store | proven | `OooRoundOperations` (13 methods, no `close`) + `openRoundStore()` in `src/integration/ooo-cycle.ts`; `CycleOptions.operations` is required, so there is no `ownsStore` branch. Both `gate.close()` calls and the default-directory release are gone, and the three task specs are installed through `installPatchTask` instead of into an object the round also handed to the constructor. evals 89/89; the CLI host opens the store and closes it after the round returns                                                                                                             |
| D8   | Shutdown stops new work, lets the work in flight finish, then closes once                    | proven | `src/cli/service.ts`: `close()` refuses while calls are in flight, `drain()` is the awaited middle step, and `inFlight` counts what the daemon accepted. `tests/cli/service-drain.test.ts` holds an accepted call in flight (search opens the store, so the counter sees work a synchronous close could not), requires `drain(0)` to fail rather than return quietly, then closes once; `tests/cli/service.test.ts` 51/0 and `archive-shutdown` 3/0 are the regression evidence                                                                                                         |
| D9   | A post-commit notification failure is recorded, not thrown                                   | proven | `evals/ooo-execution/notification.test.ts`: a real round whose first post-commit notification fails still accepts A, B and C, reports the message through `lastNotificationFailure()`, and a control round with a reachable notification reports nothing. Verified by mutation: deleting the `try`/`catch` in `submit()` makes the notification escape and the test fails. The seam took three tries to find - `publishReady` is private and is called without a port at the commit, and `afterCommit` also runs on non-commit paths, so the failure is gated on a commit having landed |
| D10  | `runCycle`'s early-cancel branch is reachable, or it is dead code                            | proven | reachable, and pinned twice: `evals/ooo-execution/early-cancel.test.ts` fails with "database is not open" when the round closes the store it borrowed on that path (verified by hand and restored byte-identically). D7 removed the default directory the earlier version of this pin watched, so the pin moved to the borrowing contract                                                                                                                                                                                                                                               |

## E. Optional HA/MGR integration (design: 复用 autodiff、HA 与 MGR)

**Closed as excluded from this slice, by the design's own sentence**, not deferred by me: the section
ends with "本节记录复用方向，不把已有实验引擎标成已接入任务运行时，不改变现有启用门控，也不新增开关".
The obligations below are therefore conditional ("可选 HA/MGR 接入时须证明"): they are owed by
whoever wires that integration, not by this slice.

1. an illegal best-scoring action is still refused; 2. a soft premise or `MemoryNode.requires`
   gating cannot unlock a real task dependency; 3. closing or failing falls back to the rule policy;
2. state does not leak across session or branch; 5. a parameter or projection version change does
   not reuse an old suggestion.

What the design does fix, and what this slice must not contradict: the reuse direction per owner
(autodiff's Tensor/UOp for cost or action scoring, HA for activation and context-retention scores,
MGR's traversal and what-if for sourced context or bounded hypotheses, the shared semantics layer
for the legal action set and acceptance), the boundary each one keeps, and the wiring order — legal
candidates from the shared semantics, then optional HA/MGR context or suggestions, then the shared
policy ranking _inside_ the legal set, then re-validation at claim and commit. A suggestion outside
the set is refused, not scored higher; a new task or dependency needs an explicit plan revision; and
association uses the existing run/task/attempt and AG projection identities, not a second task id or
board kind.

## F. Later phase: the experiment arms

The design's A–E arms and its stopping conditions are `not started`. They need a real model, budgets
and repetitions, and the design forbids claiming a speedup without equal parent quality. Nothing in
this ledger may be reported as a result from them.

## What the D7 attempt found

Both findings were fixed in the D7 commit; the record stays because the first one was a real defect in
the round's ownership rather than an accident of editing.

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

## What the B6 attempt found

The design asks that a generic write request on a managed entry go through the same coordinating
transaction ("受管理条目的通用写请求也必须经过同一协调事务，禁止直接 judge/resolve 绕开运行围栏").
Reading every caller before writing the guard is what showed that the literal version of it is not a
guard but a slice of the integration still outstanding:

- The board's own verbs **are** how an ordinary handoff is worked, which is the design's own product
  entry. The generic lifecycle writes on a run's published handoffs are made by
  `evals/ooo-execution/board-worker.ts:74` and `:138`, `board-deliver.ts:67`, `board-judge.ts:78`,
  `live-continuation.ts:527`/`:603`/`:748`, and by the daemon's `claim`, `deliver`, `judge` and
  `resolve` verbs in `src/cli/service.ts:2854`/`:2894`/`:2898`/`:2952`. Refusing those writes on a
  managed entry would refuse the product path the same design mandates, and the Pi tool that used to
  bypass them is gone (G5).
- What makes the write "the same transaction" today is the store's transaction port: object identity
  checked by `withPort()`, so a foreign port, a store with no open transition, and a caller that
  opens its own boundary are all distinguishable. Wiring the run's coordinator *into* the daemon's
  board verbs is the shared-store integration the design's 当前实现 section already names as the
  target shape that is not in place, not a check that can be added to one method.
- The harmful direction is closed without it, which is why B6 can still carry teeth: a generic claim
  cannot take a live claim (`a-live-claim-can-be-taken-by-another-agent`), acceptance is the board's
  verdict bound to *this* attempt's artifact digest (`verdict-lookup-not-bound-to-the-artifact`), a
  withdrawn acceptance withdraws the release of the dependent
  (`round-releases-dependents-on-delivered-bytes`), and an entry retired while verification was
  awaiting leaves the attempt stale rather than committed
  (`the-commit-trusts-a-claim-the-board-retired`, pinned by the window case in
  `tests/integration/ooo-managed-fence.test.ts`).
- Two guards, one tooth: an assertion satisfied by *either* of two independent refusals cannot be
  pinned by breaking one of them. The C3 case had that shape - the round's `live()` check refuses
  before the store's CAS is reached - so the test was extended to reach the board directly. The
  commit-window case had the mirror-image problem: `submit()` checks liveness before verification and
  `commitArtifact()` re-checks it after, so the retirement has to happen *inside* the verification
  window for the second check to be the one that decides.

The harness note from that pass is closed: a failed clean run now reports the observed failure lines
(`observedFailures` in `tools/mutation-teeth.ts`, main's #63 - this branch takes it by merging main,
not by a change of its own), so the verdict is diagnosable instead of repeated. The one-in-four flake
the note also recorded was never diagnosed here; the Windows temp-tree removal and shadow-lock flakes
main repaired in #63/#64 are the nearest known causes, and they arrive in the same merge.

## G. The product entry: collaboration absorbs OoO (design line 216, added after this ledger)

This section answers the question the earlier sessions kept circling, and it rules out the cheap
answer I would otherwise have reached for. OoO is an execution capability _inside_ collaboration,
absorbed by the board, the shared task semantics, the execution lifecycle and the acceptance
facilities; an Agent uses it through an ordinary task handoff and never chooses or calls an
dedicated OoO tool. Explicitly forbidden: a new `ooo` tool, a dedicated channel, a second task
body, or a `board.runRound` wrapper - each of which would re-create a separate plan, state and
lifecycle. Ordinary board text does not become an executable task by itself: only a handoff that
enters through an existing operation, with a stated contract and execution authority, participates.

| node | obligation                                                                                                                                                                          | state  | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | An ordinary board handoff reaches semantics, execution and acceptance with no `ooo_round`                                                                                           | proven | `BoardAdmission.next()` now answers with `nextTask(dispatchTasks(compileTaskUnits({plan, specs}).units, facts))`, so the coordination path consults the compiler it used to ignore (`src/integration/ooo-board.ts:812` and `:822`, and the hand-rolled candidate mapping is gone from `src/`: `rg -c schedulable src/` is 0 (the config's own anchor for that rule is what used to match, and it moved with the rule)). `tests/integration/ooo-ordinary-handoff.test.ts` walks claim -> deliver -> independent verdict -> accepted with the board's own verbs; the only mention of `ooo_round` in it is the comment saying it is untouched. Verified by mutation by hand: dropping `task.accepted` from `nextTask`'s validity check fails it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| G2   | A real artifact is accepted on that path, and accepting it releases the dependent                                                                                                   | proven | the same test: B's artifact is accepted by the board's own verdict, and `deriveStatus(units, facts).ready` goes from `["B"]` to `["A"]` over the recorded facts while `next()` gives the same two answers, so the two views are held together rather than assumed to agree. The same mutation (validity no longer requiring acceptance) fails the test at its first assertion: `assert.equal(gate.next(), "B")` at tests/integration/ooo-ordinary-handoff.test.ts:68 returns null (AssertionError: null !== 'B'), so the `ready` assertion later in the test is never evaluated. Measured, not recalled: the mutation was run and restored byte-identically while correcting this sentence. The rule this row's release depends on - an artifact delivered without an accepted verdict is not selectable - moved with the wiring, and its tooth moved with it: `selection-ignores-a-withdrawn-acceptance` is now anchored on `nextTask`'s `selectable` line in `src/integration/ooo-execution.ts` and is a configured target (full harness: 7 of 7 targets, 31 of 31 caught, 7 of 7 restored byte-identically, exit 0).                                                                                                                                                                                                                                                                                                                                                       |
| G3   | Failure, cancellation, the ordered fallback, and the accepted prefix | proven | `tests/integration/ooo-ordinary-failure.test.ts` (5/5): a refused deliverable neither accepts nor releases and is not re-selected on its own until the coordinator reopens it; a later refusal does not withdraw the prefix that was already accepted; a cancellation names the lease it revoked and every claim behind it is refused; with no fusion point the plan falls back to its declared order; a split that maps no parent obligation is refused by name with its location. Selection is tooth-backed (`selection-ignores-a-withdrawn-acceptance`, `a-live-claim-does-not-block-selection`, `cancellation-does-not-stop-a-claim`) and so is the prefix: mutant `reopening-one-task-clears-every-acceptance` (reopen fences every accepted task instead of the dependents of the one reopened; caught by the fifth case, which then finds only A accepted where it requires A and B). The design's fusion clause ("融合中途失败只保留已接受前缀") is **not applicable on this path**: fusion is declared unmodelled and refused by name (`UNMODELLED_ACTIONS`), so nothing on the ordinary path fuses and nothing can fail midway; the prefix property itself is what the fifth case asserts. The offline model covers fused-midway failure for its own enumerated plans under row A3 |
| G4   | The old entry's query and cancel are reachable from existing facilities | proven | query: `tests/integration/ooo-round-query.test.ts` "the query port reads a round without migrating, publishing or exposing a write", tooth-backed by D4's `the-status-read-path-opens-the-rounds-store`. cancel: the round's own lifecycle operation, and now tooth-backed at integration level by the durability case in the same file ("the terminal decision outlives the host that made it, and still refuses new work": a second host that opens the store reads the same terminal reason, a new claim is refused, the revoked claim is gone and the attempt is fenced). Mutant `cancelling-a-round-forgets-its-reason` (cancel stops persisting the reason; caught by that case - the cross-process suite `evals/ooo-execution/cancellation.test.ts` names it too, and is branch evidence rather than a mutant, because adding a 90-120s multi-process suite to a 17-mutant target would multiply every verification by it). Neither file mentions `ooo_round` or the extension: 0 hits |
| G5   | `ooo_round` leaves the product tool directory, with the tool directory, adapter, docs and hidden-features registry updated together                                                 | proven | Removed: `.pi/extensions/nmg/ooo-round.ts`, its import and its `registerTool` block in `.pi/extensions/nmg/index.ts` (0 remaining mentions of `ooo_round` in the tool directory), and `tests/extensions/nmg/ooo-round.test.ts`; the three tool lists in `tests/extensions/nmg/index.test.ts` no longer name it. What remains is the ordinary path: `nmg_board` for handoffs, the shared layer for selection. `ooo-execution.ts` stays in the extension because it is not the tool - `evals/ooo-execution/live-{cycle,patch,pi}.ts` import it as the eval-side Pi execution adapter, and G7 runs through them. `npm run ooo:round` also stays: it is the research CLI under `evals/`, not a product surface. Docs record the removal in the bootstrap design's S3 row and in the design's own `ooo_round` sentence. The hidden-features registry is deliberately unchanged: its OoO rows describe the research CLI and the live eval entries, whose gates did not change, and the Pi tool was registered by default, so it never had a hidden-feature row to remove.                                                                                                                                                                                                                                                                                                                                                                                                           |
| G6   | The task view is a projection of existing facts: no second editable task truth, and a model cannot confirm `accepted`, change a lease or overwrite a cancellation by patching state | proven | the state side is covered (B5, B6, D3, D4). The consequences the design's information table has are now asserted rather than described: the frozen plan has one owner and a second, different plan is refused (`tests/integration/ooo-task-tables.test.ts`, mutant `a-second-plan-silently-adopts-the-run`), a terminal decision cannot be overwritten by a later patch (mutant `a-second-cancellation-overwrites-the-first-decision`), and acceptance is only ever the host-verified artifact plus the board's verdict about that digest (`verdict-lookup-not-bound-to-the-artifact`, `round-releases-dependents-on-delivered-bytes`). What stays prose is the table's owner assignment itself - which layer owns which information class is a design statement, not something a test can read off one column |
| G7   | One real handoff at a legal boundary, with another Agent session continuing the same parent task from the view plus retrievable evidence, judged by the fixed parent check          | proven | `docs/experiments/execution/ooo-real-continuation-2026-09-14.md`, with the run's raw records beside it (`ooo-real-continuation-2026-09-14-g7-run.jsonl`, `-merge-retries.jsonl`) and the executable check `evals/ooo-execution/live-continuation.ts`. Five structurally identical, content-distinct tasks; every role a separate process; the parent is the channel and the continuation a second handoff in it; part 2 retrieves the part-1 artifact from the view and verifies it against the digest the store recorded before it may continue; the fixed parent check (6/8/7/6/7 frozen cases) decides the boundary and the parent. Model `deepseek/deepseek-v4-flash`; one clean pass over the five tasks = 9 model calls, 80 081 tokens, 84 395 ms, plus a four-attempt sample of `merge`. Result: four of five tasks accepted end to end; `merge`'s continuation failed 2 of 4 attempts with an unparseable patch artifact, and its parent stage then recorded **no verdict** rather than judging the part-1 artifact. The document states the cost and the limits, including that failed attempts' token counts are not recorded A follow-up comparison (`docs/experiments/execution/ooo-real-continuation-comparison-2026-09-14.md`) re-reads every stage record, classifies each failure by cause, and finds that 13 of the 20 continuation failures were the harness's own defects rather than the model's, while the stable first stage failed once in 35 samples. |

Two consequences for the nodes above it:

- D7 (the round borrowing its store) stays worth doing and is now also the node that would let a
  non-round host run the same operations, which is what G1 needs. It does not, by itself, move any G
  node: G1 is about which entry point exists, not about who closes a connection.
- The design's order is now: the B/C/D proofs, then the ordinary collaboration path (G1-G4), then the
  one real continuation (G7), and only then the A-E arms. The A-E arms are unchanged; the
  continuation check moved in front of them.

## Blocked, or not applicable, and why

- B7 has nothing to fail: no JSONL export exists on this branch.
- D7 is neither blocked nor deferred: the port is in place and its row records it (13 operations and
  no `close`, `CycleOptions.operations` required, the specs carried by `installPatchTask`). What
  survives the first attempt is why it took two: the conversion touches `evals/**`, a tree neither
  `tsc` nor the product suite covers, so a silent breakage there would fail no gate. A later pass
  over the same tree runs the evals suites as its first act, not its last - that rule is what turned
  the first attempt into a revert instead of a branch with a broken regression suite.
- The design document is tracked and current here: this branch carries the 369-line revision,
  `sha256 a7cebe00f503495d…` - the shared checkout's newer revision landed verbatim (`a061b2b5`,
  squashed into `0d3dc09d`) - and `main` still carries the 272-line one (`1f2f22f2`, PR #54). Every
  sentence these rows quote from the design was located by its text in that revision, not from a
  remembered line number, and the re-check this pass caught one: the B6 obligation carried the wrong
  character (`栅` for `围`) and could not be found in the file at all. Corrected. The rows therefore
  do not depend on which revision lands, as long as the quoted sentences stay word-for-word.

## The next pass: what is left, and what it needs decided

Everything in A-G is proven, excluded by the design's own sentence (E) or has nothing to fail (B7),
with one exception: **B6's owed half**. It is the design's own migration step 3 - "最后让研究 runner
和薄适配经 daemon 调用" - read together with the truth table's managed-entry row: the daemon hosts the
run, and a generic write on a managed entry is applied *inside* the coordinating transaction instead
of beside it.

Reading the code before declaring the slice found the obstacle, which is why this is written down
before the pass rather than after it:

- `BoardAdmission extends NmgStore` and opens its own file (`super(database)`), so today the run
  namespace exists only on a connection the round itself created. The design forbids the convenient
  direction in its own words - "共享协调器不继承 Store 来获得另一条连接" - and the round's port
  (`OooRoundOperations`, a `Pick` of 13 methods) is already shaped as a borrowed capability.
- So the namespace's schema creation and typed writes have to be reachable on a store the daemon
  already owns, and the coordinator has to consume the store's transaction operations instead of
  being a subclass. Two shapes are consistent with the contract, and this ledger does not pick
  between them by itself:
  1. the run namespace becomes part of the core schema (`src/core/store/schema.ts`), leaving the
     coordinator a pure consumer of typed operations and adding no public store API; the cost is
     that every store carries the namespace's tables whether or not it ever runs a round;
  2. the store gains one narrow namespace capability the owner registers, so the owner still runs
     the DDL inside its own migration and the coordinator still holds only typed operations; the cost
     is new public store surface, which 事务参与与连接生命周期 otherwise keeps deliberately small.
- Either way the acceptance criteria are already written down: the proven persistence obligations
  (B2, B3, B4, B5) stay proven, and the new one is that a managed write lands with its run fact in
  one transaction, tooth-backed. The state half already lives in
  `tests/integration/ooo-managed-fence.test.ts`.

Nothing here claims progress: the row stays `partly` until a pass implements it.
