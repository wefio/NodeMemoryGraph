# Fusion planning: repair-first online, ceiling offline

[中文](2026-09-19-fusion-planning-repair-first.zh-CN.md)

**Status:** implemented
**Approved:** explicit

The design this implements is [docs/design/ooo-fusion-planning.md](../../design/ooo-fusion-planning.md).

## Problem

Fusion had one policy knob - how many units one session may carry - and a bound is not a decision: it
does not choose among legal successors, and it cannot say whether fusing is worth taking. The measured
shape is narrow (the D arm: about 1 900 ms of session startup saved per avoided session, tokens flat,
against a union tool surface that costs a chain's first unit about 0.7 k extra tokens), so what was
missing was an offline ceiling that prices fusion, and a statement of what the online move actually is.

## Decision

Split fusion planning into two clocks, and write down neither as a plan.

- **Online** is one move about the current session: *admit* the next legal successor or *close* the
  session, naming the condition that closed it. A fused session is irreversible, so no move may
  rewrite it.
- **Repair-first**: the default is to continue; only a declared change (rejected verdict, cancellation,
  an unmet dependency, a declared external wait that is not ready) may end a session early. Repairing
  keeps every commitment intact and decides only about what has not run.
- **Baseline**: a move is not revisited while its facts hold, and the same plan plus the same facts
  yield the same move, ties broken by plan order. Without determinism two runs of one plan are not
  comparable, which is what the arms need.
- **The cost model is read-only online**: fitted offline, frozen for a run. A query optimizer re-plans
  at a boundary against collected statistics and never re-collects them mid-query.
- **Offline** computes a ceiling from an optimistic projection of the plan, fed to the *same*
  `sharedSessionLegal` so the five conditions keep one home: a floor from the minimum chain cover
  (Dilworth: equal to the maximum antichain, computed as `units - maximumMatching` over the relation's
  transitive closure) and a feasible bound from greedy list scheduling at a declared cap.

## Alternatives considered

- **A chain-cover compiler plus a plan cache.** Recomputing a move is a pure function over a few dozen
  units, so the compile/interpret distinction a tensor graph needs - an expensive artifact used many
  times - does not arise; deciding again is cheaper than invalidating correctly. Rejected.
- **Full re-planning every boundary.** Documented as the churn side of the repair-versus-replan
  trade-off, and it can oscillate without new facts. Rejected in favour of repair-first.
- **Plan competition, eddies, speculative execution.** Borrowed from query optimization, they assume
  re-running is nearly free and replayable; a unit is a paid, irreversible model call. Rejected.
- **Taking the ceiling as a runtime policy.** It is computed from facts a run does not have yet.
  Rejected.
- **Fitting the cost model with the repository's autodiff from the paid runs.** Attempted; the fit had
  leave-one-out residuals up to 12 k tokens against an 11 k mean, and the session-startup term was not
  identifiable because the arm held unit count constant. The blocker is a designed matrix, not an
  optimizer, so the ceiling reports the measured constant instead of a fitted coefficient.

## Consequences

- The question "how much is fusion worth" becomes offline and free: sessions required at caps 1 to 4,
  the floor, and milliseconds saved against the measured startup.
- The union tool surface's extra turn and the context a longer chain resends are *not* modelled; they
  are named in the design so a chain is never assumed free.
- The ceiling reproduces the one paid measurement: for the D arm's own plan it predicts 1 900 ms saved at cap 2, and the arm measured 12 948 ms against 11 048 ms. On the two multi-unit fixtures it reports a floor of 1 session and 3.8 s saved at cap 2, 5.7 s at cap 4 - and says cap 3 buys nothing over cap 2 on those shapes, so the money is in reaching four units per session.
- The relation is not a partial order on its own: two independent units with compatible declarations may each follow the other, so the offline graph is restricted to plan order before a chain cover can be computed.
- If the structural relation is not transitive on a real plan, the floor does not apply and the
  measurement says so; the list-scheduling bound stands on its own.
- A move must be recorded with the facts it used, or "baseline" is unfalsifiable.
- Speculation and caching stay unbuilt, and nothing in this change widens `sharedSessionLegal`.
