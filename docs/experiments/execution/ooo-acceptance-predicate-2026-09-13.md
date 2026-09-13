# One acceptance predicate, adopted by the round

**Related:** [task-unit semantics design](../../design/task-unit-semantics.md) ·
[proposed decision record](../../decisions/proposed/2026-09-13-task-unit-semantics.md) ·
[slice 1: compiler and model](task-semantics-slice1-2026-09-13.md) ·
[board deliverable/verdict decision](../../decisions/proposed/2026-09-06-board-governance-addressing.md)

Measured 2026-09-13. Zero model tokens: every number below comes from the deterministic round
suites and the mutation teeth, with no provider contacted.

## Question

The design's rule is that a fact has one predicate: _"接受查询与依赖解锁必须调用同一谓词 …… 不得一条路径
看 board verdict，另一条仅检查 artifact 非空"_. Was the round actually violating it, and if so in
which reachable state — not merely in wording?

## What was actually wrong

The round kept two definitions of "accepted". `accepted()` joined the board verdict and its
digest, while four scheduling paths asked only whether the artifact column was non-null:
`inputs()` (what a dependent binds), `publishReady()` (which handoff may occupy the board's
serial slot), `next()` (selection), and `claimableRow()` (claim admissibility).

Those two definitions agree in a normal round, because `commitArtifact()` is the only writer of
`artifact` and it writes only after the host verifier accepted and the coordinator judged
`accepted`. They diverge in exactly one reachable state: **an outside reviewer re-judges the
delivered entry**. The board protocol allows that (it is the same `judge` verb this round uses
itself), and the design's own comment on `accepted()` predicted the consequence — a row whose
entry was judged rejected "stops counting as accepted even though its value is still stored".
So the round could keep releasing dependents on work that a recorded verdict had rejected, and
nothing in the scheduling path could see it. That is a defect, not a stylistic duplication.

## What changed

| site                                                     | before                                           | after                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `acceptedFact()` in `src/integration/task-semantics.ts`  | —                                                | the rule, once: not cancelled, artifact and digest present, revision current, verdict `accepted`, `judgedDigest === digest` |
| `isAccepted()` (view)                                    | its own copy of the rule                         | delegates to `acceptedFact()`                                                                                               |
| `acceptedArtifacts()` in `src/integration/ooo-board.ts`  | `accepted()`'s query with its own verdict checks | one query supplying facts to `acceptedFact()`; `accepted()` delegates to it                                                 |
| `inputs()`, `publishReady()`, `next()`, `claimableRow()` | `artifact !== null`                              | membership in `acceptedArtifacts()`                                                                                         |
| `delivered(row)`                                         | —                                                | names the delivery fact where it is genuinely the question (`submit`, `commitArtifact`, the check guard)                    |

## Behaviour, stated plainly

- An outside rejection now **withdraws the release** of dependents: `next()` selects nothing on
  that work and claiming the dependent fails with `unfulfilled dependencies`.
- The round **fails closed rather than self-healing**: the rejected artifact is still delivered,
  so the task is not silently re-run. Claiming it says so — "task delivered but not accepted; the
  coordinator must reopen it" — and recovery is the coordinator's explicit `reopen()`, which
  fences the task and its transitive dependents and clears the value.
- **No rollback.** Work already dispatched against an artifact that is rejected afterwards is not
  undone; the round has no rollback, and this change does not add one. It makes the _gate_
  consistent, which is why the offline model's `fused` mode records that cost instead of assuming
  it away.

## Evidence

| check                 | command                                                                                       | result                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| types / lint / format | `npm run check`, `npx eslint …`, `npm run format:check`                                       | clean                                                                                   |
| complexity            | `npm run complexity:gate`                                                                     | `6 changed code file(s) … 0 method(s) above 15`                                         |
| round suites          | `node --experimental-strip-types --test --test-concurrency=1 "evals/ooo-execution/*.test.ts"` | 86 pass, 0 fail (was 85; one case added)                                                |
| compiler / model      | the two slice-1 suites                                                                        | 13 and 7 pass (compiler was 12; one case added)                                         |
| mutation teeth        | `npm run mutation:teeth`                                                                      | 11 of 11 mutants caught by name across 3 targets; each target restored byte-identically |

The new round case is the defect in one place: submit an accepted artifact, confirm `next()` is
the dependent, have an outside agent judge the entry `rejected`, then assert that acceptance is
empty, that nothing is selected, that the dependent cannot be claimed, that the rejected task
cannot be re-claimed, and that `reopen()` makes it schedulable again.

## The stale mutant (why the script is worth more than the count)

After `isAccepted()` was refactored to delegate, the old tooth that anchored on its `return`
line no longer matched. The script reported `anchor not found, refusing to claim a check` and
failed the run, instead of treating an absent anchor as a pass. A mutation harness that silently
skips a tooth it can no longer apply would have kept printing a comfortable number for a check
that had stopped existing; retargeting it to the rule's new home is what kept the count honest.

## What this does not do

- The design's retention precondition is untouched: a board entry referenced by a retained run is
  still subject to ordinary TTL prune, so an old run's evidence can age out from under it.
- `ooo_probe_tasks` still mixes immutable input (`input`, `revision`), candidate bytes
  (`artifact`) and derivable state (`entry_id`, `accepted_entry_id`, the attempt counter). This
  change makes the derivation consistent; it does not split the storage, which is the design's
  later slice (shared transaction store, multi-round namespacing, minimal manifest/facts).
- Nothing was wired into a new runtime path: the round still owns its private SQLite store and
  the compiler is still used only by the model and these suites.

## Reproduction

```bash
cd <worktree on this branch>
npm run prompts:generate
npm run check && npm run complexity:gate && npm run format:check
node --experimental-strip-types --test --test-concurrency=1 "evals/ooo-execution/*.test.ts"
node --experimental-strip-types --test --test-concurrency=1 tests/integration/task-semantics.test.ts
npm run mutation:teeth   # the same mutants, now a repository tool
```
