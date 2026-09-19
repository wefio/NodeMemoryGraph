# Fusion planning: repair-first online, ceiling offline

How a plan's units are assigned to Agent sessions: what the host decides at a run boundary, and what
is measured offline instead. The legality rule itself is not here - it lives in
`src/integration/ooo-execution.ts` (`sharedSessionLegal`) and this document never restates it.

## The problem this answers

Fusion saves a session's startup by running several units in one session. The bound on how many
units one session may carry is the only fusion policy the repository had, and a bound is not a
decision: it does not say which successors to take, and it cannot say whether fusion is worth taking
at all. The measured shape is narrow - the D arm found ~1 900 ms of startup saved per avoided
session with tokens flat, against a union tool surface that cost the first unit about 0.7 k extra
tokens - so the useful question is _how many sessions a plan can be compressed into_, not whether
fusion is a good idea in general.

## Two clocks

|          | Online (a run boundary)                    | Offline (analysis)                                                                                             |
| -------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Decides  | the next move of the current session       | how many sessions the plan could need at best                                                                  |
| Facts    | the ones the run actually holds            | the optimistic projection: every unit accepted, nothing cancelled, no external wait pending, no pending branch |
| Cost     | none (a pure function, milliseconds)       | none (no model calls)                                                                                          |
| Fails by | closing a session it should have continued | overstating what fusion can save                                                                               |

The offline half is a **ceiling**, not a policy. Nothing in a run may read it to decide a move, because
it is computed from facts the run does not have yet.

## Online: ready set, repair-first, baseline

A fused session is an irreversible commitment: two units that ran in one session cannot be un-fused.
So the online decision is not a plan, it is one move about the _current_ session:

- **admit** the next legal successor, or
- **close** the session, naming the condition that closed it.

Three properties make that move safe to make repeatedly:

- **Repair-first.** The default is to continue the current session; a re-decision may only _end_ it, on
  a declared change: a rejected verdict, a cancellation, a dependency that did not become accepted, or
  a declared external wait that is not ready. Repairing instead of re-planning is the documented
  trade: reusing a plan saves work but risks acting on a stale one, and re-planning from scratch churns
  (`plan repair versus full replanning`). Repair-first is the middle: keep what is committed, decide
  only about what has not run.
- **Baseline.** A move, once made, is not revisited while its facts hold. Facts arrive at boundaries;
  between boundaries there is nothing to re-decide, so an unchanged fact set yields an unchanged set of
  moves. This is Oracle SQL Plan Management's plan-baseline idea: constrain the plan to accepted
  alternatives so an unrelated change cannot silently move it.
- **Determinism.** The same plan and the same facts yield the same move, with ties broken by plan
  order. This is the workflow-engine discipline (Temporal replays workflow code against recorded
  history, so the code must be a pure function of that history; non-determinism belongs in activities):
  the model call is the activity, the move is the replayable code. Without it, two runs of one plan are
  not comparable, which is what the arms need.

The cost model is read-only online. It is fitted offline and frozen for a run, which is exactly how a
query optimizer treats statistics: it re-plans at a boundary against collected statistics, and it never
re-collects them mid-query.

## Offline: the ceiling

The legal graph is state-dependent, so the offline half prices an optimistic projection of it: the
projection is fed to the _same_ `sharedSessionLegal`, which keeps one home for the five conditions, and
the only condition the projection cannot answer - a successor must not need a unit that has not run yet

- is added as "not reachable by the successor relation in reverse": a chain is a linear extension, so
  `a` may not be followed by `b` when `a` transitively depends on `b`.

Two numbers come out of that graph:

- **A floor**, when the structural relation is transitive: the minimum chain cover of a partial order
  equals its maximum antichain (Dilworth), and both are `units - maximumMatching` over the bipartite
  graph of the relation's transitive closure. That is the least number of sessions the plan could
  possibly need.
- **A feasible bound** from greedy list scheduling at a declared per-session cap: walk the plan in plan
  order and append each unit to the open session that can legally take it, preferring the fullest, or
  open a new one.

The gap between the two is the honest answer to "how much is fusion worth": the floor is what fusion
could save at best, and the list-scheduling result is what the current rule actually gets. Reported
against the measured startup, the difference is milliseconds saved.

Not modelled by the ceiling, and now measured rather than merely named: the union tool surface's extra
turn (about 0.7 k tokens on a chain's first unit), and the tokens a longer chain spends carrying its
context. The cap experiment above prices the second at about 15 % more _fresh_ input per four units -
most of a chain's extra tokens are cache reads - so the ceiling stays a wall-clock ceiling, and the
cost of fusing is real but far smaller than a raw token count suggests.

## What the ceiling says today

Run against the fixtures and against the D arm's own spec
(`node --experimental-strip-types evals/ooo-execution/fusion-ceiling.ts [--spec <path>]`):

| plan                               | units | floor | cap 1      | cap 2         | cap 3     | cap 4     |
| ---------------------------------- | ----- | ----- | ---------- | ------------- | --------- | --------- |
| `fixtures/report/fine.spec.json`   | 4     | 1     | 4 sessions | 2 (3.8 s)     | 2 (3.8 s) | 1 (5.7 s) |
| `fixtures/pipeline/fine.spec.json` | 4     | 1     | 4 sessions | 2 (3.8 s)     | 2 (3.8 s) | 1 (5.7 s) |
| the D arm's `spec-2.json`          | 2     | 1     | 2 sessions | 1 (**1.9 s**) |           |           |

The third row is the check that makes the method credible rather than decorative: the ceiling predicts
1 900 ms saved at cap 2 for the plan the D arm actually ran, and the arm measured 12 948 ms at bound 1
against 11 048 ms at bound 2 - the same 1 900 ms, from a tool that calls no model and reads only the
plan. Two things the table also says: the floor is 1 for both multi-unit fixtures, so a plan is fully
fusible in principle; and cap 3 buys nothing over cap 2 on these shapes, because the fourth unit has
to wait for the first three - the money is in reaching 4 units per session, not in raising the bound
one notch.

### The cap experiment, measured (2026-09-19)

The ceiling's prediction for a four-unit plan was tested on `fixtures/pipeline/fine.spec.json` - three
independent units and one that joins them, the shape of the report fixture - live, `--slots 1`, with
the spec's canned answers stripped so the units really run. Cache accounting is recorded beside tokens
because a token count is not a cost on its own.

| bound | sessions | reps | wall (all reps)             | tokens (all reps)        | cache read / tokens   |
| ----- | -------- | ---- | --------------------------- | ------------------------ | --------------------- |
| 1     | 4        | 3    | 25 270 / 26 186 / 27 053 ms | 33 941 / 45 482 / 45 887 | 0.607 / 0.806 / 0.847 |
| 2     | 2        | 3    | 17 427 / 17 735 / 17 998 ms | 35 444 / 37 693 / 41 806 | 0.690 / 0.798 / 0.802 |
| 4     | 1        | 2    | 16 480 / 16 810 ms          | 54 834 / 55 738          | 0.834 / 0.836         |

Bounds 1 and 2 carry a third rep because the two-rep reading of this table was quoted as a policy; every
value above is recomputed from the stored reports into the archive's `aggregate-3rep.json`. Three things,
and the second one replaces this document's first two readings of the same experiment. The last column is
**not a price**: `tokens` counts input and output together, so the subtraction leaves the tokens that were
not served from cache - uncached input plus every output token - and the reports do not say whether the
cache figure is nested inside the total at all. Pricing needs the three recorded separately, which this
experiment did not do.

- **Fusion saves wall clock, and more than the constant predicted.** Cap 1 to cap 2 saves 8 451 ms and to
  cap 4 saves 9 541 ms on the medians, against 3 800 ms and 5 700 ms predicted from the D arm's 1 900 ms.
  The within-cell spreads are 1 783 ms and 571 ms, so the saving is about five times the larger one and it
  survives the third rep. The startup term is **plan-dependent** (about 2.9-3.2 s here), and the ceiling's
  primary quantity should be _sessions avoided_ - exact and model-free - with milliseconds as an estimate
  that names its constant.
- **The token count settles nothing, at any rep count affordable here.** A two-rep reading had every arm
  spending 80-84 % of its tokens on **cache reads** and the remainder nearly flat. The third rep puts that
  share at 0.607 in one cell (0.847 in another of the same cell), and per-cell token spreads - 11 946 in
  cap 1 - are wider than the median gaps they would be compared across. So no token-direction claim
  survives: the 1.3-1.9x that an unpaired token median once suggested is not replaced by a better number,
  it is unresolved, and the cache column is why counts recorded this way cannot resolve it.
- **Cap 2 is still the knee in this sample, at two reps.** It takes 8 451 ms of the 9 541 ms available
  while sending the _fewest_ tokens of the three (median 37 693), and cap 4 buys the last 1 090 ms. Two
  runs per cell is not enough to fix a policy, and fewer sessions is not the same quantity as a shorter
  parent task: with more than one slot, fusing units into fewer sessions removes parallelism the plan could
  have used. Two units per session is therefore a hypothesis for the A-D comparison on one parent task to
  settle, not a strategy this document declares.

**A spread wider than a difference is not the same as no difference.** The D arm's two-rep spreads
(2.2 s in both arms) exceed its 1.9 s median gap, and that says the sample cannot resolve the effect - not
that fusion does not save wall clock. Deciding which of the two it is needs reps, and the A-D plan names
them ([the arm plan](../experiments/execution/ooo-arm-plan-2026-09-19.md)).

## Why this shape, and what it is not

Borrowed, with sources: stage-barrier re-planning (Spark's adaptive execution re-optimizes the
remaining query at a stage boundary using runtime statistics), ready-set scheduling (every workflow
engine), plan baselines (Oracle), deterministic replay (Temporal), dwell time and hysteresis against
chatter (switched-system receding-horizon control), and Dilworth.

Not borrowed, because the analogy breaks: plan competition, eddies and speculative execution. Those
assume re-running a plan is nearly free and replayable; a unit is a paid model call with side effects
that cannot be replayed, so a wrong execution is money spent, not CPU time recovered. This is the same
reason speculative fusion is not built: a wrong bet destroys the session it bets on.

Also not built: any cache of a plan, a compiled plan artifact, or a chain-cover compiler. Recomputing a
move is a pure function over a few dozen units, so the compile/interpret distinction that a tensor
graph needs - where the compiled artifact is expensive to build and used many times - does not arise
here; it is cheaper to decide again than to invalidate correctly.

## Obligations

- If the structural relation turns out not to be transitive on a real plan, the Dilworth floor does not
  apply; the list-scheduling bound still does, and the measurement says so rather than assuming.
- A move decided online must be recorded with the facts it used, or "baseline" is unfalsifiable.
- The ceiling is only as good as the measured startup term; if a later run prices session startup
  differently, the constant is what changes, not the method.
- Nothing here may widen `sharedSessionLegal`. A ranked candidate set is a policy over a fixed rule.
