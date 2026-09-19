# Widen the current-value window by a named clock grace

[中文](2026-09-18-clock-grace-window.zh-CN.md)

**Status:** implemented
**Approved:** explicit

## Problem

The store decides whether a memory is current by comparing a stored timestamp with SQLite's own clock:
`valid_from <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` and the matching expiry test, in four predicates
(`src/core/store/base.ts`, `src/core/store/retrieval.ts`). Writes stamp `valid_from` from JavaScript.

Two readers of one wall clock do not return the same instant. Under load the disagreement reaches 1-2 ms,
and when a row's stamp lands *after* the reading connection's `now`, the predicate answers "not current"
for a memory written microseconds earlier. Measured: a write-then-read loop failed 2 of 3000 iterations
(`memory … is not active` for a row that exists), with the stamp at `…38.468Z` and `now` at `…38.467Z`
([post-mortem 0004](../../postmortem/0004-flaky-was-a-clock-boundary.md)).

The product consequence is one false "not active" answer on a just-written memory — an error from
`requireActiveMemory`, or a missing row in maintenance, demotion, dedup and search.

## Decision

Read the window's boundaries through one named grace in a single home, `src/core/store/clock.ts`:
`CLOCK_GRACE_MS = 50`, with `clockNow("later")` widening the `valid_from` bound and
`clockNow("earlier")` widening the expiry bound, expressed as fractional seconds (`'+0.050 seconds'`).
The grace only ever **widens** what counts as current; it never narrows. The four predicates call the
helpers instead of writing their own comparison.

## Alternatives considered

- **Truncate both sides to seconds.** Rejected: the timestamps are ISO strings compared lexicographically,
  so truncation has to be textual — `'…38Z'` and `'…38.467Z'` compare `'Z' > '.'`, and the comparison
  would depend on the shape of the literal rather than on time.
- **Stamp `valid_from` from SQLite's clock in the write path.** Rejected: it removes the skew only for
  values the store itself stamps, and `valid_until`/`expires_at` can be supplied by the caller, so the
  same disagreement survives on the other boundary.
- **Make one clock authoritative for every read and write.** Rejected as the larger change with the same
  failure mode: any conversion or caching of "the instant" re-introduces the comparison, and a shared
  connection-level timestamp is not what the predicate needs.
- **A larger arbitrary grace (a second, a minute).** Rejected: it widens the real window in which an
  expired-but-graced value is still readable, and it makes the reason for the number unreadable. 50 ms is
  a named multiple of the measured skew, and the direction of the widening is asserted by a test.
- **Leave it and re-run the failing suite until it passes.** Rejected: that is what produced the
  "flaky, not fixed" ledger row this change exists to correct.

## Consequences

- A value whose stamp is up to half a grace in the future, or whose expiry passed up to half a grace ago,
  reads as current. Both directions are asserted by `tests/core/store/current-value-window.test.ts`
  (6 cases, including 400 write-then-read rounds), and four named mutants in `tools/mutation-teeth.ts`
  hold the teeth: dropping the grace on either boundary, setting it to zero, and using a SQLite time unit
  that does not exist (which makes `strftime` return `NULL` and silently excludes every row).
- The four predicate sites are no longer the home of the window: a future predicate reads the grace from
  `clock.ts` rather than hand-writing another comparison.
- The grace is a wall-clock constant, so it does not adapt to a machine whose skew exceeds it; the
  measured skew is 1-2 ms and the number has 25× headroom, but a clock jumping backwards by more than the
  grace still excludes a row until it catches up.
- The window is widened for every current-value read, including paths that never write in the same
  process, so the change is not scoped to the tests that failed.
