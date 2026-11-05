# Run the Windows chaos job on main pushes only

[中文](2026-09-09-chaos-tests-on-main-pushes.zh-CN.md) · [Terms used](2026-09-09-chaos-tests-on-main-pushes.terms.yaml)

**Status:** implemented  
**Approved:** unrecorded

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

### Amended 2026-11-05: run it when its inputs change

The deferred alternative became the rule. On 2026-11-03 a store change
(`9d474b34`, the legacy-tesserae migration) broke `chaos truncated active WAL`
deterministically: the migration's rollback replaced the corruption error with
`no such savepoint: nmg_tessera_migration`, so the test's expectation never
matched. `main` stayed red until the fix landed on 2026-11-05.

The 0.65% rate measures flakiness. It does not describe a deterministic
regression, which fails every run until someone fixes it, and which is exactly
the class a pull request can catch. The job now runs on `main` pushes and on
pull requests whose diff touches `src/core/store/`, `src/core/schema.ts`,
`src/core/types.ts` or `tests/chaos/`.

### Amended 2026-11-05: a documentation-only change skips the code jobs

A `changes` job reads the diff once and publishes `code` and `store`. A pull
request whose every changed path is prose (`docs/`, `*.md`, `*.terms.yaml`,
`README`, `AGENTS`, `LICENSE`, `CHANGELOG`) skips `static`, `tests`,
`node-compat`, `onlion` and `research-tests`, and runs a `docs` job instead:
`docs:check`, `glossary:check`, `rtm:check`, `agent:context:check`,
`check:policy-words` and `tests/docs`. `skills/` and `tests/` are not prose for
this purpose, because `tests/skills` and `tests/docs` validate them.

`all-checks-passed` reads the same scope output, so a skipped code job is only
accepted when the change really was documentation-only; a failed `changes` job
fails the aggregate instead of reading as "nothing to check".

## Alternatives considered

- **Keep it on every pull request.** Rejected: 1 failure in 153 runs, on `main`,
  does not justify a Windows runner on every PR.
- **Make it non-blocking (`continue-on-error`) instead.** Rejected: a
  non-blocking job still consumes the runner and no longer gates `main` at all.
- **Run it on pull requests whose diff touches chaos-relevant paths.**
  Deferred on 2026-09-09, adopted on 2026-11-05 after a deterministic store
  regression reached `main` (see the amendments above). Running a check when its
  inputs change is the better mechanism.
- **Delete the chaos suite.** Rejected: it has found real defects (a SQLite
  handle left open when a migration failed, which pinned the file on Windows).
- **Move the research characterization job instead.** Not applicable: it is
  already non-blocking, and it failed 4 times in 130 runs.

## Verification

Verified as of 2026-09-09:

- The `chaos` job declares a push-only condition, so pull requests skip it.
- `all-checks-passed` accepts `skipped` for `chaos`, so a pull request still
  reports green while a `main` push still requires a real success.
- `npm run test:chaos`, `verify:chaos` and the `chaos` route are unchanged.

Re-verified as of 2026-11-05, after the amendments:

- The `changes` job publishes `code` and `store` from one diff read; a push
  event sets both to `true` so `main` behaviour is unchanged.
- `chaos` runs when `store` is `true`; the pull-request path was exercised by the
  truncated-WAL fix itself, which touches `src/core/store/`.
- A documentation-only diff selects the `docs` job and skips the code jobs;
  `all-checks-passed` accepts a skipped code job only when `code` is `false`.
- `main` carries no branch protection, so a skipped job cannot block a merge;
  the aggregate is advisory and the jobs above are what actually report.

## Deferred

- The window is 19 days and 145 runs. A longer window would firm up the 0.65%.

## Consequences

- A pull request no longer spends a Windows runner unless it touches the store
  or the chaos tests. The class that went red on `main` for three days is now
  caught on the pull request that introduces it.
- A documentation-only pull request no longer builds the product or runs the
  coverage suite; it still runs every documentation contract, so prose cannot
  land unchecked.
- Pull-request wall clock does not change for code changes. The jobs run in
  parallel and the product job (70–108 s) is the critical path, longer than
  chaos (58–101 s). What this saves is runner minutes, not the time a pull
  request waits.
- A green `All checks passed` on a pull request now means "every check that was
  required here ran and passed". The scope job decides what was required, so a
  wrong scope decision is visible in that job's output rather than inferred.
