# A non-blocking track must still be visible

[中文](2026-09-12-visible-non-blocking-research-track.zh-CN.md)

**Status:** implemented
**Approved:** unrecorded
Date: 2026-09-12
Branch: feat/ci-visible-research-track

## Problem

The `research-tests` job ran with `continue-on-error: true`, and the design record
(`docs/design/ci-cd-and-quality.md`) described it as the non-blocking research/benchmark track.
Deliberately non-blocking is fine. What was not fine is that `continue-on-error` also made the
job _always look green_: a research verification that failed could fail for as long as it liked
without anyone being told, and no run's result could be told apart from a run where the job never
executed. That is the same failure mode as the complexity gate that printed `no changed files`
and exited 0 — a signal that cannot distinguish "checked and clean" from "never looked".

The same review found a second, quieter gap of the same kind: the sets of tests CI runs are
hand-maintained glob lists inside npm scripts, so a suite can land in no job at all. One had:
`evals/ooo-execution/*.test.ts` (12 files) was run by no job, and a third-party suite under
`tests/lab/` was drifting the same way.

## Decision

Non-blocking is a branch-protection property, not a workflow property. So:

- `research-tests` keeps its non-blocking status — it is still absent from `all-checks-passed`,
  which remains the only aggregated required check — and drops `continue-on-error`, so its real
  result appears as a red check on the pull request while the required aggregate stays green.
- A required check (`npm run ci:uncovered-tests`, inside the `static` job) derives which test
  files no CI job reaches from the globs those jobs actually call. Suites under the acknowledged
  root `evals/` may stay on-demand; anything else fails the check until it is covered or
  acknowledged deliberately, with the reason recorded in the tool.
- The unreached suites run on demand in a separate workflow
  (`.github/workflows/on-demand-suites.yml`, `workflow_dispatch` only) on both Linux and Windows,
  at `--test-concurrency=1`, uploading their TAP transcript as an artifact.

## Alternatives considered

- **Keep `continue-on-error` and add a warning annotation.** Rejected: annotations live inside the
  run, and the job would still show green in every check list. The point is that a reader who only
  looks at the checks must not be told something false.
- **Make the research track required.** Rejected: it characterizes benchmark adapters and can be
  slow or environment-dependent; the existing decision to keep it non-blocking stands. Blocking it
  would trade one lie (always green) for another (a red required check that says "do not merge"
  about something that is not a merge blocker).
- **Move the research job into its own workflow.** Rejected as unnecessary: required-ness is
  decided by `all-checks-passed` and branch protection, so the same "visible, not required"
  outcome is available in the current file with less machinery.
- **Handle the uncovered suites by widening the research job's globs.** Rejected: the OoO suites
  drive real worktrees, real child processes and real multi-process boards on both platforms, and
  the two flakes observed so far were load-sensitive. Mixing them into a characterization job
  would make each track's failure signal murkier, not clearer.
- **A nightly run of the unreached suites.** Rejected by the operator: an on-demand trigger is
  enough, and a scheduled job nobody reads is another green-looking non-signal.

## Consequences

- A research-track failure is now visible on the pull request, and mergeability is unchanged.
- A test suite can no longer fall out of CI silently: either a job globs it, or the coverage check
  fails and names it, or it sits under `evals/` (acknowledged, with the reason in the tool).
- `tests/lab/relevance-model.test.ts` was found by this check while still uncommitted, which is why
  the coverage check judges tracked files only: work in progress is not yet part of the repository.
- The unreached suites are only measured when someone asks for the workflow. That is a real limit:
  the on-demand artifacts are evidence for a run, not a standing guarantee.
