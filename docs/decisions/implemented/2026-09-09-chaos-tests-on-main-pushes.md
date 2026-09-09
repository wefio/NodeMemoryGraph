# Run the Windows chaos job on main pushes only

[中文](2026-09-09-chaos-tests-on-main-pushes.zh-CN.md)

**Status:** implemented
**Date:** 2026-09-09
**Branch:** feat/rcp-lightweight-verification

## Problem

Every pull request runs six CI jobs in parallel. Two of them cost the most: the
product suite (70–108 s) and the Windows chaos suite (58–101 s). The chaos job
runs on `windows-latest`, which GitHub bills at twice the Linux rate.

The chaos job rarely reports anything on a pull request. Across the 145 CI runs
from 2026-08-21 to 2026-09-09:

| job | runs | failures | rate |
| --- | --- | --- | --- |
| Static and package contracts | 133 | 13 | 9.8% |
| Product tests and coverage | 132 | 6 | 4.5% |
| Node 22 compatibility | 152 | 5 | 3.3% |
| Research characterization (non-blocking) | 130 | 4 | 3.1% |
| Windows chaos tests | 153 | 1 | 0.65% |

The single chaos failure was on `main` (`chaos (22)` at `53aa07d`); it never
failed on a pull request. Job names changed during the window (`ci (22..24)`,
`chaos (22..24)`, `Unit tests and coverage`); the table merges them.

The measurement is the whole argument. A check that fails once in 153 runs is
not gating pull requests; it is spending a 2x-billed runner on them.

## Decision

Run the `chaos` job on pushes to `main` only. Pull requests skip it, and
`all-checks-passed` accepts `skipped` for that job so a pull request still
reports a green aggregate. On `main` the job stays required: `skipped` is
accepted only where the job cannot run.

The suite itself is unchanged. `npm run test:chaos`, `verify:chaos` and the
`chaos` route in `agent-context.yaml` stay blocking; only the CI trigger moves.

## Alternatives considered

- **Keep it on every pull request.** Rejected: 1 failure in 153 runs, on `main`,
  does not justify a Windows runner on every PR.
- **Make it non-blocking (`continue-on-error`) instead.** Rejected: a
  non-blocking job still consumes the runner and no longer gates `main` at all.
- **Run it on pull requests whose diff touches chaos-relevant paths.**
  Deferred. Running a check when its inputs change is the better mechanism, and
  it is the natural upgrade if a chaos regression ever reaches `main`.
- **Delete the chaos suite.** Rejected: it has found real defects (a SQLite
  handle left open when a migration failed, which pinned the file on Windows).
- **Move the research characterization job instead.** Not applicable: it is
  already non-blocking, and it failed 4 times in 130 runs.

## Acceptance criteria

Met as of 2026-09-09:

- The `chaos` job declares a push-only condition, so pull requests skip it.
- `all-checks-passed` accepts `skipped` for `chaos`, so a pull request still
  reports green while a `main` push still requires a real success.
- `npm run test:chaos`, `verify:chaos` and the `chaos` route are unchanged.

Open:

- The window is 19 days and 145 runs. A longer window would firm up the 0.65%.
- The affected-path trigger is not implemented.

## Consequences

- A pull request no longer spends a Windows runner. A chaos regression can now
  reach `main` before it is caught, and `main` can go red after a merge; the
  affected-path trigger is the mitigation to build if that happens.
- Pull-request wall clock does not change. The jobs run in parallel and the
  product job (70–108 s) is the critical path, longer than chaos (58–101 s).
  What this saves is runner minutes, not the time a pull request waits.
- A green `All checks passed` on a pull request now means "every check that was
  required here ran and passed". That aggregate is weaker on a pull request
  than on `main`, where chaos is still required.
