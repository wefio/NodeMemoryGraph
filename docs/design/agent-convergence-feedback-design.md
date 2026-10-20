# Agent convergence under feedback density

**Status:** draft — implementation partial; theory and default activation unproven
**Updated:** 2026-09-03

This document consolidates a design discussion into a single blueprint: a
theory of why long agent tasks fail (and succeed), the literature that supports
it, the parts of the existing NMG system that already implement pieces of the
model, and the candidate design that would close the remaining loop. It is
written so a future Agent can pick the thread up without re-deriving the
conversation.

## Implementation boundary (partial, not system completion)

Read the complete responsibility: [Implementation boundary (partial, not system completion)](agent-convergence-feedback-design/implementation-boundary.md).

## The replaced model

Popular writing frames long agent tasks as a reliability product: if each step
succeeds with probability `p`, `n` sequential steps succeed with `p^n` — at
`p = 0.99` and `n = 100`, 36.6%. The model is not wrong as arithmetic; it is
wrong as a **model of the system**, because it assumes errors are absorbing
states: no feedback, no correction, no reversibility. That assumption holds for
a blind serial chain and for almost nothing else in engineering. Stochastic
gradient descent is the canonical counterexample: no individual step is
optimal, noisy and even bad steps are routine, and the process still converges
— because every step is pulled by a continuously available loss signal.

The productive question is therefore not "how do we raise the single-step
success rate" but **"after an error, does the world let the system come back,
and how cheaply can it detect that it left?"**

## The feedback-density model

### Iteration as a biased optimizer

Model the agent as an iterative update with a gradient estimate:

```text
θ_{t+1} = θ_t − η·ĝ(θ_t)
ĝ       = external gradient (unbiased) + self-generated direction + noise
```

Every intermediate goal an agent writes for itself (subgoal decompositions,
plan refinements, self-interpretations of a vague instruction) is a **biased
gradient estimate**: biased by the gap between the model's world model and the
real one. Self-generated directions are usable for guiding search; they must
never gate convergence, because nothing external ever validated them.

### Three regimes, decided by a ratio, not by step count

Let *calibration rate* be the frequency of external verification and *drift
rate* the accumulation of uncalibrated self-generated movement. The ratio of
the two decides the regime:

| Regime | Condition | More steps | Converges to |
| --- | --- | --- | --- |
| Converging | calibration/drift above a critical ratio | helps | near the external target |
| Critical | ratio near the threshold | oscillates | indeterminate |
| Diverging / ossifying | calibration sparse, drift dominates | **hurts** | the model's own fixed point |

Steps are a double-edged sword in any stateful process: each additional step
adds one correction opportunity **and** one drift opportunity. Only in the
i.i.d. retry model (geometric distribution) do more attempts monotonically
help. In a stateful, biased, self-conditioning process they do not.

### The information constraint

External loss is the only information source that points at the target. If the
gradient is entirely self-generated, each iteration can only preserve or lose
information (data-processing inequality): the process converges to the model's
own fixed point, and self-distillation style iteration can collapse to a bland
self-consistent solution. This is why the loss cannot be written by the thing
being optimized — an information constraint, not a moral one.

### Corollaries

- Convergence quality is a function of **external calibration density vs
  self-generated bias**. The converged point is a belief fixed point; it sits
  as far from the true target as the bias, times the inverse curvature.
- The engineering lever for long-task reliability is **shortening unverified
  segments** (making feedback denser), not granting larger step budgets.
- Step count is non-monotonic: long unverified segments accumulate drift
  (self-conditioning), and long contexts degrade the model's use of early
  material.
- Reliability comes from the verification loop, not from the single-step
  quality of the base model.

[Harness formalization](#harness-formalization) makes the trainable part concrete: the Harness, with a real gradient in its
own parameter space.

## Harness formalization

Read the complete responsibility: [Harness formalization](agent-convergence-feedback-design/harness-formalization.md).

## Literature support

Each claim below has direct empirical or theoretical backing; the survey was
run 2026-09-03 and is a cross-check, not a requirements source.

| Claim | Work |
| --- | --- |
| Introspection without external feedback does not improve (and can hurt) reasoning | [Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet*, ICLR 2024](https://mlanthology.org/iclr/2024/huang2024iclr-large/) |
| Purely self-generated loops do not converge | [*The Mirror Loop: Recursive Non-Convergence in Generative Reasoning Systems*](https://browse-export.arxiv.org/pdf/2510.21861) |
| Dense per-step feedback beats sparse final feedback | [Setlur et al., *Rewarding Progress: Scaling Automated Process Verifiers*, ICLR 2025](https://mlanthology.org/iclr/2025/setlur2025iclr-rewarding/); process-reward-model line (OpenAI *Let's Verify Step by Step*) |
| Reliability comes from verification loops, not single-step ability | [*Where Does Agent Reliability Come From? A Cross-Benchmark Decomposition of Verification Loops, Specialist Models, and Scaffolding*](https://huggingface.co/papers/2607.17044) |
| Long trajectories are constrained by a self-conditioning effect | [Sinha et al. (2605.02572)](https://huggingface.co/buckets/huggingchat/papers-content/tree/2605/2605.02572.md) |
| Step count is non-monotonic over long horizons | [*The Illusion of Diminishing Returns: Measuring Long Horizon Execution in LLMs*, NeurIPS 2025](https://neurips.cc/virtual/2025/loc/san-diego/127973) |
| External feedback rescues; internal-only reflection underperforms multi-perspective contrast | [Reflexion (2303.11366)](https://arxiv.org/abs/2303.11366); [SWE-agent](https://arxiv.org/abs/2405.15793); [Self-Contrast, ACL 2024](https://aclanthology.cn/2024.acl-long.197/) |
| Unverified segments are the structural failure source of long tasks | [*The Horizon Gap* (2608.06663)](https://arxiv.org/abs/2608.06663) |

**Open gap:** no single authoritative work unifies these into a testable law of
the form "a critical calibration/drift ratio separates converging from
diverging regimes". That unification is a candidate contribution.

## What the system already has

Read the complete responsibility: [What the system already has](agent-convergence-feedback-design/existing-runtime-components.md).

## Closing the loop with what exists

No new component is needed. "Convergence on a target" decomposes into two
existing capabilities plus one wire:

- AG **ingests** external content fragments into session working memory.
  Bookmarks are the first such fragment; a contract or an expected final shape
  is another fragment of the same kind.
- Bookmarks **fix a content baseline and measure drift** against it (SimHash
  fingerprint + threshold + relocation). Applied to an ingested target
  fragment, this is reuse of bookmark machinery, not a new mechanism.
- RCP **verifies behavior** (tests / lint / contract execution) — the
  expensive, sparse, unbiased correction.

Metric choice follows the shape of the ingested target:

| Target shape | Drift metric | Cost/frequency |
| --- | --- | --- |
| Form ("final content should approximate this shape") | SimHash distance | O(n), local, high-frequency |
| Sub-fragment ("should contain / relocate this fragment") | snippet location / diff | medium |
| Behavior ("should pass tests / lint / contract") | execution verifier (RCP checks) | expensive, sparse, final |

A SimHash-style metric needs the target and current content comparable at
document scale (measured: no signal below document scale), and gives magnitude
only — direction comes from diff or verifier diagnostics.

### Validation gates what may gate

An agent writes intermediate goals constantly; it does **not** spontaneously
invent goals with no external target (it is an event-driven reactor — it
elaborates and decomposes, it does not self-initiate). Consequences:

- Self-authored goals are biased intermediates: they organize execution (task
  frames) and guide search; they never gate convergence.
- Convergence/projection gates accept only externally validated content:
  human sign-off, or content whose claims were exercised by a verifier.
  Authority comes from the validation act, not the authorship.

### Two-level loop

- **In-session:** reconcile/verifier failure → drift event into AG `observe()`
  → small corrective steps in the same task frame → new projection → re-check.
  AG provides the structure (cooling set = momentum buffer, projection chain =
  checkpoint sequence); the missing wire is reconcile → observe.
- **Cross-session:** when a task genuinely spans sessions, drift events and
  completed quests become governed memory (with source markers), recalled
  by the continuation session. Form-drift checks and RCP verifiers reduce to
  the same unified event: drift from an externally fixed baseline.

## Identified gaps (work queue)

1. **The single event bus does not exist.** Quest lifecycle events (board
   resolve, bookmark relocation/stale, document commit) and reconcile drift
   events are not surfaced into AG `observe()` with a `(quest, h, y)` log
   pairing — the one wire that feeds both the global calibrator ([The feedback-density model](#the-feedback-density-model)) and the
   local labels ([quest lifecycle signals](agent-convergence-feedback-design/harness-formalization.md#what-quests-are-in-this-system)). The AG ingestion gap (below) is the concrete first
   half of this.
2. AG cannot ingest external content fragments; bookmark ingestion is the
   concrete first case (memory items enter the AG without their bookmarks).
3. Explicit newly recorded RCP receipt → AG `observe()` is implemented; general
   drift streaming, notification replay and automatic harness feedback remain open.
4. No intervention logging or ε-greedy exploration exists to make `u(d,p)`
   estimable (counterfactual data). Reuse pattern: learned-router gates
   (`examples ≥ N`, lexical guard, shadow-first) plus an always-random probe
   arm.
5. Board resolve is a biased completion source with no false-complete
   measurement / debiasing path via reconcile ([signal purity and debiasing](agent-convergence-feedback-design/harness-formalization.md#signal-purity-is-an-sgd-bias-question-not-a-stratification-question)).
6. Externally approved long-term quests are not first-class persisted memory
   (no cross-session continuity; see [the knowledge space is open](agent-convergence-feedback-design/harness-formalization.md#the-knowledge-space-is-open); compounding needs a governed goal store).
7. Bookmark drift machinery (baseline + SimHash metric + relocation) is proven
   only against the past snapshot of one file; reuse against any ingested
   target fragment is unwired.
8. The critical-ratio claim ([Three regimes, decided by a ratio, not by step count](#three-regimes-decided-by-a-ratio-not-by-step-count)) is unverified in this system; measurement
   comes before building ([Candidate experiment](#candidate-experiment)).

## Candidate experiment

The repository has a measurement-first tradition. Before building any of [Identified gaps (work queue)](#identified-gaps-work-queue),
two measurements come first:

**Phase 1 — sample pipeline before training.** Instrument the existing
decision points (AG disclosure, recall injection, retrieval) with bounded records that link each quest, selected intervention, and outcome. Passive logging and an unexecuted shadow arm check coverage,
outcome linkage, and policy differences without changing behavior; they do not
establish non-confounded intervention effects. Follow with actually executed,
authorized randomized interventions or reproducible snapshot branches under
matched budgets before estimating causal benefit. Compare fixed rules with the
132-parameter baseline before considering the optional 596-parameter MLP; do
not train merely because observational `P(y|h)` is predictive.

**Phase 2 — calibration-frequency sweep.** Using a real RCP-managed
multi-commit task:

- Sweep reconcile/verifier frequency (run-to-completion once vs N checkpoints).
- Track per-frequency convergence: drift-to-zero success, steps to converge,
  and the failure mode when a long unverified segment is left to run.
- Measure board-resolve false-complete rate against reconcile as ground truth
  (the [signal-purity and debiasing analysis](agent-convergence-feedback-design/harness-formalization.md#signal-purity-is-an-sgd-bias-question-not-a-stratification-question)).
- Compare "resume from remembered drift state" vs "restart from scratch" for
  the cross-session leg.

The measurements decide whether the theory earns permanent architecture ([Closing the loop with what exists](#closing-the-loop-with-what-exists))
or stays a documented model.

## Executable v1 specification and decision gates

Read the complete responsibility: [Executable v1 specification and decision gates](agent-convergence-feedback-design/executable-v1-specification-and-decision-gates.md).

## Related documents

- [`docs/design/session-active-graph-runtime-design.md`](session-active-graph-runtime-design.md) — AG runtime blueprint ([Literature support](#literature-support) gap surfaces)
- [`docs/decisions/implemented/2026-08-29-session-active-graph-runtime.md`](../decisions/implemented/2026-08-29-session-active-graph-runtime.md)
- [`docs/design/memory-tesserae-design.md`](memory-tesserae-design.md) — tesserae SimHash drift (§4.4)
- [`docs/decisions/implemented/2026-08-29-repository-control-plane.md`](../decisions/implemented/2026-08-29-repository-control-plane.md) — RCP (§4.2)
