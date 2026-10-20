# Fusion planning: repair-first online, ceiling offline

[中文](ooo-fusion-planning.zh-CN.md) · [Terms used](ooo-fusion-planning.terms.yaml)

the shared dispatch loop and one-move function exist, and the research driver uses them; the
product's existing `nmg_board` host path has not been shown invoking that loop. Product integration is
deferred. The offline ceiling is a research tool, not a runtime policy; no general startup, token or cost
model is established.

How a plan's units are assigned to Agent sessions: what a shared dispatcher may decide at a run boundary,
and what is measured offline instead. The legality rule itself is not here - it lives in
`src/integration/ooo-execution.ts` (`sharedSessionLegal`) and this document never restates it.

## The problem this answers

Fusion can save session startup by carrying several units in one session, but the bound alone does not
choose a successor or establish that fusion is worth its token or provider cost. The offline tool uses an
explicit 1 900 ms per-session assumption from the D arm; that arm's 1 900 ms median gap is smaller than
its 2 228 ms within-arm spread, so it is not a general startup estimate. On the four-unit fine plan,
cap 1 to cap 2 differs by 8 451 ms in the archived medians, with within-cell spreads of 1 783 ms and
571 ms. This is evidence about that measured shape, not a universal saving: the third cap repetition used
a newer prompt and the reports do not preserve the instrument commit. A run-specific observation of
about 0.7k extra tokens on a chain's first unit does not price the running surface, and the token/cost
side of fusion remains unresolved. The useful question is therefore _how many sessions a plan can be
compressed into_, not whether fusion is generally beneficial.

## Two clocks

| | Online (a run boundary) | Offline (analysis) |
| --- | --- | --- |
| Decides | the next move of the current session | how many sessions the plan could need at best |
| Facts | the ones the run actually holds | the optimistic projection: every unit accepted, nothing cancelled, no external wait pending, no pending branch |
| Cost | none (a pure function, milliseconds) | none (no model calls) |
| Fails by | closing a session it should have continued | overstating what fusion can save |

The offline half is a **ceiling**, not a policy. Nothing in a run may read it to decide a move, because
it is computed from facts the run does not have yet.

## Online: ready set, repair-first, baseline

A fused session is an irreversible commitment: two units that ran in one session cannot be un-fused.
So the online decision is not a plan, it is one move about the _current_ session:

- **admit** the next legal successor, or
- **close** the session, naming the condition that closed it.

Three properties make that move safe to make repeatedly:

- **Repair-first.** Continuing the current session is a constraint **the plan declares**, not this
  design's default: a plan that enables `repair-first` continues the session, and a plan that enables
  nothing runs one unit per session and closes at every unit boundary. Once enabled, a re-decision may
  only _end_ the session, on a declared change: a rejected verdict, a cancellation, a dependency that
  did not become accepted, or a declared external wait that is not ready. Repairing instead of
  re-planning is the documented trade: reusing a plan saves work but risks acting on a stale one, and
  re-planning from scratch churns (`plan repair versus full replanning`). Repair-first is the middle:
  keep what is committed, decide only about what has not run. The names the protocol defines are a
  closed list (`PLAN_CONSTRAINTS`), and a plan naming one outside it is refused by name rather than
  read as having asked for nothing.
- **Baseline.** A move, once made, is not revisited while its facts hold. Facts arrive at boundaries;
  between boundaries there is nothing to re-decide, so an unchanged fact set yields an unchanged set of
  moves. This is Oracle SQL Plan Management's plan-baseline idea: constrain the plan to accepted
  alternatives so an unrelated change cannot silently move it.
- **Determinism.** The same plan and the same facts yield the same move, with ties broken by plan
  order. This is the workflow-engine discipline (Temporal replays workflow code against recorded
  history, so the code must be a pure function of that history; non-determinism belongs in activities):
  the model call is the activity, the move is the replayable code. Without it, two runs of one plan are
  not comparable, which is what the arms need.

`nextSessionMove` is a deterministic rule over the plan and current facts; it does not read a numeric cost
model. The D-arm startup value is an explicit research assumption used by the offline ceiling, not a
fitted general model. If a cost model is introduced later, it must be fitted offline and frozen for a run;
it must not turn future facts into an online decision.

### Execution tool sets

The [Pi session runner](../../.pi/extensions/nmg/ooo-execution.ts) distinguishes a
plain execution surface, selected from the first attempt's required tools, from
a chain execution surface that registers the tool union once for several units.
In chain mode, an unavailable operation still refuses for the current unit. The
artifact schema accepts a string conclusion kind, but the artifact envelope and
host still validate the result. This capability does not authorize fusion or
establish product-loop integration; the cost comparison below remains unpriced.

## Offline: the ceiling

The legal graph is state-dependent, so the offline half prices an optimistic projection, not a live
schedule. `optimisticPlan` marks every unit accepted, uncancelled and externally ready, while preserving
its declarations; it then calls the same `sharedSessionLegal` predicate. `fusionGraph` restricts edges to
later units in plan order and excludes a successor that the current unit transitively depends on. This
keeps the graph acyclic and prevents a chain from running a unit before what it needs.

Two numbers come out of that graph:

- **A floor**, when the structural relation is transitive: the minimum chain cover of a partial order
  equals its maximum antichain (Dilworth), and both are `units - maximumMatching` over the bipartite
  graph of the relation's transitive closure. That is the least number of sessions the plan could
  possibly need.
- **A feasible bound** from greedy list scheduling at a declared per-session cap: walk the plan in plan
  order and append each unit to the open session that can legally take it, preferring the fullest, or
  open a new one.

The gap between these numbers says how many sessions the greedy rule leaves above the structural floor;
it is not an economic value. Multiplying sessions avoided by the explicit 1 900 ms assumption produces a
wall-clock projection only. The fine-plan cap experiment observed 8 451 ms from cap 1 to cap 2, versus
3 800 ms predicted by the flat assumption. Because the D-arm value is not a stable constant and the cap
reports do not preserve the instrument commit (the third repetition used a newer prompt), the comparison
is bounded evidence for this sample, not a calibrated per-session price.

The ceiling does not price the union tool surface's additional turn or the chain **surface** overhead.
About 0.7k extra tokens on the first unit is a run-specific D-arm observation, not a general surface
price. On the four-unit plan, B vs cap1 shows a 3 607 ms wall difference (26 186 ms against a 22 579 ms
plain-cell median), but the reports do not establish a matching instrument commit; the 15 412-token gap
also does not separate. The cap reports predate the usage split, so fused-cell provider cost remains
**unpriced**. The [A-D archive](../experiments/execution/archive/ooo-arms-2026-09-19/README.md) records the
boundaries; no general token or cost benefit is claimed.

## When the chain path may be entered

The permission rule is a decision, not a paragraph here:
[when the chain path may be entered](../decisions/implemented/2026-09-19-when-the-chain-path-may-be-entered.md)
states the three conditions (the semantics allow it, a continuable task exists, the host supports session
reuse), that the shared runtime decides while the adapter only supplies capability, and that fusion may not
relax per-task permission, input-version, cancellation or acceptance checks - nor the parent's joint
acceptance. The record does **not** declare economics: this document reports bounded wall-clock evidence
and leaves fusion cost unpriced. Nor does the permission rule establish that the product's existing
`nmg_board` host path invokes the extracted programmatic loop; the dispatch decision leaves that
integration deferred.

## What the ceiling says today

Read the complete responsibility: [What the ceiling says today](ooo-fusion-planning/current-evidence-boundary.md).

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
