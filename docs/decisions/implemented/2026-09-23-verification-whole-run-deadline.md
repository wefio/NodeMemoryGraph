# Bound agent verification as one run

[中文](2026-09-23-verification-whole-run-deadline.zh-CN.md)

**Status:** implemented
**Approved:** explicit

## Problem

`agent:verify --timeout-ms` previously gave every serial check a fresh timeout. A
150-second setting could therefore take many times 150 seconds and did not meet
the requested time to a result.

## Decision

Use 150 seconds as the default budget for the entire `npm run agent:verify`
invocation. `--timeout-ms` adjusts that total budget. An outer watchdog returns
an incomplete failure and writes failure evidence if setup or other synchronous
work exceeds it. Direct, RCP full, and RCP narrow checks receive only the
remaining time. Once the budget is exhausted, pending checks are recorded as
failed without being started, and the final verdict fails. A partial set of
passed checks cannot be promoted to a passing verification.

The Agent verifier's `ci-and-tests` route declares the atomic checks of the
`verify:static` package contract and `test:product`. The full plan deduplicates
identical check names across routes, executes each atomic check once, and keeps
its own result and route attribution. A test checks that this route stays equal
to the static package contract. CI retains `verify:static` as its reproducible
named entry point.

The non-RCP full Agent plan runs adjacent independent static checks in bounded
groups of three, respecting build, package and product-test barriers. The approved
group includes tests-surface type checking, anchor resolution and policy-word
checking; none rewrites root source or `dist`. Subpackage building and complexity
probes use separate paths. The plan keeps declaration-order results, per-check
failures, and one shared deadline. RCP and narrow verification retain their
existing serial execution.

`test:product` uses at most eight Node test-file workers. Its file globs, test
bodies, failure rules and cleanup contracts are unchanged; coverage retains its
two-worker setting and full file inventory. This uses the existing Node scheduler,
not fixed partitions, impact-selected subsets or overlap with generated-file
writers. The [margin observation](../../experiments/verification/full-gate-margin-2026-10-09.md)
records the workload and repeat-run measurements.

## Alternatives considered

- Keep a timeout for each command. Rejected because serial checks can exceed
  the requested result time by a large multiple.
- Stop without recording pending checks. Rejected because a missing check is easy
  to mistake for an irrelevant check.
- Run `verify:static` and its constituent checks again as independent route
  checks. Rejected because repeated work spends the same run budget without
  adding independent coverage. Skipping the independent results instead would
  lose per-check attribution.
- Launch every blocking check together. Rejected because build and packaging
  rewrite generated files that other checks read, and an unrestricted process
  burst competes with the product suite.

## Consequences

- A timeout is an incomplete verification requiring remediation and a new run.
- The outer process bounds the official CLI's result time. It kills the direct
  verifier process on timeout, but cannot guarantee that npm's descendant
  processes have exited; a later run must inspect a live mutation lock before
  trusting the tree.
- The Agent plan has more individually attributed check results, but does not
  repeat static checks already shared by other routes. CI's contract is unchanged.
- Bounded concurrency shortens the measured critical path, but CPU-heavy checks
  may take longer under contention. Timing evidence is scoped to the measured
  workload and machine; it is not a universal worst-case guarantee. The unchanged
  150-second deadline still fails closed if a run cannot finish.
