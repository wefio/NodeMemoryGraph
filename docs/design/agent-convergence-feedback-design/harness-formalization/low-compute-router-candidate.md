# Low-compute, router-only candidate

[简体中文](low-compute-router-candidate.zh-CN.md) · [Terms used](low-compute-router-candidate.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../harness-formalization.md).

## Low-compute, router-only candidate

**Scope and precedence:** this subsection specifies a limited-compute candidate
policy, not an enabled product controller. The repository now contains research
primitives for the 132-parameter `ContextRouter`, `context-features-v1`, and a
four-action `context-executor`; their existence does not assemble or activate
the candidate policy, establish task utility, or authorize production use. For
this candidate, the evidence and budget boundaries below take precedence over
the broader [Harness claims in §§3.5–3.11 of the parent design](../../agent-convergence-feedback-design.md#35-what-quests-are-in-this-system),
especially its stronger gradient, lifecycle-label, shadow-exploration, and
soft-budget claims. Those hypotheses are not prerequisites or guarantees of
this experiment.

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

The candidate wraps existing operations, not trained experts: `none` leaves
context unchanged; `cue` uses a fixed focus-reminder template; `resurface`
re-presents selected existing evidence; `retrieve` invokes a fixed retrieval
procedure. A four-action bounded adapter now exists in
`src/lab/context-executor.ts`: it returns content to its host, while `retrieve`
delegates to one caller-supplied procedure. It does not expose content to the
main model or provide production integration. Fix templates, candidate
selection, retrieval settings, and per-action limits in the first comparison.
Do not jointly learn query generation, compression, deletion, or task acceptance
criteria.

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
The current 32-input contract is versioned as `context-features-v1` and
implemented in `src/lab/context-features.ts`; see [Exact feature contract](../executable-v1-specification-and-decision-gates.md#exact-feature-contract).
Future changes to feature meanings require a new version before collecting data.
Normalize numeric inputs and encode missing values explicitly. Do not acquire
new LLM-generated features merely to run the small router.

`src/lab/autodiff.ts` is the substrate used by the current 132-parameter
`ContextRouter` prototype; that primitive does not show that this candidate
policy is fully integrated, fast, or effective. The component test
`tests/core/context-router.test.ts` checks observed-action updates and finite-
difference gradients across changing samples and actions, but does not establish
end-to-end policy efficacy. Before using the head for training, check forward
values and finite-difference gradients for the exact network and observed-action
loss; if using compiled execution, compare it with the uncompiled path across
changing samples and action selections. `ContextRouter.update()` currently
updates one state/action/outcome at a time; do not assume batch broadcasting or
softmax-axis semantics. Weight storage alone excludes gradients, graphs, and
temporary buffers. Autodiff reduces gradient-computation work, not the cost of
obtaining credible intervention outcomes; no performance or policy-efficacy
result is asserted here.

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
