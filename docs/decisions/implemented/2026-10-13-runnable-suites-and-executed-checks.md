# Separate runnable suites from test inputs, and passes from skipped checks

[中文](2026-10-13-runnable-suites-and-executed-checks.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Visible non-blocking research](2026-09-12-visible-non-blocking-research-track.md), [Archived run acknowledgement](2026-09-19-acknowledge-archived-run-directories.md)

## Problem

The on-demand workflow ran every file the CI coverage inventory called unreached.
That set included frozen evaluation checks beside deliberately unimplemented inputs,
and tests preserved inside a rejected candidate's archive. Running the report's
`alpha.test.ts` directly failed at its intended `not implemented` stub, rather than
measuring a candidate prepared by the evaluation harness.

The Tensor heap check used a passing assertion when explicit GC was unavailable.
The HA stress test checked NaNs but conditionally omitted its heap observation,
while one passing name claimed both checks. Successful execution and missing
prerequisites were therefore indistinguishable in those results.

## Decision

The owning contract is [CI and test execution](../../design/ci-cd-and-quality.md#3-ci-契约).
The CI coverage tool keeps the complete tracked unreached inventory and preserves
fail-closed reporting of unacknowledged gaps. Its single acknowledged-root table
also records standalone execution eligibility; the specific evaluation fixture
root precedes its broader harness root. `--list` emits only runnable entries, not
fixture inputs or archived evidence. The workflow preserves each selected path as
one argument, retains Node failures through `pipefail`, and writes skipped TAP for
an empty selection instead of triggering Node's automatic test discovery.

The [test-runtime section](../../design/ci-cd-and-quality.md#4-可组合测试运行时)
owns the GC prerequisite. Missing GC produces a real `node:test` skip. HA NaN stress
and heap growth have separate literal names, so the former still runs without GC.
The propagation loop is a local ordinary function; it retains the NaN check, operation
order and iteration count. The existing allocation counts and heap limits remain
unchanged. Native child-process regressions exercise both GC states and verify
their actual TAP statuses without inheriting the parent's `NODE_TEST_CONTEXT`.

## Alternatives considered

- **Hide fixture and archive files from discovery.** This would erase their
  inventory and acknowledgement reasons. Execution filtering is a separate view,
  not removal of evidence or blanket exemption of arbitrary `fixtures` paths.
- **Make fixture stubs pass in place.** Their frozen checks judge candidate work;
  implementing the input to satisfy the wrong runner would change the instrument.
- **Duplicate exclusions in workflow shell.** This creates two classification
  owners. The workflow consumes the tool's runnable view instead.
- **Skip all HA stress when GC is missing, or enable GC for every product worker.**
  The first loses the independent numerical check; the second expands a local
  prerequisite to unrelated tests. Separate named judgments preserve both scopes.
- **Introduce a general case DSL or operator registry.** These reporting repairs
  need only ordinary functions, data and assertions; they do not justify changing
  other test styles or migrating unrelated consumers.

## Consequences

Fixture checks remain available to their harness and archives remain intact.
Default CI coverage obligations and the opt-in workflow's non-blocking status do
not change. Empty selection, whitespace-bearing paths, unknown CI gaps and failing
Node commands have explicit regressions over a synthetic Git repository and the
real workflow shell body. On Windows those tests use Git Bash, not the WSL launcher.

A default product run can legitimately report heap checks as skipped; explicit
`--expose-gc` execution measures those existing heap witnesses. Passing either
check is not a proof that all allocations are leak-free. Local Windows tests do
not claim a GitHub workflow dispatch or Linux execution, and no live provider or
complete benchmark is required by this change.

## Deferred

The derived ten-suite set ran on Windows with 86 passed and five failed out of
91 tests, both in the fix worktree and at unchanged baseline `e5b19733`. The five
failures are in `evals/ooo-execution/recovery.test.ts`: those cases read
`ticket.patch.digest`, while the debugger observes no `patch` in the current
claim ticket. Reproduce with
`node --experimental-strip-types --test evals/ooo-execution/recovery.test.ts`.
Those recovery assumptions remain outside this reporting repair; the suites stay
selected and their failures stay visible. Neither the selected-set run nor a
passing product gate establishes that the on-demand workflow is wholly green.
