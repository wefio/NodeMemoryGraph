# The traceability report is evidence, not a count

[中文](2026-09-20-rtm-evidence-aggregation.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Requirements traceability matrix](2026-09-08-requirements-traceability-matrix.md), [Assertion domain and strength](2026-09-09-assertion-domain-and-strength.md), [Tests do not need a filesystem](2026-09-20-tests-need-no-filesystem.md)

## Problem

`rtm:check` printed an inventory and called part of it proven. An assertion counted as `proven` when its
`strength` was `decision` and its `check` id resolved - and resolving an id only proves that a script or
a named test exists. Nothing in the report said whether that check ran, whether it passed, or whether a
recorded reading was about the revision in front of the reader. A green run therefore read as assurance
over claims that no execution had touched, which is the shape the evidence rules refuse: a reader could
derive a conclusion from bound counts, coverage or a pass rate.

The aggregation was also incomplete in the other direction. Declarations were read, but execution results,
valid historical evidence, assumptions and open counterexamples were not combined into one report, and
neither risk classes nor contracts that span several modules were judged separately - so an assertion
about a one-line helper and one about a cross-module boundary appeared in the same total.

## Decision

**One report that separates what is declared from what was executed, and decides each item on its own
evidence.**

- The inventory stays and stays a count: contracts, assertions, bound checks, documented-only, uncovered,
  orphans. No field or line of it feeds a verdict, and the report ends by saying so.
- Every assertion gets a standing from its own evidence, taken from what `agent:verify` records in
  `.nmg/verification/latest.json` (the commands it ran, with their status, and the revision they ran at):
  - `executed` - the commands that carry the assertion are recorded as passed **and** the evidence is at
    the revision in front of us.
  - `historical` - they passed at another revision. A reading about a different tree is reported as such
    and is never counted as execution.
  - `not-run` - the run recorded the command as skipped or failed, with the recorded reason. A **failure**
    in the current run is the only one of these that fails the gate; a skip says the assertion was not
    exercised, not that it is wrong.
  - `not-recorded` - no entry for the command, no command carrying the check, or no evidence file at all.
    Absence of evidence is a gap, not a rejected claim, so it does not fail a fresh clone.
  - `documented-only` and `uncovered` keep their existing meaning.
- Each risk class - strength, kind and stage as one class - is listed with its own standings and is never
  summed with another. A contract whose scope `selectRoutes` resolves to more than one route is listed as
  a cross-module change with its own routes and its own executed/not-executed counts.
- Assumptions are reported with the ids that resolve nowhere, and everything still open is listed as a
  counterexample: uncovered claims, orphan checks, declared gaps, unsatisfied assumptions and assertions
  with no execution evidence.

## Alternatives considered

- **Keep the counts and add a pass rate.** Rejected: that is the aggregation the evidence rules forbid,
  and a percentage over bound checks is exactly the number a reader would quote instead of the standings.
- **Read per-named-test results from the run's output.** The recorded evidence names the commands it ran,
  not the cases inside them; a per-case reader would mean `rtm:check` running the suites itself, and this
  gate is a static check over declarations and already-recorded results.
- **Count any recorded passing run as execution, whatever revision it was at.** Rejected: a passing
  reading from another revision is the class of error the evidence rules name, so it is reported as
  historical instead.
- **Require a current evidence file and fail without one.** Rejected: `verify:static` runs in clean
  checkouts where no run has happened, and failing there would make the gate depend on local history.
- **Judge the whole change with one verdict per risk class.** Rejected: a class total hides which
  assertion inside it is unexecuted, and the point of the report is that a reader can see that.

## Consequences

- `rtm:check` now fails closed on exactly: a check that does not resolve, an assumption that resolves
  nowhere, a contract that does not compile, and a current recorded failure of a command carrying an
  assertion. Everything else is reported as a standing with its evidence.
- The report is longer - one line per assertion, plus a line per risk class and per cross-module contract -
  and the printed report is what the digest-bound receipt captures.
- `proven` was renamed `decision`: the old name claimed over the check's subject exactly what binding a
  check id cannot give.
- The report's `execution` section names the revision and how many files were dirty in the run it read,
  so a reader can tell a reading taken over this tree from one taken over another.

## Deferred

- **Per-case execution evidence.** The standing is decided per assertion through the commands that carry
  it; a named test inside a suite is not separately recorded. Reading it per case would need the runner to
  record per-case results, which is a change to `agent:verify`'s evidence format rather than to this gate.
