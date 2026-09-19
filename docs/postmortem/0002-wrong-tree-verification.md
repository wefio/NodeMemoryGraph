# 0002 - The tree I verified was not the tree I pushed

[中文](0002-wrong-tree-verification.zh-CN.md)

**Status:** open

## Executive summary

B2 split the round's task row into three tables and dropped `ooo_probe_tasks`. A test file the refactor never
touched still queried the dropped table by name; the adaptation existed in my working tree and never entered
the commit, so the pushed branch was red while every gate I had run was green. The gates were run against the
working tree, and a push publishes `HEAD` - the two differ by exactly the work that was never staged. The
lesson: "the branch is green" is a claim about a commit, and a claim about a directory is a different claim.

## Summary

The split shipped as four commits: the refactor, its acceptance tests, the retargeted mutation teeth, and the
record. The new table set is written by `src/core/store/base.ts`, and the suites read it through a projection.
One of those suites had been written one slice earlier, against the pre-split table, and read raw rows from it
by name.

In my working tree that suite was adapted: raw reads go through the projection, and the retired table is named
`ooo_probe_tasks_pre_split`. In the commit it was not. The commit staged the files I had edited by hand, and
that test file was not one of them - so the version that reached the remote still queried `ooo_probe_tasks`,
which that same commit had dropped. The suite was red on the branch as pushed.

It was found by accident, while stashing the working tree before an unrelated run: the stashed (committed)
state failed with `no such table: ooo_probe_tasks` at `tests/integration/ooo-run-namespace.test.ts:93`. The
repair is commit `13317c82`, whose message states the gap in its own body.

## Impact

The branch under review carried a red suite until the repair landed. `main` was never affected; no published
number depended on it. The failure could not be mistaken for a pass - it fails loudly and immediately.

Whether the branch's CI reported it during that window is **not reconstructed** here. The observation that
matters is narrower and does not depend on that answer: a reviewer who trusted my summary of "product
1467/0" would have been trusting a number measured on a tree that was never pushed.

## Timeline

- The four B2 commits are prepared and the product suite is run - green - against the working tree.
- The commits are staged selectively, by the files I had edited. `tests/integration/ooo-run-namespace.test.ts`
  is not among them, although B2 is what invalidated it.
- The branch is pushed and the pull request updated.
- A later run stashes the working tree to test something else, and the committed state fails by name
  (`no such table: ooo_probe_tasks`).
- `13317c82` fixes the suite and states the gap in the commit body.

## Root cause

Two mechanisms, and only their combination produces this.

First, the object I verified and the object I published were different: `npm test` runs against a directory,
a push publishes a commit tree. Nothing in the workflow compares the two, and the difference is precisely the
unstaged work. This is the general form - a verification result is only as good as the identity of the tree
it was measured on, and that identity was in my head rather than in the command.

Second, a rename or split is a cross-file event, but only one of its two halves is visible. The TypeScript
compiler sees the code side and stays silent here; the other half lives inside SQL strings, which no compiler
reads. "Stage only what I edited" is the correct habit for preserving a shared worktree's unrelated changes,
and at the same time it silently drops fixes the change made necessary in files nobody edited.

## Guardrails added

None for the class; the instance is repaired by `13317c82`. A mutation target lists that suite, so a _code_
regression in it is caught - but "the adaptation never entered the commit" is invisible to every check, and
staging discipline is a session behaviour that no check can see.

Candidates, named and not landed:

- Verify the committed tree before pushing it (`git stash -u && npm test`, or `git archive HEAD` into a
  temporary worktree) whenever the working tree and the commit differ.
- After a table rename or split, search the whole suite for the retired name - not only the files being edited.
- Make the staging step itself state what it left out, so the difference is a reviewed line rather than an
  accident.

## Lessons

- "Green" without its object is not a statement. A verification is a triple: result, tree, command.
- A rename is a cross-file event whose second half is in strings. The compiler covers the half that is code.
- Selective staging protects other people's work and hides my own debt in the same motion; those two effects
  need separate handling rather than one habit doing both.
- The discovery was lucky and the luck is the finding: a stash is not a verification procedure.
