# When the chain path may be entered

[中文](2026-09-19-when-the-chain-path-may-be-entered.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [A unit's session comes from the board](2026-09-19-session-identity-comes-from-the-board.md), [The fusion session mechanism](2026-09-19-fusion-session-mechanism.md), [Fusion planning: repair-first online, ceiling offline](2026-09-19-fusion-planning-repair-first.md)

## Problem

The arm programme's measurement phase closed on 2026-09-19, and it settled a direction without settling
economics. What it did not decide is the rule that lets a run enter the chain path at all. Until now the
only thing that entered it was a spec declaring `fusion.unitsPerSession`, which is a measurement artifact,
and the arms' driver refused a live fused run without `--session-runner` - a capability check in a
research instrument, not a product rule. So "when may one session carry several units?" was being answered
by whoever wrote the spec, which is the wrong home for a rule the product obeys.

## Decision

**Fusion is decided by the shared runtime. The adapter supplies session capability and decides nothing.**

Entering the chain path requires all three conditions. A missing one means the run proceeds unfused rather
than failing - an unfused run is the honest default, not a degraded mode:

1. **The semantics allow it.** `sharedSessionLegal` stays the only legality rule: the successor is legal
   against the plan and the facts, and the constraints it names - authority, the frozen input version,
   cancellation, unmet dependencies - hold at this boundary.
2. **A continuable task exists.** The next legal successor is ready at the boundary; a declared external
   wait that is not ready is not a continuable task, and a session does not start to sit idle on one.
3. **The host supports session reuse.** The adapter reports a session runner. With no runner the unit runs
   in a fresh session, and the report says so rather than pretending to continue.

**The board carries claims, acceptance and facts; the adapter carries session capability.** The decision
and the move it produced are written as a run fact (`session-move`, with the facts it used), so a move is
replayable rather than reconstructed. Nothing new is invented for this: no tool, no store column, no
notation inside an entry's prose.

**Fusion may not relax correctness.** Every task is still checked on its own, in the same four places it was
before: permission (the managed-write fence and the authority it resolves), input version (the frozen plan
and the dependency the unit was prepared from), cancellation state (`taskCancellation` - a run-level cancel
applies to every task, a task-level one only to itself), and acceptance (the unit's own check). The parent
task still accepts jointly, and that joint acceptance is the only thing that can accept the composed
result; a fused session does not become an acceptance path of its own.

**What is announced now is permission - when the chain path may be entered. Economics is not announced**:
no claim is made that fusing is more economical, in tokens or in money (see Deferred).

**The measurement this rests on**, in the shape the programme closed with
([P6 of the arm plan](../../experiments/execution/ooo-arm-plan-2026-09-19.md), and the computed
[matrix](../../experiments/execution/archive/ooo-arms-2026-09-19/matrix.json)):

- **Observed.** On this task shape the coarse arm is the fastest, fine granularity adds overhead, and the
  second slot and fusion each recover part of it (A 9 726 ms; B 22 579 ms median; C 18 950 ms median;
  cap 2 17 735 ms median).
- **Replicated.** Within the chain path, a bound of two is faster than a bound of one: 8 451 ms at rate
  grade, three reps per cell, against a larger within-cell spread of 1 783 ms.
- **Not determined.** The chain path's own cost (3 607 ms against a 3 566 ms threshold, the narrowest
  reading in the matrix, and its token side does not separate), the default bound (1 090 ms against
  1 142 ms at pair grade), and any general statement about cost against benefit.
- **Closed.** The evidence is enough to guide the next step, and no further samples are bought.

## Alternatives considered

- **Declare the economics from the cap cells.** Rejected: their token column did not survive three reps
  (a spread of 11 946 wider than the 7 789-token gap it would be compared across), and their cost cannot be
  recovered at all - the reports predate the usage split. "Fusing pays" is a claim these samples cannot
  carry, so it is not made.
- **Let the adapter decide, or let the spec.** Rejected: policy inside an adapter is what the
  harness-adapter boundary forbids, and a spec is a measurement artifact the product does not have.
- **A default bound - fuse up to N units whenever the plan is a chain.** Rejected for now, because the
  default is the thing that is not determined, and the chain surface is not free: declaring fusion at a
  bound of one costs 3 607 ms over the plain path for the same plan.
- **A feature switch.** Rejected: the three conditions above _are_ the switch, and a flag would give them a
  second home that can disagree with them.

## Consequences

- **Unfused by default.** A plan with no legal successor, a boundary with no continuable task, or a host
  with no runner all look exactly as they did before this decision.
- **The conditions are code, not prose.** `sharedSessionLegal` decides semantics, the legal set at the
  boundary decides continuability, and the adapter's runner decides capability. The capability check is
  measured rather than assumed: when the arms' driver was run fused without `--session-runner` it recorded
  `incomplete`, named the session it could not continue, and spent only the first unit's tokens.
- **Replayable decisions.** The move and the facts it used are a run fact, read back as of a sequence
  number.
- **Parents keep the last word.** A unit's acceptance is not the composed result, and the parent check is
  unchanged by whether the units shared a session.
- **The measurements stay measurements.** The cap and D cells' specs still declare `fusion`, which is how
  the research instrument varies its one variable; that declaration is not the product's rule, and the
  driver refusing a fused spec without a runner is the boundary between the two.

## Deferred

- **The product-side entry, and the executor it would need.** The product has no loop that runs a unit:
  `src/integration/ooo-execution.ts` holds the legality and selection decisions as pure functions, the
  coordinator governs runs (register, freeze, bind, adopt, cancel, status) and the extension offers the
  worker's tool surface, but nothing in the product decides "admit the next unit or close the session",
  obtains a runner and runs the unit. Every caller of `decideSessionMove` and `openUnitSession` today is a
  test, and every caller of a session runner is the arms' driver or the extension's own live path - both
  reached from `evals/`. So this record announces permission and the conditions on it, _not_ a product
  behaviour: the rule is enforced where the decision is made, and nothing in the product reaches it yet.
  Wiring it is therefore not one call site but a product-side executor, which is its own decision.
- **The default bound.** Nothing is declared beyond "one unit per session unless the caller declares
  otherwise".
- **The price of fusing.** A priced comparison needs reps of both surfaces under one instrument and its own
  named ceiling. The programme's plan records this as closed rather than pending, and any future sample
  starts from a named ceiling.
