# 0004 - "Flaky" was a clock boundary

[中文](0004-flaky-was-a-clock-boundary.zh-CN.md)

**Status:** resolved

## Executive summary

`npm run test:product` failed once, under load, in `demoteMemory: demotes LTG memory to STG`. A previous
session recorded it in the ledger as *flaky, not fixed* and moved on; the entry name was the whole
diagnosis, and it closed the question for a session. Run under a loop instead of once, it reproduced in
about 1 write per 1500: a memory was written with `valid_from = …38.468Z` and read back while SQLite's
`now` said `…38.467Z`, so the read path's `valid_from <= now` was false, the row was invisible, and the
caller got `memory <id> is not active` for a memory it had just written. The defect is real and lives in
the product's current-value window: two clock readers (JavaScript's `Date` and SQLite's `strftime('now')`)
disagree at millisecond granularity.

## Summary

The current-value predicate compares a stored timestamp against SQLite's own clock, four times in
`src/core/store/base.ts` and `src/core/store/retrieval.ts`. Writes stamp from JavaScript, so the two
sources race: whenever the row's stamp lands within ~1-2 ms *after* the reading connection's `now`, a
predicate that means "this value is in force" answers "no" for a row that was written microseconds ago.
Under a loaded machine the skew widens; the loop that found it needed 3000 iterations to see 2-4 hits.

The fix keeps the comparison but widens the window by a named grace, in one new home,
`src/core/store/clock.ts`: `CLOCK_GRACE_MS = 50`, with `clockNow("later" | "earlier")` feeding the four
predicates. The grace only ever *widens* what counts as current - it never narrows - so the change cannot
hide an expiry, and the two directions are separate so the asymmetry is visible at each site. Measured
after the change: 3000 iterations, 0 failures (was 2-4).

SQLite has no `milliseconds` date modifier: `'+50 milliseconds'` makes `strftime` return `NULL`, and the
comparison then excludes **every** row silently (`ok: null`), which is why the grace is expressed as
fractional seconds (`'+0.050 seconds'`) and why a mutant now pins that choice.

## Impact

A memory written within about a millisecond of being read could be invisible to one read: the write
succeeded, the row was stored, and the *next* read saw it. No durable loss and no corruption - the failure
mode is a single false "not active" answer, which surfaces as an error from `requireActiveMemory` or as a
missing row in maintenance, demotion, dedup and search paths. It reached a product test only because that
test reads a just-written memory in a tight loop; under load a user-visible `not active` error for a
just-saved memory was possible.

The second, larger impact is the one this record exists for: the defect was **labelled** instead of
diagnosed. "Flaky, not fixed" is a statement about a test, and it was written down as a fact about the
product - and a labelled failure is a failure nobody has to look at again.

## Timeline

- `npm run test:product` reports 1 failure of 1447 under load: `demoteMemory: demotes LTG memory to STG`.
- A previous session re-runs the suite alone, sees it pass, and records the row as "flaky, not fixed".
- In this session the user refuses that label: a failure appearing more than once has to be treated as a
  case.
- A loop harness (`.temp/flake-hunt.ts`) writes and immediately reads a memory: 2 failures in 3000
  iterations, both `memory … is not active` for a row that exists.
- Dumping the row and SQLite's `now` side by side shows the 1 ms order: stamp `…38.468Z`, `now` `…38.467Z`.
- Fix: the window's grace, in `src/core/store/clock.ts`, wired into the four predicates. Loop: 0 of 3000.
- A deterministic test (`tests/core/store/current-value-window.test.ts`, 6 cases) pins both boundaries, and
  4 named mutants (2 on the boundaries, 1 on the grace, 1 on the SQLite time unit) make the pin checkable:
  4 of 4 caught.
- The ledger row is corrected from "flaky, not fixed" to the fixed defect with its reproduction rate.

## Root cause

Two mechanisms again, and the second one is the reason the first survived.

The technical one: the "is this value in force" predicate compares timestamps written by two different
clock readers. JavaScript stamps `valid_from`; SQLite supplies `now` at read time. Two readers of the same
wall clock do not return the same instant, and the comparison is strict - so a difference of one
millisecond in the wrong direction makes a fresh row look like a future one. Nothing in the code said
which clock had authority, because both were "the clock".

The process one: an intermittent failure that passes on re-run is easy to file as flakiness, and the
ledger made that filing *look* like a result. "Flaky, not fixed" has no reproduction attempt attached, no
rate, and no hypothesis - it is a label wearing a diagnosis's clothes. The failure reappeared later in the
session, which is the evidence that the label was wrong; without the user's push it would have been
labelled a second time.

## Guardrails added

- `src/core/store/clock.ts` is the single home for the current-value window's grace, so a future predicate
  has one place to read it from instead of hand-writing another comparison.
- `tests/core/store/current-value-window.test.ts` (6 cases) makes the boundary deterministic: a value
  stamped half a grace in the future is current; a minute in the future is not; the same on the expiry
  side; 400 write-then-read rounds never fail; and the window widens on both boundaries and never narrows.
- 4 named mutants in `tools/mutation-teeth.ts` (own target for `src/core/store/clock.ts`) make the test's
  teeth checkable, including the SQLite time unit that silently excluded every row.
- The ledger's `test:product` row no longer says "flaky": an intermittent failure is recorded with its
  reproduction attempt and rate, or it is recorded as open. The rule's home is
  [`skills/repo-development/SKILL.md`](../../skills/repo-development/SKILL.md).

## Lessons

- An intermittent failure is evidence of a timing dependency until a reproduction says otherwise. "Flaky"
  is a claim about a test; it is not a diagnosis, and it must not be recorded as one.
- When two readers of the same quantity disagree, the code has to say which one is authoritative - or, as
  here, deliberately widen the comparison so that neither is asked for an impossible precision.
- A wrong answer from a *silently* NULL expression is worse than an exception: `strftime` with an unknown
  modifier excluded every row and reported `ok: null`. A mutant is what makes that reachable-in-theory
  mistake permanent.
- Labelling is cheap, and that is exactly why it is dangerous: the cost of a wrong label shows up in a
  later session, under someone else's deadline.
