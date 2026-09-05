# Agent convergence under feedback density

**Status:** draft — candidate design, not an implementation or default-policy claim
**Date:** 2026-09-03

This document consolidates a design discussion into a single blueprint: a
theory of why long agent tasks fail (and succeed), the literature that supports
it, the parts of the existing NMG system that already implement pieces of the
model, and the candidate design that would close the remaining loop. It is
written so a future Agent can pick the thread up without re-deriving the
conversation.

## 1. The replaced model

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

## 2. The feedback-density model

### 2.1 Iteration as a biased optimizer

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

### 2.2 Three regimes, decided by a ratio, not by step count

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

### 2.3 The information constraint

External loss is the only information source that points at the target. If the
gradient is entirely self-generated, each iteration can only preserve or lose
information (data-processing inequality): the process converges to the model's
own fixed point, and self-distillation style iteration can collapse to a bland
self-consistent solution. This is why the loss cannot be written by the thing
being optimized — an information constraint, not a moral one.

### 2.4 Corollaries

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

§3 makes the trainable part concrete: the Harness, with a real gradient in its
own parameter space.

## 3. Harness formalization

The convergence model (§2) states what decides whether an agent loop
converges. This section states what the Harness optimizes and where the
gradient actually lives. The lineage is old — checklists externalize cognitive
state, control theory corrects by feedback, operating systems manage working
sets and context switches, information retrieval ranks what to show, RL learns
small control policies — what is new is a strong frozen solver to arrange
context for.

### 3.1 Objects and the closed loop

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

### 3.2 Completion is the local supervision signal

```text
y_t  = 1[τ_t completed]
h*_t = argmax_h [ P(y_t = 1 | τ_t, I_t, f_t, h) − λ·C(h) ]
h    ∈ { none, cue, resurface, retrieve, compress, wait, external acquisition }
```

The Harness does not judge the semantic correctness of a quest; it learns
which orchestration raises its completion probability. Minimum effective
intervention is not a style preference but the λ term: a 10-token cue that
achieves the same P(y=1) as a 5000-token retrieval strictly dominates it.

### 3.3 The gradient is real, and it lives in φ

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

### 3.4 Quests decompose credit assignment

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
already gated to prune rather than rank, per the biased-gradient rule of §2.1.

### 3.5 What quests are in this system

τ_t is not prompt-local scratchpad text. The objects that carry it already
exist, and their lifecycle events are the completion signal:

| Quest | Object | Completed / failed by |
| --- | --- | --- |
| "this task must be done" | board entry (ticket, goal kind) | resolve / expiry |
| "this evidence lives here" | bookmark (tessera) | relocation success / stale |
| "this content should hold" | document (design doc, contract) | commit / reconcile pass |

Completion read from an object lifecycle is an external fact, not model
self-assessment. Where no object exists and the agent merely declares "done",
the signal is a biased intermediate (§2.1) — it may guide, never gate.

### 3.6 Relation to the convergence model

No global potential is required. Raising each local conditional completion
probability P(y_i=1 | H_{φ_{k+1}}) > P(y_i=1 | H_{φ_k}) suffices: if the
quest decomposition is meaningful, the long trajectory improves
indirectly. The two signal layers of §2 map exactly — quests provide
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

### 3.7 One event stream, two theoretical roles

Quest lifecycle events — board resolve, bookmark relocation/stale, document
commit — play **both** theoretical roles at once:

- §2's **global calibrator**: sparse, unbiased correction that keeps the loop
  from converging to a self-consistent fixed point;
- §3's **local label source**: dense, lifecycle-grounded completion signals
  for φ.

One event stream feeds both. The wiring is therefore a single bus — object
lifecycle events into AG `observe()` plus a `(quest, h, y)` log pairing — not
two separate pipelines. This is the most economical structural fact of the
whole design.

### 3.8 Signal purity is an SGD bias question, not a stratification question

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
ratio of §2 again. This is why the framework's convergence does not live in
the mathematics alone: it lives in **who defines quests and who verifies the
quest chain** (see §6.1).

The completion signal need not be binary. Bookmark weighing is a **continuous**
SimHash distance, so `y_t` can carry approach information (how close the quest
is) rather than only a 0/1 verdict — a denser gradient than the binary form.

### 3.9 Exploration is part of the objective

`u(d, p | τ, C)` is a counterfactual: inserting and not inserting the same
fragment at the same position cannot both be observed on one trajectory.
Without deliberate intervention, collected data is confounded and `u` is
systematically biased toward information that happened to co-occur with past
interventions. The mathematics needs an explicit operator:

```text
h_t ~ ε-greedy(ħ*(τ, I, f))     # ε decays as evidence accumulates
```

The decay structure has an existing precedent in this system: the learned
router's pruning gates (`examples ≥ N ∧ score < θ ∧ lexical guard`).
Exploration is itself subject to minimum effective intervention — probing an
expensive intervention is costly, so the ε schedule is part of `λ·C(h)`, not a
free budget. An always-random probe arm should be kept in production shadow so
the orchestration policy cannot become self-fulfilling; the action space is
small enough (six or seven discrete `h`) that ε's worst case is bounded by one
cue or one redundant retrieval — the loop is small enough to audit.

### 3.10 The knowledge space is open

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
self-reinforcing loop does (§2.3). NMG's memory governance — write policy,
truth status, supersession, claim outcomes requiring attributable evidence —
is therefore a **precondition of Harness validity**, not a separate feature:
a clean `K_t` is what keeps the `P(y|quest)` learning signal un-noised. Memory
content is never trained; only the orchestration `φ` moves, and content
governance stays rule-driven and externally verified.

### 3.11 λ is the shadow price of the working-set budget

`λ·C(h)` is not an abstract cost term in this system. The AG budget ledger
shares one capacity pool across retrieval selections, tool observations, and
reasoning artifacts — every fragment placed into `W_t` draws from the same
`B`. So `C(h)` is a number the ledger already produces, and **λ is the shadow
price of working-set capacity**: minimum effective intervention and the hard
budget become two readings of the same constraint.

Reading it as a shadow price implies a soft-budget direction: a hard cap turns
into a purchasable limit when the marginal value `u(d,p)` justifies
overspend. That value signal is `u` itself, whose estimation requires the
exploration of §3.9 — λ, u, and ε form one closed loop.

### 3.12 Low-compute, router-only candidate

**Scope and precedence:** this subsection specifies a candidate for a limited
compute budget; it does not enable, implement, train, or validate a controller.
For this candidate, the evidence and budget boundaries below take precedence
over the stronger gradient, lifecycle-label, shadow-exploration, and soft-budget
claims in §§3.5–3.11. Those broader hypotheses are not prerequisites or guarantees
of this experiment.

Borrow the inexpensive gating structure of a mixture-of-experts (MoE) router,
not its pretrained weights or neural experts. A pretrained MoE gate maps one
model layer's token hidden states to that layer's expert identities; those
representations, outputs, and training objective do not match Harness state
features and intervention actions. Matching dimensions would not establish
semantic compatibility.

```text
quest / event / context / intervention history / resource features
                  ↓
          deterministic allowed-action rules
                  ↓
             small action-value router
                  ↓
     none / cue / resurface / retrieve
                  ↓
      existing operations through fixed executors
                  ↓
             frozen main LLM
```

The candidate would wrap existing operations, not train experts: `none` leaves
context unchanged; `cue` uses a fixed focus-reminder template; `resurface`
re-presents selected existing evidence; `retrieve` invokes a fixed retrieval
procedure. Their integration as these four executor interfaces is proposed,
not claimed to exist today. Fix templates, candidate selection, retrieval
settings, and per-action limits in the first comparison. Do not jointly learn
query generation, compression, deletion, or task acceptance criteria.

Rules outside the learner determine permissions, evidence eligibility, context
capacity, and hard budgets. The router chooses only among allowed actions;
`none` remains available, but cannot suppress mandatory verification or safety
feedback. A cost penalty never authorizes exceeding a hard limit.

#### Architecture and parameter budget

| Candidate | Mapping (biases included) | Trainable parameters |
| --- | --- | ---: |
| Initial baseline | `Q(x) = Wx + b`, `32 → 4` | `4×32 + 4 = 132` |
| Optional nonlinear comparison | `Q(x) = W2 sigmoid(W1 x + b1) + b2`, `32 → 16 → 4` | `16×32 + 16 + 4×16 + 4 = 596` |

These are starting configurations, not empirically optimal sizes. Outputs are
four action values, not probabilities; softmax and Top-K expert mixing are not
required. Use only pre-intervention observable features: event type, context
occupancy, time since verification, return from interruption, repeated errors,
prior interventions, candidate freshness/redundancy, and remaining resources.
Define and version the exact 32-feature schema before collecting training data;
normalize numeric features and encode missing values explicitly. Do not acquire
new LLM-generated features merely to run the small router.

`src/lab/autodiff.ts` is a candidate local computation substrate, not evidence
that this router is implemented or fast. Before using it for training, check
forward values and finite-difference gradients for these exact networks and
observed-action losses; if using compiled execution, compare it with the
uncompiled path across changing samples and action selections. Begin with
single-state updates rather than assuming batch broadcasting or softmax-axis
semantics. Weight storage alone excludes gradients, graphs, and temporary
buffers. Autodiff reduces gradient-computation work, not the cost of obtaining
credible intervention outcomes; no performance or correctness result is
asserted here.

#### Observed-action learning and evaluation

Start with an action-value regression model and exploration outside the network:

```text
h* = argmax_{h in allowed(x)} [Q_phi(x,h) - lambda K_hat(x,h)]
L_sample = (Q_phi(x,h_executed) - r_observed)^2
```

Here `r_observed` is a scoped outcome under a fixed evaluation window, not an
automatic reward for a lifecycle transition. Only the executed action's output
receives an outcome label; unexecuted actions are not failures. `K_hat` measures
expected total cost over the same window, including subsequent main-model
calls, tools, and latency, rather than just insertion tokens. Initially use a
fixed cost estimate; a separate cost head would change the parameter count and
is outside the two configurations above. Ordinary observational regression
estimates association, not causal action value.

Log the task and acceptance-condition version, pre-action features, allowed
set, selected and actually executed actions, selection probability, policy
version, evidence references, outcome window, and costs. Record cancellation,
timeout, missing evidence, and later reopening explicitly; missing evidence
is not a success label. Tests verify only exercised conditions, reconcile only
its declared contract, commit only a version boundary, and bookmark/SimHash
checks only location or textual drift. Board resolve remains self-report.
Neither external computation nor a measured false-complete rate automatically
makes a reward or its gradient unbiased. Keep later rework and final acceptance
as separate outcomes; local completion need not improve the full trajectory.

Use passive/shadow logging first to check instrumentation and policy differences.
It cannot identify benefits of actions that were never executed. To compare
interventions, actually execute randomized allowed actions (for example,
recorded epsilon-greedy assignment) in authorized experimental tasks, or branch
from reproducible state snapshots under matched budgets. A one-decision window
is a contextual-bandit approximation only while ignoring or bounding downstream
effects; it is not a proof that quests are independent episodes.

Compare fixed event rules, the 132-parameter baseline, and only then the optional
596-parameter MLP on held-out whole tasks. Use independently checked completion,
rework, final success, and end-to-end cost; split by task rather than nearby log
rows to reduce leakage. Retain a fixed-rule fallback until evidence supports
activation. No neural expert training, pretrained router transplant, larger
language-model manager, live benchmark run, or production-policy change is
part of this documentation candidate.

## 4. Literature support

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

## 5. What the system already has

### 5.1 NMG memory (STG/LTG, Task Board)

Role in the model: **state persistence**, the precondition that errors are not
absorbing — a failed session can be resumed from remembered state, and evidence
survives session boundaries. Also the natural carrier for **cross-session goal
continuity**: a goal that outlives one session is the difference between
"re-derive intent from the next prompt" and "continue a direction".

Existing: LTG/STG separation, supersession, truth-status governance, Task Board
coordination with claims and TTL.

Gap: externally approved long-term quests are **not first-class memory
citizens**. Board entries are temporary coordination (TTL, expire), not a
persistent quest store.

### 5.2 RCP (Repository Control Plane)

Role in the model: the **external verifier** — expensive, sparse, unbiased
correction. Contract declares intent; observe measures reality; reconcile
detects drift (changed paths, contract-vs-reality diagnostics); receipts are
immutable checkpoints; authority (plan/apply) sizes the step.

Existing: contract/observe/reconcile, idempotent re-observation, changedPaths,
fail-closed termination, receipts.

Gaps: reconcile drift events do **not flow back** — neither into the session
AG as observations nor into searchable memory for a later session. Continuous
observation is deferred (correctly, until run-to-completion feedback latency is
demonstrated fatal).

### 5.3 AG (session Active Graph runtime)

Role in the model: the **in-session closed loop** — the working-memory layer
where correction happens without touching durable truth.

Existing: task frames with a bounded cooling set (state survives a task switch
and a return does not rebuild from the transcript — the recoverable-eviction
property), immutable projection revisions with parent chains (checkpoint
sequence + attribution), `observe()` ingestion for tool observations and board
projections (temporary, deduped, budgeted), typed edge layers that stop
activation/reasoning from silently reinforcing semantic truth. Item kinds:
`semantic_memory | tool_observation | board_projection | reasoning_artifact`.

Gaps: reconcile events are not wired into `observe()`; external content
fragments are not a first-class ingestible kind — AG ingests tool observations
and board projections, but a bookmark (§5.4), an external snippet + path,
cannot be added as content, and when a memory enters the AG as a
`semantic_memory` item only its `statement` travels (its bookmarks do not ride
along). The combined budget (§4.3 of the AG blueprint) is partial. Adding
external content to the AG is an AG capability; nothing else needs a new
concept for it.

### 5.4 Bookmarks (tesserae)

Role in the model: the component that points memory at a source-file position
and verifies that the position still holds. When a memory resurfaces, its
bookmark relocates the agent to the exact snippet inside the project; it
passively checks whether the source file still matches what was written at
remember time — honestly reporting the bookmark stale when the fragment itself
no longer exists. A bookmark **fixes a content baseline and measures drift
against it**; today the baseline is the past snapshot of one file.

A bookmark is also **content the AG should be able to ingest**: it carries an
external fragment (snippet text + path) into session working memory. AG is the
container; the bookmark is the ingestible content. This ingestion does not
happen today: memory items enter the AG without their bookmarks.

Existing: records `{path, snippet, label}` written at remember time; two-stage
relocation (exact match first, drift recovery second). Drift recovery uses a
64-bit SimHash fingerprint (`file_simhash`) of the written file with an
empirically measured threshold (Hamming ≤ 6 at document scale). **SimHash is
the drift-detection technique inside the bookmark component, not a separate
system component.**

Gap: bookmarks are not yet ingestible into the AG. Their fix-a-baseline and
measure-drift machinery is proven against the past snapshot of one file; using
the same machinery on any ingested content fragment (a contract, an expected
final shape) is **reuse of the bookmark component, not a new one**.

## 6. Closing the loop with what exists

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

### 6.1 Validation gates what may gate

An agent writes intermediate goals constantly; it does **not** spontaneously
invent goals with no external target (it is an event-driven reactor — it
elaborates and decomposes, it does not self-initiate). Consequences:

- Self-authored goals are biased intermediates: they organize execution (task
  frames) and guide search; they never gate convergence.
- Convergence/projection gates accept only externally validated content:
  human sign-off, or content whose claims were exercised by a verifier.
  Authority comes from the validation act, not the authorship.

### 6.2 Two-level loop

- **In-session:** reconcile/verifier failure → drift event into AG `observe()`
  → small corrective steps in the same task frame → new projection → re-check.
  AG provides the structure (cooling set = momentum buffer, projection chain =
  checkpoint sequence); the missing wire is reconcile → observe.
- **Cross-session:** when a task genuinely spans sessions, drift events and
  completed quests become governed memory (with source markers), recalled
  by the continuation session. Form-drift checks and RCP verifiers reduce to
  the same unified event: drift from an externally fixed baseline.

## 7. Identified gaps (work queue)

1. **The single event bus does not exist.** Quest lifecycle events (board
   resolve, bookmark relocation/stale, document commit) and reconcile drift
   events are not surfaced into AG `observe()` with a `(quest, h, y)` log
   pairing — the one wire that feeds both the global calibrator (§2) and the
   local labels (§3.7). The AG ingestion gap (below) is the concrete first
   half of this.
2. AG cannot ingest external content fragments; bookmark ingestion is the
   concrete first case (memory items enter the AG without their bookmarks).
3. Reconcile drift events are not wired into AG `observe()`.
4. No intervention logging or ε-greedy exploration exists to make `u(d,p)`
   estimable (counterfactual data). Reuse pattern: learned-router gates
   (`examples ≥ N`, lexical guard, shadow-first) plus an always-random probe
   arm.
5. Board resolve is a biased completion source with no false-complete
   measurement / debiasing path via reconcile (§3.8).
6. Externally approved long-term quests are not first-class persisted memory
   (no cross-session continuity; knowledge-space compounding of §3.10 needs a
   governed goal store).
7. Bookmark drift machinery (baseline + SimHash metric + relocation) is proven
   only against the past snapshot of one file; reuse against any ingested
   target fragment is unwired.
8. The critical-ratio claim (§2.2) is unverified in this system; measurement
   comes before building (§8).

## 8. Candidate experiment

The repository has a measurement-first tradition. Before building any of §7,
two measurements come first:

**Phase 1 — sample pipeline before training.** Instrument the existing
decision points (AG disclosure, recall injection, retrieval) with the scoped
records in §3.12. Passive logging and an unexecuted shadow arm check coverage,
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
  (the debiasing data of §3.8).
- Compare "resume from remembered drift state" vs "restart from scratch" for
  the cross-session leg.

The measurements decide whether the theory earns permanent architecture (§6)
or stays a documented model.

## 9. Related documents

- [`docs/design/session-active-graph-runtime-design.md`](session-active-graph-runtime-design.md) — AG runtime blueprint (§4 gap surfaces)
- [`docs/decisions/proposed/2026-08-29-session-active-graph-runtime.md`](../decisions/proposed/2026-08-29-session-active-graph-runtime.md)
- [`docs/design/memory-tesserae-design.md`](memory-tesserae-design.md) — tesserae SimHash drift (§4.4)
- [`docs/decisions/implemented/2026-08-29-repository-control-plane.md`](../decisions/implemented/2026-08-29-repository-control-plane.md) — RCP (§4.2)
