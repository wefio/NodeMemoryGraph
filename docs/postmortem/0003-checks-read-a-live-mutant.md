# 0003 - The checks I read were reading a mutant

[中文](0003-checks-read-a-live-mutant.zh-CN.md)

**Status:** resolved

## Executive summary

I ran `npm run lint` and `npm run complexity:gate` while a detached `mutation:teeth` run was holding a
live mutant in `evals/ooo-execution/plan-driver.ts` and `src/integration/ooo-execution.ts`. The failures
they reported described the *mutant*, not my code: a `no-constant-binary-expression` at the exact line a
generated `if (false && …)` had been substituted into, an unused-variable warning that was the
parent-check mutant, and two function-complexity numbers measured against mutated source. I noticed only
because the lint line was recognisably one of my own mutants. The hazard was already written down as
"never edit or stage a file a mutation run is rewriting" - a rule about *writes*. A check only *reads*,
which is why the rule did not fire, and the harness left nothing in the tree that a check could see.

## Summary

The slice under work adds fusion legality to `src/integration/ooo-execution.ts`, an accounting mode to
`evals/ooo-execution/cost-model.ts` and a session policy to `evals/ooo-execution/plan-driver.ts`, with new
named mutants in `tools/mutation-teeth.ts`. Because the mutation sweep is one of the three expensive
lanes, it was launched detached, and it was still running when I ran the cheap gates in the foreground.

The same class then escaped a **second** time, in the opposite direction, and that is what turned a
nuisance into a post-mortem. The detached sweep had been launched in a way that did not survive its
shell, so it was killed mid-run - leaving its mutant in `evals/ooo-execution/plan-driver.ts`, where the
bound check had been substituted with `if (false) return undefined;`. Nothing said so: a killed harness
writes no summary and removes no lock at the time. The next sweep inherited that file as its *baseline*,
its own clean run failed (`clean run failed, the harness proves nothing` - the tool was right and I was
not), and one of its mutants could not be located at all, because the anchor it wanted had already been
replaced by the leftover. Two of the driver's tests failed for a day's worth of the opposite reason to
the first escape: not a check reading a mutant, but a **mutant that outlived its harness**, and the
existing rule - `git diff` the target of a died run - was the one step I skipped.

`mutation:teeth` works by substituting a named wrong version into its target file, running the suites
that are supposed to catch it, and restoring the file byte-identically. While it is between the
substitution and the restore, **the target file on disk is the mutant**. Two of its registered mutants
substitute `if (false && <condition>)` into `sharedSessionLegal`, and the lint output named exactly that
construct as a constant-truthiness error at `:225`; a third mutant replaces the parent check's verdict,
which is why a warning appeared for a variable that is used in my version. The complexity gate reported
`sharedSessionLegal` at 18 and `runOneUnit` at 17 - numbers computed from whatever text was on disk at
that moment, which is a different question from the one I asked.

Re-measured on a quiet tree, the real numbers were 18 and 16, and both did need the helper extraction the
repository's rule requires. That nearness is what makes the class dangerous rather than merely annoying:
the same mechanism that produced a false failure would have produced a false **pass**, and a green lane
read during a mutant window is evidence about a tree that never existed.

## Impact

No product behaviour was affected and no verification result was published: the contaminated readings
were recognised before they were acted on, and both gates were re-run on a quiet tree (lint 0 errors,
complexity `ok`, 20 methods above 15 unchanged from baseline). The cost is time and risk - I ordered
`lint` output as a real failure, started reasoning about a refactor to satisfy mutant complexity numbers,
and only the accidental match between the lint construct and a mutant I had written seconds earlier
stopped it from becoming a change. Had the mutants been less recognisable, the same reading would have
entered this session's record as a fact about my change.

The second escape cost more than the first: two named mutants ran against a tree that already held a
mutant, so their verdicts described a baseline that never existed, and one mutant could not be located at
all. Its cost was paid twice - once by the checks that misread, once by the tests that failed on a file
nobody had touched.

What it could **not** do: mutate the commit. Nothing was staged while the sweep ran, and the sweep
restores each target byte-identically before moving on (`17 of 17` and `1 of 1` restorations on the runs
in this session).

## Timeline

- The fusion legality, cost-model and driver changes are written, with their named mutants registered.
- `npm run mutation:teeth --targets evals/ooo-execution/plan-driver.ts` is launched detached; its header
  says so, and the foreground is free.
- `npm run lint` is run in the foreground, after the sweep has already substituted a mutant into
  `plan-driver.ts`. It reports 2 errors and a warning.
- `npm run complexity:gate` is run in the same window. It reports two functions above the limit.
- The lint message is read closely, and its line (`if (false && …)`) is one of my own mutants: the
  reading is contaminated, and everything measured in that window is discarded.
- The sweep finishes and reports `10 of 11` caught with one mutant whose anchor no longer matched, and
  one that the suite could not distinguish.
- Re-launched and re-checked: the run that came back `10 of 10` had measured a **tree that still held the
  killed run's mutant** in the bound check. The suite's two fusion cases fail on the restored file only
  until that leftover is removed - `if (session.units.length >= bound) return undefined;` came back, and
  the suite passed 15 of 15 again. The bound mutant had been unlocatable for exactly that reason.
- With the tree quiet: the redundant check and its mutant are deleted, the helpers are extracted, and
  lint and complexity are re-run green.

## Root cause

Two mechanisms, and the second is why the first kept happening.

First, a mutation sweep is a **write window over the tree**, and every check is a **reader** of that same
tree. The repository's rule named the write side only - "do not edit or stage a file a mutation run is
rewriting" - which is the side the sweep's own process controls. A reader has no way to tell a mutant
from a change, and a check that reports on the wrong text looks exactly like a check that reports on the
right one.

Second, the fact "a mutant is live" existed **only inside the harness's process**. Nothing in the tree
said so: no lock, no marker, no file a check could read. So the rule had to be carried by the session's
memory across a long, decomposed task - and a rule that depends on remembering, in the middle of a task
whose whole point is many parallel lanes, is a rule that will be dropped.

Third, and this is what made the class escape twice: a harness that is **killed** leaves the tree in the
state its process was in, and the state was "a mutant is substituted". The rule that should have caught it
was there - `git diff` the target of a run that died - but it was a step in a document, addressed to the
reader's memory, at the moment when the reader has the *least* reason to be careful, since a killed run
looks like nothing happened at all.

## Guardrails added

The mechanism is now visible in the tree, and the checks read it:

- `tools/mutation-teeth.ts` writes `.temp/mutation-lock.json` naming the target file for as long as a
  mutant is live (and removes it on restore, on refusal and on exit), and refuses to start while another
  sweep's lock exists - two sweeps in one worktree is the same hazard with a different reader.
- `tools/mutation-lock.ts` is the one home for that lock: the writers and the readers of the tree agree on
  one file and one meaning instead of each tool inventing its own signal. A lock whose owner is **dead** is
  no longer ignored as harmless: it is reported as `a previous sweep died holding <target>`, the target is
  named, `git diff` is named, and a new sweep **refuses to start** rather than taking it over silently - the
  exact step that was skipped here.
- [`tools/agent-verify.ts`](../../tools/agent-verify.ts) **refuses to verify** while a lock is present
  (running or stale), naming the file the sweep is holding, so the lane that is supposed to summarise this
  work cannot summarise a mutant.
- [`tools/repo-context.ts`](../../tools/repo-context.ts) (`npm run agent:context`) prints the live lock in
  its reconciliation section, because that is the command a session runs first.
- [`skills/repo-development/SKILL.md`](../../skills/repo-development/SKILL.md) states the widened rule
  beside the mutation lane: a running sweep makes the tree unreadable for checks, not only unwritable for
  edits.
- A case in `tests/tools/agent-verify.test.ts` fails if the refusal stops firing while a lock is present
  (and passes again once the lock is gone).
- `tests/tools/mutation-lock.test.ts` pins the three readings of a lock: a live owner is a running sweep, a
  dead owner is a stale one, and **a stale one refuses a new sweep** by name.

## Lessons

- A verification is a triple - result, command, **object** - and "object" includes *the tree is
  quiescent*. 0002 was this same lesson with a different mechanism: there the object was a working tree
  instead of the commit; here it is a tree mid-substitution instead of the source.
- A process that mutates a shared resource must be recoverable by inspection after it dies. "If it died,
  check the file" is the right instinct and the wrong mechanism: the check is the lock, and it belongs in
  the tree, where the next process finds it without remembering anything.
- The dangerous half of a contaminated reading is the false **pass**, not the false failure. A false
  failure gets investigated; a false pass gets recorded.
- A rule about a lane has to name every role that touches the resource. "Do not write while X runs" and
  "do not read while X runs" are different rules, and the second one has more ways to be broken.
- If a fact is only in a process's memory, a rule cannot be built on it. The lock file is not
  bureaucracy: it is the difference between a rule and a hope.
