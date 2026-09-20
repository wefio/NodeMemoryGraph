# Tests do not need a filesystem

[中文](2026-09-20-tests-need-no-filesystem.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [The dispatch loop is shared](2026-09-19-dispatch-loop-is-shared.md), [The sweep and its evidence rules](2026-09-19-sweep-and-evidence-rules.md)

## Problem

Every candidate a unit produced was verified inside a throwaway workspace: `verifyCandidate` created a
temp directory, ran `git worktree add --detach`, linked `node_modules` in with a junction, wrote the
candidate's files, ran the checks there, and removed the tree. Measured on this machine: `worktree add`
580 ms cold and 79 ms warm, `git worktree remove` 254 ms, `reset --hard` 140 ms, `clean -fdx` 88 ms. One
unit cost about 0.94 s, most of it git; one dispatching case about 5.0 s; the arms' driver suite, 17
cases, 82.5 s - while a case that dispatches nothing cost 0.2 s and opening the board's store cost 22 ms.
The cost was the filesystem and git processes, not the property under test: the arms' unit checks were
`node --experimental-strip-types --test <fixture>.test.ts`, and the fixtures they run are small pure
modules, so a worktree was built per unit to give a test file three files to import.

The same workspaces are also what a killed run leaves behind. One round found seven candidate worktrees
still registered in git (some `locked`, some `prunable`) and ten temp directories from runs that were
aborted: they slow every later git call down, and a tree holding someone else's leftovers is exactly the
class of error that makes a measurement wrong while looking fine (post-mortem 0003's class, one layer
out).

## Decision

**A check reads data and answers, and the host prepares nothing.**

- A data check is a function over `{files, frozen}` that returns a verdict (`DataCheck` in
  `src/integration/ooo-candidate.ts`), and `verifyDataChecks` runs it in this process. Nothing is
  created, so there is nothing to prepare, nothing to clean up, and nothing an interrupted run leaves
  behind. The verdict rule is shared with the command kind, so the two cannot disagree by accident.
- A command check runs in a workspace **the caller prepared**, which `verifyCandidate` receives
  (`{workspace, files, checks}`): it writes the candidate's files there, runs the checks, and reports.
  It no longer takes a repository and a revision, because it no longer creates anything. Which working
  tree the checks run in, and whether that tree is clean, is the caller's business - a check that finds
  its environment wrong reports `undecidable` rather than guessing, and tidying up is not the host's job.
- The arms' checks are their fixture test files, run over the candidate's files in memory
  (`evals/ooo-execution/data-check-runner.ts`): the test file and the modules it imports are read from
  the candidate's file set, transpiled in process, and evaluated with a module system that resolves the
  fixture's own relative imports. The spec's check declaration is therefore `{label, test}` - the
  serializable description of what the unit must pass - and no longer a command with arguments.
- `evals/ooo-execution/candidate.test.ts` retired with the machinery it tested. `verifyCandidate` kept
  one caller, `evals/ooo-execution/mutation-probe.ts`, which needs real checks in a real tree: that tool
  now prepares its own worktree, resets it between mutants, and removes it, because a caller that needs a
  workspace owns it.

## Alternatives considered

- **Pool one worktree per declared slot and reset it between candidates.** Cheaper per candidate (a
  `reset --hard` of 140 ms and a bounded `clean` of 88 ms against 350-830 ms of add and remove), but it
  still creates directories, still needs cleanup, and it puts state shared by candidates in the way of
  the isolation the verification is for. Rejected for the test path; it stays available to a caller that
  has decided it wants a workspace, which is what `mutation-probe.ts` now does for itself.
- **Give each candidate a temp directory holding the frozen files, with no git.** Still the host creating
  a directory on the test's behalf, and a check that needs the surrounding repository would silently see
  too little rather than fail.
- **Leave it as it is.** 5.0 s per case, and every interrupted run leaves worktrees registered in git.
  Rejected.
- **Prepare the environment by hand, once, and reuse it.** Accepted in part, and it is the other half of
  this decision: whoever needs a workspace prepares it. For tests the answer turned out to be to need
  none of them, not to prepare them better.

## Consequences

- **Measured, before and after.** `evals/ooo-execution/plan-driver.test.ts`: 17 cases, 82.5 s -> 4.7 s.
  `evals/ooo-execution/families.test.ts`: 8 cases, 1.3 s (real fixture checks, in memory).
  `tests/integration/ooo-dispatch.test.ts`: 8 cases, 0.6 s, unchanged, because it never used the
  filesystem. A dispatching case fell from about 5.0 s to 0.17 s; the interleaving case costs the 1.5 s
  its own declaration asks for. The driver's mutation lane: clean run 106.9 s -> 5.5 s with its 5 mutants
  caught by the case each one names in 0.8-1.2 s.
- **The teeth still hold.** All 13 mutants across the two targets are caught by the case each one names,
  both targets restored byte-identically: 8 of 8 on `src/integration/ooo-dispatch.ts` and 5 of 5 on
  `evals/ooo-execution/plan-driver.ts`. The parent-composition mutant is the one that depends on
  candidate isolation, and the family case that catches it still does.
- **The instrument changed, so readings do not mix.** Host time and wall time of the arms' cells record
  the commit they ran from; cells measured before this decision paid for a worktree per unit and cells
  measured after do not. Archived readings stand as their own instrument and are not compared with new
  ones as if the difference were the plan.
- **A data check has no process boundary.** It cannot be killed by a timeout, and it cannot execute
  candidate code as a process. That is the price paid here, and it is why the rule is scoped to checks
  whose input is data: a check that must run candidate code under a timeout stays a command check.
- **The spec files declare a test, not a command.** A spec written before this decision names a command
  and its arguments and is refused by `checkList`'s type rather than silently skipped; the fixture specs
  in `evals/ooo-execution/fixtures/` were converted in the same change.
- **The arms' driver no longer needs the repository to verify anything.** It still reads the baseline
  from the working tree and still runs live workers against it; the acceptance path needs neither.

## Deferred

- **The product's live path still declares command checks.** The extension hands the harness's own
  checks to its box, and those run wherever that path decides. Giving that path a declared,
  caller-prepared workspace - and a serializable check description the shared host can rebuild - is the
  declaration-alignment work, not this decision.
