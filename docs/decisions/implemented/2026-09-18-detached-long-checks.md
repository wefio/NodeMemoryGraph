# Long checks run detached, and their result is collected before the commit

**Status:** implemented
**Approved:** explicit
**Relates to:** [repository development skill](../../../skills/repo-development/SKILL.md),
[CI and quality design](../../design/ci-cd-and-quality.md),
[the arms pilot](../../experiments/execution/ooo-arms-pilot-2026-09-18.md)

治理 meta-rule：[self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) ——
本规则变更本身也是一次受治理的决策（决策 + 替代方案 + 一个规则一个家）。

中文版: [2026-09-18-detached-long-checks.zh-CN.md](2026-09-18-detached-long-checks.zh-CN.md)

## Problem

The blocking checks an Agent runs here are not uniform in cost, and the verification
habit treated them as if they were. Measured on 2026-09-18 in one worktree (Windows):

| Check                                                                           | Cost            |
| ------------------------------------------------------------------------------- | --------------- |
| `npm run mutation:teeth` (17 targets, 117 mutants)                              | ≈ 13 min        |
| `npm run mutation:teeth -- --targets=<one driver target>`                       | ≈ 10 min        |
| `npm run test:product`                                                          | ≈ 70 s          |
| `evals/ooo-execution/*.test.ts`                                                 | ≈ 60 s          |
| LSP diagnostics, format, lint on touched files, `complexity:gate`, `docs:check` | ≈ 20 s together |

Two facts about that table are easy to miss. A scoped mutation run is not
proportionally cheap: the cost is the suites each mutant re-runs, so one target whose
suites include a slow acceptance case costs as much as several targets whose suites do
not. And the expensive three produce results that are needed at the commit, not at the
moment they are started: on that day the full mutation run was executed three times
inside one session, about 40 minutes of waiting that changed nothing.

The harness's shell call is synchronous and gives no completion notice, so a check that
runs in the background is a convention an Agent follows, not a capability it can be
handed by a flag.

## Decision

1. **Two lanes.** The cheap checks that decide whether the change is sound stay
   synchronous and blocking. The expensive three — full `mutation:teeth`,
   `test:product`, and the `evals/**` suites — are launched detached once the code they
   measure is final, and collected before the commit:

   ```bash
   (npm run mutation:teeth > .temp/teeth.log 2>&1; echo "exit=$?" >> .temp/teeth.log) &
   ```

   A launch returns immediately and is never followed by a wait: no `sleep`, no poll
   loop, no re-reading the log to see whether it is worth reading yet. Waiting in the
   same session under another name is not a saving — the point of detaching is that the
   time goes to the rest of the change (the documentation, the cheap lane, the next
   edit), and the collector reads the log at the next natural checkpoint. When there is
   nothing else to do, the check runs synchronously: a detached run nobody is working
   alongside is just a slower way to wait.

2. **A detached run reports its own exit status.** Without `echo "exit=$?"` into its
   state file, a missing exit line means either "still running" or "died", and the two are
   read the same way.
3. **Read the state as three outcomes, not two, and decide the middle one by liveness.**
   Finished is `exit=<code>`. Still running is "no exit line yet, and the recorded pid is
   alive". Died is "no exit line, and the pid is gone" — nothing wrote a code, so the run
   was killed rather than finished. Elapsed time is deliberately not a state: a slow,
   healthy run and a fresh one are identical from the outside, so a long runtime is never
   read as a failure, and distinguishing _working_ from _wedged_ uses the check's own
   progress (one log line per test, one per mutant), not the clock. Measured on this
   platform (Git Bash on Windows): a pid launched at 20:55:25 and still sleeping answered
   `kill -0` as alive 22 seconds later from a _different_ shell invocation, a pid killed
   with `kill -9` answered gone, and so did a pid that never existed — so the middle
   outcome is decidable across tool calls, with no heartbeat needed.
4. **The launch is its own statement.** `A && B &` backgrounds the whole list, which is a
   measured trap rather than a stylistic one: with the header redirect inside the
   backgrounded list, the header truncated the state file _after_ the foreground `pid=`
   line had been written to it, and the pid was lost — leaving exactly the state that
   cannot be read. The header is written in the foreground, the check is backgrounded on
   its own, and the pid is appended last.
5. **A detached run records the tree it measured** (`git rev-parse HEAD` and
   `git diff --stat` at launch), and the collector compares that with the tree it is
   collecting in: a code change means re-run, a documentation-only change leaves the
   result valid. The comparison is what distinguishes the two, not the collector's
   memory.
6. **Nothing edits a target while a mutation run rewrites it.** `mutation:teeth`
   replaces the file it tests and does not restore after an abort, so a run that is
   abandoned mid-flight can leave a mutant in the tree; the collector runs `git diff`
   on the target first and treats a leftover mutant as a failed run rather than a
   result. The same window makes staging unsafe: a `git add` while the run is in flight
   can stage a mutant, which is worse than a failed check because the pre-commit hook
   formats and the commit carries it.
7. **Scoped runs and the full run answer different questions.** `--targets=` during a
   change says this change's own mutants are dead; a full run before a push or merge
   says no other target's mutant survived. Neither substitutes for the other.

## Alternatives considered

- **Keep every check synchronous** — the practice before this record. Rejected on the
  measurement above: 40 minutes of one session spent waiting, with no effect on the
  change under test.
- **Guard the tool instead of documenting the habit**: make `mutation:teeth` refuse to
  start when a target has uncommitted changes, or restore the target on abort. The
  first half is wrong rather than deferred — a target with uncommitted changes is the
  normal case, since mutation runs happen before the commit — and would refuse exactly
  the run an Agent needs. Restore-on-abort is the half worth having and is recorded
  under Deferred rather than taken here, because it changes a tool every Agent's runs
  share while the hazard is detectable from `git diff` at collection.
- **A wrapper tool** (`tools/verify-detached.ts` with `start`/`status`): not taken. The
  shell already supports the pattern — measured on this change: `test:product` (1433 tests)
  was launched at 20:52:49, the shell call returned immediately, its log read `exit=0` at
  20:54:05, and the skill, both languages of this record, `docs:check`, `glossary:check`
  and `agent:verify` were written and run inside that window — so a wrapper would be a
  second home for one rule with no evidence yet that the three-line launch is repeated
  enough to be worth typing wrong. The owner of the rule stays the Skill.
- **Give `evals/**` its own route so `agent:verify` stops dragging the product suite**:
  an orthogonal cost (≈ 70 s) that belongs to the route contract in
  `docs/design/ci-cd-and-quality.md`, not to this decision.

## Consequences

- The waiting moves off the critical path: the same checks run, while the Agent writes
  the ledger, the design record, and runs the cheap lane. The saving is exactly the
  other work available at that moment, so a change with nothing left to write gains
  nothing from detaching and should run the check synchronously.
- A result is only as good as the tree snapshot it was collected against, so the
  collector has to compare the tree rather than trust the log.
- An abandoned run is a working-tree hazard, not only a lost measurement (Decision 6),
  which keeps the pre-commit formatting hook and a `git diff` review necessary even when
  every log says `exit=0`.
- The rule lives in [`skills/repo-development/SKILL.md`](../../../skills/repo-development/SKILL.md);
  the costs that justify the split live here. Each may change without rewriting the other.

## Deferred

- **Restore-on-abort for `mutation:teeth`.** The tool reports "restored byte-identically"
  when it finishes a target, and nothing when it is killed. Worth adding if a leftover
  mutant is ever collected as a result; until then the check is `git diff` on the target.
- **A wrapper for the launch/collect/compare triple.** Revisit when the same launch is
  written often enough that getting it wrong is likelier than the wrapper is: at that
  point the tree snapshot and the exit status are what it has to carry.
- **The Skill is close to its size budget.** `skills/repo-development/SKILL.md` is at
  14 931 B of the 15 000 B budget that `docs:check` enforces, and this rule had to be
  compressed twice to fit. The next addition there should move an explanation out — to a
  record or a design document — rather than trim another rule of the reason it exists.
