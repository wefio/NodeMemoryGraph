# `agent:verify` restates a failing check's output and names the evidence file

**Status:** implemented
**Approved:** explicit
**Relates to:** [repository development skill](../../../skills/repo-development/SKILL.md),
[CI and quality design](../../design/ci-cd-and-quality.md),
[long detached checks](2026-09-18-detached-long-checks.md)

Governing meta-rule: [self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) —
this change alters verification tooling, so it carries its own decision and alternatives.

中文版: [2026-09-18-verify-summary-restates-the-failure.zh-CN.md](2026-09-18-verify-summary-restates-the-failure.zh-CN.md)

## Problem

On 2026-09-18 a run of `npm run agent:verify -- <paths>` reported

```text
- [blocking] npm run test:product: failed (command exited with code 1)
```

and nothing else was visible where the reader looked. The same suite passed 1433/0 when run
standalone minutes later, so the run could not be classified as a regression, a flake, or a
real assertion failure — the evidence needed to tell them apart was not in front of the reader.

The first diagnosis was a swallowed failure, and reading the code disproved it. There is no
swallowed exception and no silent path:

- `runCommand` (`tools/agent-verify.ts`) captures stdout+stderr and keeps
  `output: ok ? undefined : output.slice(-8000)` for exactly this purpose.
- `runNpmScriptCheck` (`src/rcp/verification.ts`) streams the captured output back when it is
  not quiet, and both callers pass `!json` — so the route plan _and_ the narrow path print the
  failing check's own words, in check order, _above_ the summary.
- What erased them here was `| tail -20`, the ordinary way to read a long run's result.

Two real gaps remained after that:

1. The summary line carries only `reason` — an exit code — and never the `output` the runner
   went out of its way to keep. So the verdict and its cause are separated by however many
   lines the streamed output occupied, which is exactly what a scrollback or a pipe eats.
2. Text mode printed the RCP receipt path but never the path to `.nmg/verification/latest.json`,
   the file that holds the full structured evidence; only `--json` carried `evidencePath`.

A third, incidental finding: a test runs the CLI with `--root <the repository> --dry-run`, and
the tool persists evidence even for a dry run, so the product suite overwrites the repository's
own verification evidence. Measured: after a real run, `latest.json` held
`scopes: [".gitignore"]` with every check `skipped` / `dry run`.

## Decision

1. **Text mode restates the tail of a failed check.** Under each failed check's summary line,
   print the last 10 non-empty lines of its captured output, indented with `| `, each line
   capped at 300 characters, followed by a marker that names the truncation and points at the
   evidence file. Passing and skipped checks print nothing extra.
2. **Text mode always names the evidence file** (`Evidence: <path>`). `--json` keeps its
   `evidencePath` field and its already-complete `output`.
3. **A test must not write the repository's evidence.** The dry-run case that roots the CLI at
   the repository passes `--output <temp>/verification.json`, so running the product suite no
   longer overwrites `.nmg/verification/latest.json`.

What this deliberately is not: a change to streaming. The check's output still streams while it
runs; the summary restates a bounded tail next to the verdict, because the two facts a reader
needs first — what failed and why — should not require scrolling.

## Alternatives considered

- **Treat it as a swallowed failure and add logging around the check.** Rejected on evidence:
  nothing is swallowed, `spawnSync` returns the output, the runner stores it and the streaming
  path already prints it. More `try`/`catch` would have added code to a non-existent defect.
- **Stop streaming and show only the summary tail.** Rejected. A long check's progress is worth
  watching while it runs, and a failure that only appears at the end is harder to attribute to
  the step that produced it.
- **Print the whole captured output in the summary.** Rejected: it duplicates the stream and can
  be up to 8 000 characters, which is the flooding this summary exists to avoid.
- **Print only the evidence path, with no tail.** The cheapest honest option, and the one closest
  to "the tool already wrote it down". Rejected because it lands in the exact situation this
  record comes from: the reader has the last screen, the failure is off it, and the path alone
  costs another round trip to a file they must search by hand.
- **Change JSON mode too.** Rejected: machine consumers already receive the full `output` field;
  only the human summary was missing anything.

## Consequences

- A failure is readable in one place: verdict, exit reason, the command's own last lines, and
  where the whole text lives.
- The added output is bounded (10 lines, ≤300 characters each) per failed check, so it cannot
  flood a terminal, and a run with several failing checks grows by roughly that much each.
- `.nmg/verification/latest.json` becomes load-bearing for humans, not only for machine
  consumers — which is precisely why decision 3 was needed in the same change.
- The recorded diagnosis is part of the value: the next reader who sees a silent-looking
  failure in a piped view has the measurement, not the guess, to tell "the output was cut by
  the pipe" from "the tool dropped it".

## Deferred

- **Dry runs still persist evidence.** Decision 3 stops tests from overwriting the repository's
  evidence, but `agent:verify --dry-run` still writes `.nmg/verification/latest.json`, so a human
  dry run can still replace the last real result with a plan whose checks are all `skipped`.
  Revisit if that ever misleads a decision.
- **A `--verbose` flag for the complete output.** The summary tail is deliberately bounded; if a
  real failure needs more than 10 lines in place, the extension is a flag rather than a larger
  default.
- **The known `test:product` parallel-load failure.** The run that started this record may have
  been the flake recorded twice before. This change makes that failure diagnosable in place; it
  does not identify the flake, and the difference between the two is now one screen instead of
  one tool call.
