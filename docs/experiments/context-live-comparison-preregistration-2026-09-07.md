# Pre-registration: real-model context-intervention comparison

**Status:** pre-registered (protocol only, **not yet run**).
**Date:** 2026-09-07
**Owner context:** `docs/design/agent-convergence-feedback-design.md` §9.4–9.6.
**Predecessor:** `docs/experiments/context-live-canary-2026-09-07.md` (proved the
decision → real-model exposure → official-grading → usage path is wired; n=3,
no value claim).

This document fixes, *before seeing outcomes*, the objective, arms, cost
participation, metric, non-inferiority and cost/quality gates, independent-unit
criterion, analysis plan and stop rules of the first powered comparison. Writing
implementation or inspecting test outcomes before these are locked is not
allowed (design-first decision).

## 1. The question

Does a cost-aware selection over context interventions (`none` / `cue` /
`resurface` / `retrieve`) improve task outcome enough, per **model-call token
budget** (retrieval/search cost is deferred — see §5/§9 — and is not part of the
measured cost here), to justify the experimental router relative to the
**fixed fallback** — and is any advantage dependent on **measured history**
(previous actions and independently verified outcomes), rather than explainable
by a static retrieve-always policy under a loose budget?

Two pre-registered hypotheses:

- **H1 (gate/utility):** the validation-tuned router is non-inferior in graded
  task accuracy to the fixed fallback within margin `δ`, and superior in
  per-question cost (or meets the budget cap) under the end-to-end budget.
- **H2 (history dependence):** a history-augmented router materially changes
  held-out sequential-task decisions relative to the history-free head — i.e.
  there exists a resolvable history-dependent error, per §9.4. **Materiality is
  pinned (B-B):** H2 is supported only if (a) R1 changes the selected action on
  ≥ 5% of held-out sequential decision steps relative to R0, **and** (b) that
  change yields an owner-level improvement in accuracy or model-call token cost
  versus R0 by the §6 margin/gate. Otherwise H2 is not supported (not material).
  If H2 is not supported, no recurrent/history-node architecture is added
  (§9.4 gates extra architecture on this evidence).

## 2. Why the offline probe could not answer this

The #25 offline probe (LoCoMo component) never let a real model consume an
intervention and never incorporated a cost penalty in optimization; the
coverage reward was monotonically increasing in context length under the loose
budget, so the linear head degenerated to a retrieve-constant and
`fixedRetrieve == linear` exactly (`0.3505885122`). That structure **cannot**
falsify cue/resurface/history hypotheses and is not an efficacy result.

## 3. Population, unit, and eligibility (locked before any outcome inspection)

- **Independent unit = one conversation owner** (persona / long-memory user
  session), never split across train/validation/test. Nearby rows or paraphrases
  of the same owner are not independent units (§9.5).
- The owner↔row map is fixed **before any outcome is read — including the
  wiring dry run (§8)** — not merely before the powered run (B-D).
- **Dataset selection criterion (eligibility lock):** choose the smallest
  official OmniMemEval suite, among those with a matched same-model answer+judge
  pipeline already exercised, whose prepared data provides **≥ 30 eligible
  independent owners** after excluding unanswerable/empty-context/out-of-budget
  rows. Candidates currently: LoCoMo (10 owners → **rejected**, too few),
  LongMemEval (500 rows, per-row haystack → owner grouping must be confirmed),
  PersonaMem v2 (200 personas, multi-turn chat → strongest for sequential
  history). Final suite and the owner↔row mapping are fixed here, **before** any
  outcome is read; the map is recorded and hash-pinned.
- **Sequential history availability:** rows must be orderable within an owner
  (chronological) so previous action/reward can be defined. If the chosen suite
  cannot provide clean within-owner ordering, H2 is reported as not testable with
  the chosen data rather than redefined post hoc.
- Exclusion (fixed, non-outcome): non-empty retrievable/rendered context,
  within hard context budget, owned by an eligible owner, category not the
  excluded class used in the canary. No exclusions based on any score/outcome.

## 4. Arms and decision rules

Actions are the four fixed `ContextAction`s from `src/lab/context-router.ts`,
executed via `src/lab/context-executor.ts` (`none`, `cue`, `resurface`,
`retrieve`) with the same authorization/budget/signal semantics and
whole-fragment truncation already implemented.

Policies compared on the **same held-out questions** (matched: the same
`(owner, question)` receives each policy's context in independent real-model
calls — the canary pattern):

- **F0 Fixed fallback:** the current default injection (retrieve/recall all,
  i.e. today's NMG behaviour). Baseline.
- **F1 Fixed `none`:** empty context (upper cost bound reference, floor quality).
- **R0 History-free router:** 132-parameter head (32→4) trained offline on the
  executed-action regression, selection = cost-adjusted epsilon-greedy.
- **R1 History router:** same head + measured history features (§9.4).

Router training/serving must run on **held-out-by-owner** folds only; validation
selects `λ` and hyperparameters; the untouched owner-disjoint test set is scored
once.

## 5. Cost penalty λ must participate (fixes the offline P1)

The offline probe's defect was that cost never entered optimization. Here the
selection objective is

```
Q(action) = E[ graded utility ] − λ · cost(action)
```

where `cost` is the **model-call token cost** measured from real `create()` usage
(retrieval/search cost is deferred to §9 and excluded from this measured cost;
nothing is fabricated). λ is **not** a free post-hoc knob: a predeclared grid
`Λ = {0, λ1, …, λk}` is fixed here; for each λ ∈ Λ the router is trained on train
and the resulting (accuracy, cost) is read on **validation**; the single (λ,
policy) that maximizes `accuracy − λ·cost` on validation (ties → lower cost) is
selected; that choice is fixed before the test fold is read. Reporting must
include the full λ sweep and the retrieved-vs-nothing behaviour at each λ so a
degenerate retrieve-constant outcome is visible, not hidden.

**Retrieve-constant is not added value (B-E).** Because the fixed fallback F0 is
a retrieve-always policy, a router that merely reproduces retrieve-always and
achieves non-inferiority against F0 has demonstrated **no added value**; the
quality non-inferiority gate alone cannot catch this. A null is therefore also
incurred when R0/R1 reduce to retrieve-constant at the selected λ (visible via
the λ sweep) or otherwise do not beat F0. The no-value outcome is reported as a
null, not as support.

## 6. Metric, gates, and power (predeclared)

- **Primary metric:** per-question official graded correctness (0/1) via the
  suite's official answer pipeline under identical main-model settings
  (`deepseek-chat` in the canary; the exact model is fixed and recorded before
  the run).
- **Secondary:** per-question model-call token cost and latency from real usage
  (search cost deferred).
- **Estimand:** per-owner mean difference `router − F0` on the test fold.
- **Quality non-inferiority margin:** `δ = 0.05` absolute accuracy (router not
  worse than F0 by > 0.05 on test owner means). **Cost gate (pinned, B-C):**
  router model-call token cost on test ≤ F0 model-call token cost (no allowance,
  `C_R ≤ C_F0`); otherwise H1's cost claim fails regardless of accuracy.
  Together with the retrieve-constant clause above, H1 additionally requires
  the router to be better than a retrieve-constant replica of F0 (the selected
  λ is not retrieve-always), else it is a null/no-added-value result.
- **Sample size:** computed to detect a per-owner effect with the chosen suite's
  owner count and an assumed within-owner variance; target ≥ 0.8 power at
  α = 0.05 for the predeclared minimum effect. If the chosen dataset cannot
  reach this, the experiment is under-powered and reported as such (a null is a
  valid result; it is not dressed up as a positive).
- **Primary analysis:** owner-level paired comparison (same owners under both
  policies) with a nonparametric test on owner-mean differences; secondary
  per-question analysis is descriptive.

## 7. Analysis / reporting / stop rules

- Pre-registered analysis plan runs as written; any deviation is reported as a
  deviation, not folded silently into the result.
- Stop rules fixed before run: max real-model calls and cost budget; if the
  budget is hit the experiment stops and is reported as incomplete rather than
  extrapolated.
- A finding that R0/R1 **do not beat or match** F0 under the gates, or reduce to
a retrieve-constant replica of F0 at the selected λ (no added value), is a
valid result and blocks extra architecture by default (§9.4, §9.5). No default
  activation from any offline/held-out score alone; promotion additionally needs
  the §9.5 predeclared task metric, uncertainty estimates, no safety violations,
  and no quality/cost regression.
- Report must separate wiring evidence from causal/utility evidence and disclose
  the exact model, date, dataset hash, owner map, λ sweep, and any infra failure
  (recorded, never zero-filled).

## 8. Feasibility and cost

First executable step is a **small dry run** (few owners, no learning) to confirm
the suite's official answer+judge pipeline and real usage capture extend from the
LoCoMo canary to the chosen suite, before any powered spend. That dry run is
reported as a wiring extension, not as an efficacy result.

## 9. Explicit deferrals (not this experiment)

- Live (non-replayed) retrieval cost attribution.
- Recurrent / causal-history-node architecture (only if H2 shows an unresolved
  history-dependent error).
- Default activation gates and production deployment.
- Independent external verifier adapter (reward/cost authenticity).

---

*Boundary note: this is a protocol. Nothing in it has been executed; selecting
the dataset and reading any test/validation outcome before this file is frozen
would invalidate the pre-registration.*
