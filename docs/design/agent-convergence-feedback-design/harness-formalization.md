# Harness formalization

**Status:** draft
**Authority:** [Parent scope](../agent-convergence-feedback-design.md).

## Harness formalization

The [feedback-density model](../agent-convergence-feedback-design.md#the-feedback-density-model) states what decides whether an agent loop
converges. This section states what the Harness optimizes and where the
gradient actually lives. The lineage is old — checklists externalize cognitive
state, control theory corrects by feedback, operating systems manage working
sets and context switches, information retrieval ranks what to show, RL learns
small control policies — what is new is a strong frozen solver to arrange
context for.

### Objects and the closed loop

The base model π_θ is fixed and never trained. The Harness is a trainable
context-orchestration policy H_φ:

```text
C_t = H_φ(τ_t, I_t, f_t, e_t)            # context assembly
a_t ~ π_θ(a | C_t)                        # frozen solver acts
(s_{t+1}, e_{t+1}) ~ E(s_t, a_t)          # environment responds
```

τ_t is a **quest**: a unit of work the agent has externalized — written
down as an object that the world or the agent can later judge completed or
failed. I_t is the available information pool, f_t the current focus, e_t the
current event. (The name borrows the RPG sense — an adventurer accepts a
bounded commission, advances it, and completes it — because that usage is
stable across the model's corpus: "quest" names a bounded, judgeable unit of
commissioned work, not a promise or a mood. The Latin root is *quaesta* ←
*quaerere*, "to seek", the same lineage as *tessera*'s token vocabulary.)

### Completion is the local supervision signal

```text
y_t  = 1[τ_t completed]
h*_t = argmax_h [ P(y_t = 1 | τ_t, I_t, f_t, h) − λ·C(h) ]
h    ∈ { none, cue, resurface, retrieve, compress, wait, external acquisition }
```

The Harness does not judge the semantic correctness of a quest; it learns
which orchestration raises its completion probability. Minimum effective
intervention is not a style preference but the λ term: a 10-token cue that
achieves the same P(y=1) as a 5000-token retrieval strictly dominates it.

### The gradient is real, and it lives in φ

```text
L(φ)           = −E[y] + λ·E[C(h)]
φ_{k+1}        = φ_k − η·∇_φ L(φ)
u(d, p | τ, C) = P(y=1 | τ, insert(C, d, p)) − P(y=1 | τ, C)
```

The running agent has no explicit gradient; the trained Harness does. This
resolves where the SGD analogy lands: not on the agent's trajectory but on the
Harness parameters, with quest completion as the loss. u(d, p | τ, C) is the
marginal value of surfacing fragment d at position p — not relevance
Rel(q, d), but the causal contribution of one insertion to the current
quest's completion probability. That is the precise form of "learning
what to surface, when".

### Quests decompose credit assignment

A long trajectory with one final reward makes credit assignment hard. The
agent's own quests τ_1 … τ_n split it into short episodes:

```text
E_i = (τ_i, h_{i,1:k}, y_i)
```

long-horizon sparse reward → many short noisy rewards. One orchestration
decision per quest is a contextual bandit; sequential decisions inside
one quest are a small RL over a tiny action set. Complexity is added only
as evidence demands: supervised → bandit → RL. θ stays frozen; only φ (router
/ retriever / compressor / scheduler) moves — in this system that is the
DifferentiableController + autodiff + learned-router stack in `src/lab/`,
already gated to prune rather than rank, per the [biased-optimizer model](../agent-convergence-feedback-design.md#iteration-as-a-biased-optimizer).

### What quests are in this system

τ_t is not prompt-local scratchpad text. The objects that carry it already
exist, and their lifecycle events are the completion signal:

| Quest | Object | Completed / failed by |
| --- | --- | --- |
| "this task must be done" | board entry (ticket, goal kind) | resolve / expiry |
| "this evidence lives here" | bookmark (tessera) | relocation success / stale |
| "this content should hold" | document (design doc, contract) | commit / reconcile pass |

Completion read from an object lifecycle is an external fact, not model
self-assessment. Where no object exists and the agent merely declares "done",
the signal is a [biased intermediate goal](../agent-convergence-feedback-design.md#iteration-as-a-biased-optimizer) — it may guide, never gate.

### Relation to the convergence model

No global potential is required. Raising each local conditional completion
probability P(y_i=1 | H_{φ_{k+1}}) > P(y_i=1 | H_{φ_k}) suffices: if the
quest decomposition is meaningful, the long trajectory improves
indirectly. The two signal roles in the [feedback-density model](../agent-convergence-feedback-design.md#the-feedback-density-model) map exactly — quests provide
dense, local, lifecycle-grounded labels; RCP reconcile and human sign-off
provide sparse unbiased calibration that keeps the dense labels from training
H_φ into a self-consistent fixed point.

> Train the Harness not to solve tasks, but to organize context so that a
> frozen LLM maximizes the probability of completing the current quest.

The following sub-sections fold in results of an independent review of the
framework (a cross-check, not a requirements source) plus the bias analysis
that the review provoked. They sharpen where the gradient signal comes from,
how it stays unbiased, and what the objective's cost term actually means in
this system.

### One event stream, two theoretical roles

Quest lifecycle events — board resolve, bookmark relocation/stale, document
commit — play **both** theoretical roles at once:

- The [global calibrator in the feedback-density model](../agent-convergence-feedback-design.md#the-feedback-density-model): sparse, unbiased correction that keeps the loop
  from converging to a self-consistent fixed point;
- [Harness formalization](#harness-formalization-1)'s **local label source**: dense, lifecycle-grounded completion signals
  for φ.

One event stream feeds both. The wiring is therefore a single bus — object
lifecycle events into AG `observe()` plus a `(quest, h, y)` log pairing — not
two separate pipelines. This is the most economical structural fact of the
whole design.

### Signal purity is an SGD bias question, not a stratification question

The instinct to stratify completion sources by "externality" is an engineering
approximation. The correct theoretical frame is the **bias/variance structure
of gradient estimates**: SGD convergence only requires `E[ĝ] = ∇L`, so the
admission test for a signal source is unbiasedness, not purity.

| Gradient source | Mechanism | Bias | In ∇L? |
| --- | --- | --- | --- |
| Bookmark SimHash distance | SimHash computes; no agent involvement | unbiased, continuous | yes — dense |
| Document git commit | git fact | unbiased | yes — sparse |
| RCP reconcile | independent observation | unbiased | yes — rarest, most expensive |
| Board resolve | the agent's own action | **biased** — the agent has an incentive to report completion; systematic optimism, not random noise | no, unless debiased |

A biased source is not handled by down-weighting (stratification); it is
handled one of two ways:

1. **Excluded from ∇L** — used as an exploration prior or curriculum signal
   that guides behavior without entering the gradient.
2. **Debiased** — the external weigher (reconcile / tests) periodically
   measures the source's false-complete rate (resolve says done, reconcile
   finds otherwise); a measurable bias is correctable, turning the biased
   source into calibrated noisy gradient.

The debiasing frequency is the external calibration frequency — the critical
ratio described by the [feedback-density model](../agent-convergence-feedback-design.md#three-regimes-decided-by-a-ratio-not-by-step-count). This is why the framework's convergence does not live in
the mathematics alone: it lives in **who defines quests and who verifies the
quest chain** (see [What quests are in this system](#what-quests-are-in-this-system)).

The completion signal need not be binary. Bookmark weighing is a **continuous**
SimHash distance, so `y_t` can carry approach information (how close the quest
is) rather than only a 0/1 verdict — a denser gradient than the binary form.

### Exploration is part of the objective

`u(d, p | τ, C)` is a counterfactual: inserting and not inserting the same
fragment at the same position cannot both be observed on one trajectory.
Without deliberate intervention, collected data is confounded and `u` is
systematically biased toward information that happened to co-occur with past
interventions. The mathematics needs an explicit operator:

```text
h_t ~ ε-greedy(h*_t)              # ε decays as evidence accumulates
```

The decay structure has an existing precedent in this system: the learned
router's pruning gates (`examples ≥ N ∧ score < θ ∧ lexical guard`).
Exploration is itself subject to minimum effective intervention — probing an
expensive intervention is costly, so the ε schedule is part of `λ·C(h)`, not a
free budget. An always-random probe arm should be kept in production shadow so
the orchestration policy cannot become self-fulfilling; the action space is
small enough (six or seven discrete `h`) that ε's worst case is bounded by one
cue or one redundant retrieval — the loop is small enough to audit.

### The knowledge space is open

The "closed general knowledge" assumption (a strong frozen solver) needs one
refinement to be fully honest:

```text
π_θ parameters   = closed general knowledge (training cutoff, static)
observations     = open (files / tools / environment / current facts)
derived knowledge = written back through governed memory → K_t grows
```

An agent that deposits **verifiable** derived knowledge after each completed
quest raises `P(y=1)` for future quests of the same kind — knowledge compounds
across quests, which is how long-horizon gains are amortized without training
`π_θ`. This is the mechanism behind "your agent may change, your memory
doesn't have to": general knowledge expires with the model, verified knowledge
in `K_t` is the only asset that accumulates across generations.

The symmetric risk is contamination: derived knowledge may be wrong, and an
ungoverned write-back lets errors propagate through recall exactly as a
self-reinforcing loop does ([the information constraint](../agent-convergence-feedback-design.md#the-information-constraint)). NMG's memory governance — write policy,
truth status, supersession, claim outcomes requiring attributable evidence —
is therefore a **precondition of Harness validity**, not a separate feature:
a clean `K_t` is what keeps the `P(y|quest)` learning signal un-noised. Memory
content is never trained; only the orchestration `φ` moves, and content
governance stays rule-driven and externally verified.

### λ is the shadow price of the working-set budget

`λ·C(h)` is not an abstract cost term in this system. The AG budget ledger
shares one capacity pool across retrieval selections, tool observations, and
reasoning artifacts — every fragment placed into `W_t` draws from the same
`B`. So `C(h)` is a number the ledger already produces, and **λ is the shadow
price of working-set capacity**: minimum effective intervention and the hard
budget become two readings of the same constraint.

Reading it as a shadow price implies a soft-budget direction: a hard cap turns
into a purchasable limit when the marginal value `u(d,p)` justifies
overspend. That value signal is `u` itself, whose estimation requires the
exploration of [Exploration is part of the objective](#exploration-is-part-of-the-objective) — λ, u, and ε form one closed loop.

### Low-compute, router-only candidate

Read the complete responsibility: [Low-compute, router-only candidate](harness-formalization/low-compute-router-candidate.md).
