# Fusion and speculation: offline first, then a budgeted pilot

[中文](2026-09-18-fusion-and-speculation-pilot.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [task-unit-semantics design](../../design/task-unit-semantics.md) (§融合, §严格语义怎样重新打开推测),
[its obligations ledger](../../design/task-unit-semantics-obligations.md),
[the arms get their own driver](../implemented/2026-09-17-arms-get-their-own-driver.md),
[the declared slot budget](../implemented/2026-09-18-declared-slot-budget.md),
[the arms pilot](../../experiments/execution/ooo-arms-pilot-2026-09-18.md),
[the cost model record](../../experiments/execution/ooo-cost-model-2026-09-17.md),
[the older speculation proposal](2026-09-11-ooo-speculation.md)

> **Updated 2026-09-18: F4's offline half has landed, and the live half is blocked by a measured harness fact.**
> The rules, the accounting and the driver policy are in
> [fusion legality is a pair predicate](../implemented/2026-09-18-fusion-legality-and-accounting.md)
> (12 product cases / 8 mutants, 12 cost-model cases / 4 mutants, 15 driver cases / 12 mutants).
> The paid D arm cannot run as specified: `executePiPatch` creates a session per call, so a live worker
> cannot continue one, and its only expressible form is the design's named fallback (a new session seeded
> with the accepted prefix) - sequential handoff, not fusion. F5 (the speculation lifecycle) stays unrun
> because the design orders E after D's evidence, and F6's D half has no mechanism to spend on until an
> extension can hold a session across calls. No paid call has been made.

Implementation evidence, and the reason the recorded blocker is gone: the live worker can hold one session, so the paid arms ran. D measured session startup at ~1.9 s and the cache-aware re-measurement found cap 2 to be the knee (`docs/experiments/execution/archive/ooo-arms-2026-09-19/`); E found no realised gain. No paid call remains blocked.

## Problem

The design's arm programme has five arms and only three have run. A, B and C ran in
[the pilot](../../experiments/execution/ooo-arms-pilot-2026-09-18.md) (n = 8, one model, one held-out family,
cost-directional only: A 8.6 s / 11.2 k tokens per run, B 21.5 s / 31.5 k, C 16.2 s / 29.9 k). **D
(execution fusion) and E (budgeted speculation) have never run**, and the design orders them in that
order: "E 在确定并发与融合得到证据后独立评估".

What each arm needs, measured rather than assumed:

- **D** is "the same Agent session runs several logical units in a row, each still taking its own
  ticket, delivering its own artifact and crossing the host boundary" - execution fusion, explicitly
  _not_ transaction fusion. The mechanism does not exist: `piWorker` in
  `evals/ooo-execution/plan-driver.ts` calls `executePiPatch(frozen, provider, model)` once per unit, so
  every unit gets a fresh session. The adapter that _could_ continue a session exists in the research
  tree (`live-continuation.ts` ran a real continuation), and the cost model already carries the
  per-boundary term (`contextMsPerUnit`, `coarseContextSaving`) - but nothing reuses a session across
  units, and nothing reports a shared startup/context cost separately.
- **E** is "prepare a candidate ahead of one declared, finite-valued fact": `assumptions=[{predicateId,
version, expected}]`, the host re-checks every assumption against authoritative evidence inside the
  publishing transaction, a false assumption discards the candidate and closes the branch session while
  the real path re-executes under a new ticket. The first experiment is bounded by the design: **one**
  pending fact, **one** candidate, no speculative successors, no irreversible external operation, and
  cost/waits capped. The seam for `assumptions` exists (the advisers port refuses an unmodelled `fuse`
  or `prepare` action), but no candidate is ever prepared ahead of a fact.

Two facts also bound what a paid pilot could show. First, the cost model has **no quality term by
construction**, and the pilot found no quality difference to measure on the existing families (every arm
accepted everything). Second, the design requires D's context-reuse effect to be _measured_ ("仍要测量
上下文偏置对质量的影响") - and that effect is precisely the one a cost-only measurement cannot see. So the
paid stage is only meaningful beside (a) the offline legality/accounting work and (b) a family whose
checks can actually fail on the fused or speculated path.

## Decision

Four slices, in this order, with the spend gated behind an explicit operator approval.

**F4 (offline, no spend): fusion legality, ordering and accounting.**

1. A pure function for legal fusion candidates and their order in the shared layer, honouring the
   design's five conditions - compatible capability/authority/visibility; a successor only starts after
   its dependency is _accepted_ (an unverified answer from the same Agent is not an accepted
   dependency); per-unit identity, deadline, cancellation, verification and cost stay separate; a host
   yield boundary between units; no reuse across a pending speculative branch. Each condition is pinned
   by a named mutant, in the same style as the slot-budget rules.
2. Session reuse across fused units on the research side, with the host yield boundary and the per-unit
   ticket/record flow unchanged. Fused units are one _session_, never one _acceptance_.
3. A fusion mode in the advisory cost model: the shared startup/context saving is reported as its own
   line and is never counted twice per unit, and the model refuses a net-gain verdict when that term is
   assumed rather than measured - mirroring how `coarseContextSaving` is already bracketed.

**F5 (offline, no spend): the speculation lifecycle.**

On the driver, with canned workers: one pending fact, one candidate carrying `assumptions`, the host
re-checking them inside the publish transaction, a false assumption discarding the candidate and the real
path re-executing under a new ticket, the wasted cost accounted as its own line, no speculative
successor, and a refusal to start when the assumption could not complete a _data_ input or when it
touches a permission precondition (the design's gate table). Offline proof of the lifecycle, not of the
payoff.

**F6 (paid, needs approval): a small two-arm pilot.**

One family, four arms, three repetitions each: `{unfused, fused}` for D and `{no speculation,
speculation on one fact}` for E, the same model F3 used (`deepseek/deepseek-v4-flash`, for comparability), envelope limits fixed per arm as in F3. Reported
separately per the design: latency, extra cost (including the wasted candidate), tokens, and quality
against the fixed checks.

**Budget request.** From F3's measured per-run costs, twelve runs of this shape are ≈ 350-400 k tokens
and ≈ 4-6 minutes of model time (F3: 8 runs / 23 calls / 188 k tokens). **Approved ceiling: 1 000 k
tokens** (operator, 2026-09-18, with "尽量别都花完" - do not spend it all), against a planned spend of
about 400 k: the pilot stops as soon as a measurement is decisive, and adds no repetition for marginal
precision. Refusals declared in advance: if the family's checks cannot fail on the fused/speculated
path, the run reports cost and latency only and the family is replaced before any further spend; if the
fused arm cannot even reach its checks (a mechanism failure rather than a cost result), the pilot stops
and the result is "the mechanism is not ready".

## Alternatives considered

- **Go straight to the paid arms.** Rejected: the design orders an advisory offline model before any paid
  call, and today there is no fusion mechanism, no candidate-ahead-of-a-fact lifecycle and no accounting
  line to attribute the spend to.
- **Stay offline and never measure the payoff.** Rejected: the arms exist to weigh a cost against a
  quality effect, and the design's own sentence asks for latency, extra cost _and_ quality together.
- **Run E before D.** Rejected by the design's own order: speculation's payoff depends on a fusion
  decision that has not been measured.
- **Reuse the F3 families as they are.** Rejected as the _only_ family: every arm accepted everything, so
  a fused/speculated path could not be shown to be right or wrong; a family whose checks can fail (F2c's
  held-out `pipeline` with a wrong-answer case) is used, and its coarse/fine pairing keeps the fused arm
  comparable.
- **Implement fusion as one acceptance for several units (transaction fusion).** Rejected by the design
  for this slice: it changes what an acceptance is, which is the thing the arms are measuring.

## Consequences

With the mechanism in place the paid arms ran, so the budgeted pilot this record asked for is no longer blocked. D priced session startup and the cache-aware re-measurement moved the primary quantity to sessions avoided; E found no realised gain.

1. F4's legality function refuses each of the five conditions when it is violated, with a named mutant
   per condition, and the driver's fused run keeps per-unit tickets, verdicts and cost records.
2. The cost model's fused mode never books the same startup/context cost twice, and refuses a net-gain
   verdict while its saving term is assumed (a test fails when the refusal is removed).
3. F5's lifecycle case: a false assumption discards exactly the candidate, accounts its cost separately,
   and leaves the real path to re-execute under a new ticket; a candidate on a data input or a
   permission precondition is refused by name.
4. F6 runs only after the operator's ceiling is recorded here (1 000 k tokens, approved 2026-09-18),
   reports latency, extra cost and quality separately, and states which of the two refusals above fired
   if the family or the mechanism was not ready.
5. The ledger gains the arms as rows (F4, F5, F6) with the evidence each one has, and the hidden-feature
   registry gains the new research entry points in the same change.

## Risks

- **Context bias is the arm's real risk.** Reusing a session carries an unverifiable influence on the
  next unit's answers; the design's fifth condition bounds it, and the pilot measures it only as quality
  against fixed checks, not as a causal explanation.
- **A family that can fail is also a family that can fail for the wrong reason.** A wrong answer in the
  held-out pipeline says the check works, not that fusion caused it; the pilot therefore compares
  verdict patterns across arms rather than aggregate pass counts.
- **Speculation can look free in simulation and lose in reality.** The wasted candidate is cheap in
  tokens but can occupy the host's check queue, which F1 already identified as the binding term; the
  mock reports both, and the paid stage is where they separate.
- **Spend.** Twelve runs is a small sample; it will not separate two arms whose effect is smaller than
  its variance, and the design's expectation of a _net_ gain is explicitly not guaranteed.
