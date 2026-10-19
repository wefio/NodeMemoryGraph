# Fusion legality is a pair predicate, and fusion's cost is two lines

[中文](2026-09-18-fusion-legality-and-accounting.zh-CN.md) · [Terms used](2026-09-18-fusion-legality-and-accounting.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [task-unit-semantics design](../../design/task-unit-semantics.md) (§融合),
[its obligations ledger](../../design/task-unit-semantics-obligations.md) (row F4),
[the fusion and speculation pilot proposal](../implemented/2026-09-18-fusion-and-speculation-pilot.md),
[the cost model record](../../experiments/execution/ooo-cost-model-2026-09-17.md),
[the arms pilot](../../experiments/execution/ooo-arms-pilot-2026-09-18.md),
[the session mechanism](2026-09-19-fusion-session-mechanism.md)

## Problem

The design defines execution fusion - one Agent session running several logical units, each keeping its
own ticket, artifact and host boundary - and puts five conditions on a pair of units that may share one.
Nothing could answer that question: `selectableTasks` is a "now" predicate over one plan, fusion is a
"next" relation between two units, and the driver had no session concept at all (`piWorker` called
`executePiPatch` once per unit, so every unit got a fresh session). The cost model charged a session
boundary per unit and had no way to say what a _shared_ startup costs, so the design's trade - "saved
startup/context cost − added wait/verification/context burden" - could not be priced either. The pilot
added a third gap: the design's fifth condition needs a branch that is still pending, and no code knows
one.

## Decision

**1. Legality is one pair predicate in the shared dispatch rules, composed with the board's own
answer.** `sharedSessionLegal(before, after, plan)` in `src/integration/ooo-execution.ts` holds the
design's five conditions, one line each, so a violation has one name; `fusionSuccessors` and
`fusionCandidates` expose the legal set in plan order. The predicate takes both views it needs - the
unit's declaration (capability, authority, its own visibility) and the runtime facts - and it composes
with `candidates()`/`accepted()` rather than re-deriving them, because the board stays the authority on
staleness, cancellation, delivery, claims and a declared external wait. The **bound** ("short ready
chains, not a greedy swallow of the DAG") and the **ranking** are the runtime's policy: the shared layer
owns legality and nothing else.

**2. Fusion's cost is two lines and a verdict that cannot come from a guess.**
`fusionAccounting` reports `boundarySavedMs` (what the removed boundaries are worth, on the term a pilot
has measured) and `sharedStartupMs` (booked once per session, never amortised into a unit) as separate
values, and `fusionVerdict` returns `unmeasured` until a run has priced the session startup - so the
design's "共享启动和上下文成本另列，不能重复记账" is a property of the accounting rather than a note in a
report. `assertModelProperties` refuses the two ways this can be silently wrong: booking the startup per
unit, and a bound that removes no boundary reporting a saving. The synthesis takes `sessionStartMs`,
`sessionStartMeasured` and `unitsPerSession` as declared parameters, and `--sweep` varies the startup on
both sides of its turning point instead of trusting one value.

**3. The driver reports fusion only from the worker's own session report, and a worker that cannot hold a
session refuses by name.** `PlanDriverSpec.fusion` declares the bound and the per-unit declarations;
`runPlan` continues a session only from an **accepted** unit, ends it at a rejected verdict, a failed
worker, a successor that is not legal at the boundary or the declared bound, and records one entry per
session in `PlanRun.sessions`. Fusion's evidence is `WorkerMetrics.sessionId` - the session the worker
says it used - so a worker that quietly starts its own session is reported as boundaries, not as fusion.
The per-call `piWorker` **refuses** continuations by name because its `executePiPatch` path creates a
fresh session. Fused live runs use the later `piSessionWorker` mechanism backed by
`createPiSessionRunner`, which holds one session per run; see [the session-mechanism decision](2026-09-19-fusion-session-mechanism.md).
The refusal remains the honest behavior of the single-call worker, not evidence that session reuse is
still unimplemented.

## Alternatives considered

- **A chain builder in the shared layer.** Rejected: a bound is a runtime policy, and the design's own
  division puts only legality in the shared module. `fusionSuccessors` returns the legal set; the driver
  applies the bound.
- **Recording fusion from the driver's request rather than the worker's report.** Rejected by
  measurement: the new case "a worker that starts its own session is not reported as fusion" fails under
  the mutant that counts the requested session, which is exactly the silent lie this avoids.
- **One net number per fused run.** Rejected: the design asks for the two lines precisely because a net
  number hides which term answered, and this file's convention is that an assumed term is marked and
  varied, never read as a measurement.
- **Having the live worker answer a continuation with a new session seeded by the accepted prefix.**
  Rejected as _fusion_: that is the fallback the design names ("若 harness 没有这种能力，就新建会话"), and
  reporting it as session reuse would turn the D arm's cost claim into a comparison of two identical
  mechanisms. It stays available as what a live fused arm would actually run, and the ledger row records
  it as not landed rather than as a result.
- **Putting the legality function beside the compiler (`task-semantics.ts`) instead of the dispatch
  rules.** Rejected: the question it answers is "may the host hand this unit out inside this session",
  which is the same family as `selectableTasks`, and its inputs are that module's runtime facts.

## Consequences

- At the time of this decision, the offline half of F4 had 12 product cases with 8 named mutants for
  legality, 12 cost-model cases with 4 named mutants for accounting, and 15 driver cases with 12 named
  mutants for policy. These are the recorded results for that snapshot, not a current test run.
- **The paid F6 arm's D half was blocked at this decision's snapshot.** The follow-up
  [session-mechanism decision](2026-09-19-fusion-session-mechanism.md) added a reusable Pi session runner,
  after which the paid arms were run as recorded there. The earlier blocker is historical, not a claim
  about the current harness.
- `src/integration/ooo-execution.ts` gains a rule with no product caller today: the arms are its
  consumers, and the design assigns legal fusion candidates to the shared layer. If the D arm is never
  promoted to the product, this rule retires with it - the same disposition the round instrument got.
- `piWorker` remains the per-call path and still refuses a continuation. Fused live work selects
  `piSessionWorker`; the two paths are intentionally distinct, so the original refusal should not be
  removed merely because the session mechanism exists.
