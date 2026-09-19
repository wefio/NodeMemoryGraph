# CI coverage acknowledges archived run directories

[中文](2026-09-19-acknowledge-archived-run-directories.zh-CN.md)

**Status:** implemented
**Approved:** explicit

## Problem

`npm run ci:uncovered-tests` fails the "Static and package contracts" job for every `.test.ts` file
that no CI job reaches and that sits outside an acknowledged root. An archived run directory is not a
suite: `docs/experiments/execution/archive/ooo-arms-2026-09-19/` keeps the candidate tree a finished
arm was judged on, `.test.ts` files included, because that tree is the evidence of the run. Five such
files made the whole job red, so a required check reported a false positive instead of drift.

## Decision

`ACKNOWLEDGED_ROOTS` in `tools/ci-uncovered-tests.ts` gains
`docs/experiments/execution/archive/`, with the reason recorded next to the list: an archived run
directory holds the candidate tree it was judged on as evidence, not as suites anyone maintains.
The acknowledgement is a prefix rule on purpose; a future archive inherits it only by living under
that root.

## Alternatives considered

- Run the archived files in a CI job: their fixture belongs to a rejected candidate of a finished
  run, so the job would assert on a tree that no longer exists in the working set.
- Move the archive under `evals/`: that acknowledges by naming accident, which the tool's own
  comment forbids.
- Delete the archived `.test.ts` files: they are the record of what the arm was judged on.
- Teach the scanner to skip archives separately: a second notion of "not a suite" for one outcome,
  when the tool already has the acknowledged-root concept and asks for a reason.

## Consequences

The job fails again only on files that are genuinely outside every CI job, which is what makes the
acknowledgement worth having. An archive placed outside
`docs/experiments/execution/archive/` still needs its own row, and the reason for keeping it stays
visible at the list rather than in a commit message.
