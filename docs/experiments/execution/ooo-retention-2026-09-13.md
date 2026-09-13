# Retention, and the verdict the round no longer copies

**Related:** [task-unit semantics design](../../design/task-unit-semantics.md) ·
[proposed decision record](../../decisions/proposed/2026-09-13-task-unit-semantics.md) ·
[the single acceptance predicate](ooo-acceptance-predicate-2026-09-13.md) ·
[board deliverable/verdict decision](../../decisions/proposed/2026-09-06-board-governance-addressing.md)

Measured 2026-09-13. Zero model tokens.

## Question

The design lists two preconditions the round has to meet before runners can be wired to it:
_"被保留 run 引用的 board entry 必须能 survive 普通 TTL prune"_, and derived facts must have no
authoritative storage. Both were false, and they are the same problem seen twice: the round kept
a private column (`accepted_entry_id`) pointing at the entry that accepted an artifact, precisely
because the entry itself could be pruned away on its own TTL. Copying the fact was the workaround
for not being able to retain the evidence.

## What changed

| part                                                                             | change                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task_board_retentions` (schema)                                                 | a pin per `(entry_id, owner)`, with a reason and an optional `retained_until`                                                                                                        |
| `retainTaskBoardEntry` / `releaseTaskBoardRetention` / `listTaskBoardRetentions` | the store's API; refuses a dangling reference, an unattributed pin, and an unparseable bound by name                                                                                 |
| `pruneExpiredTaskBoardEntries`                                                   | both the channel-scoped and the global path exempt pinned entries, their deliveries and their acks; the serial-slot promotion ignores a pinned entry; an expired bound stops pinning |
| the round                                                                        | pins every handoff it publishes, releases on `fenceRow` (which `cancel` and `reopen` both go through) and when a handoff it never used is retired                                    |
| `acceptedArtifacts()`                                                            | the verdict is looked up on the board by the digest of _this attempt's_ artifact; no pointer column                                                                                  |
| `commitArtifact()`                                                               | stops writing `accepted_entry_id`                                                                                                                                                    |

So acceptance is now derived from the entry, and the retention is what makes that derivation
true. A consumer that needs a durable reference no longer has to copy the fact into its own
table — which is exactly the property the design's "derived facts have no authoritative storage"
asks for.

## Evidence

| check                        | command                                                                                                                                                                     | result                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| types / lint / format / docs | `npm run check`, `npx eslint …`, `npm run format:check`, `npm run docs:check`                                                                                               | clean (docs: 185 files, 0 errors)                                                |
| complexity                   | `npm run complexity:gate`                                                                                                                                                   | `7 changed code file(s) … 0 method(s) above 15`                                  |
| product suite                | `node --experimental-strip-types --test --test-concurrency=2 "tests/**"`                                                                                                    | 1231 pass, 0 fail                                                                |
| round suites                 | `… "evals/ooo-execution/*.test.ts"`                                                                                                                                         | 88 pass, 0 fail (was 86)                                                         |
| mutation teeth               | `node <shared-checkout>/.nmg/teeth-check-task-semantics.mjs` (a local script at the time; the same mutants now live in `tools/mutation-teeth.ts`, `npm run mutation:teeth`) | 15 of 15 mutants caught by name across 4 targets, each restored byte-identically |

The round-level case is the precondition itself: after an artifact is accepted, prune with a
timestamp past every TTL in the store, then assert that the referenced entry is still there and
that `accepted()` still derives `["P"]`; then `reopen()` the task, and assert the pin is gone and
the entry is finally prunable. A second case cancels the round and asserts no pin survives it.

## Two teeth survived, and both were my test's fault

This is the part worth keeping. The first run of the extended teeth check reported two mutants
that changed nothing:

- **`prune-ignores-retention`** was not caught because the retention test only called the
  _global_ prune; the channel-scoped path, which has its own DELETE, was never exercised. The
  case now calls both.
- **`round-never-releases-its-pin`** was not caught because the round test only reached `reopen`,
  while the mutant removed the release inside `fenceRow` — the path `cancel` uses. Adding a cancel
  case exposed a **real defect** in the code, not just a gap in the test: `fenceRow` released by
  artifact digest only, so a pin on a handoff the round had published but never used became an
  orphan the moment `publishReady()` cleared `entry_id`. The release is now dual — by entry id and
  by artifact digest — through one `releaseRowRetention()` helper, and the cancel case pins it.

## What this does not do

- `ooo_probe_tasks` still holds immutable input (`input`, `revision`), candidate bytes
  (`artifact`) and derivable state (`entry_id`, `attempt`, and now the retired
  `accepted_entry_id`) in one table. This change removes one derived column's _use_; splitting the
  table is the design's later slice, together with the shared transaction store and multi-round
  namespacing.
- A pin with no `retainedUntil` is released explicitly, so a round that dies without fencing
  leaves a visible pin behind. That is deliberate — the evidence must not vanish — and
  `listTaskBoardRetentions` is how an operator finds it. Nobody should read this as automatic.

## Reproduction

```bash
cd <worktree on this branch>
npm run prompts:generate
npm run check && npm run complexity:gate && npm run format:check && npm run docs:check
node --experimental-strip-types --test --test-concurrency=1 tests/core/task-board-retention.test.ts
node --experimental-strip-types --test --test-concurrency=1 "evals/ooo-execution/*.test.ts"
node <shared-checkout>/.nmg/teeth-check-task-semantics.mjs   # local one-off at the time; see tools/mutation-teeth.ts
```
