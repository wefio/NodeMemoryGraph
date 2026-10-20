# Learnable routing and minimal differentiable query graphs

[简体中文](learnable-routing-and-differentiable-query-graphs.zh-CN.md) · [Terms used](learnable-routing-and-differentiable-query-graphs.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Learnable routing and minimal differentiable query graphs

NMG contains a zero-dependency, CPU-optimised UOp autodiff engine built entirely
on Float32Array. It follows tinygrad's separation of concerns: Tensor is a
graph-building frontend over the UOp DAG, evaluation is lazy, and gradient
construction is separate from graph execution. NMG deliberately omits
scheduler, kernel lowering, code generation, JIT, and device runtime because
the controller workload (~280 KFLOPs/query) does not justify them.

This engine is Lite infrastructure, not a claim that STG, LTG, or AG are
themselves differentiable. Those graphs are semantic and runtime data
structures. A controller may build an ephemeral differentiable projection from
their numeric features, optimise its parameters, then hand the result back to
ordinary budgeted graph selection.

The Pi adapter has a lazy controller bridge behind a typed runtime policy
channel. `NMG_CONTROLLER_SHADOW=1` enables bounded collection; it does not
choose runtime authority. `NMG_CONTROLLER_RUNTIME_MODE=off|shadow|controlled|active`
(default `shadow`) determines authority ([mode requirements](../../../skills/nmg-memory/references/optional-capabilities.md#learned-controller)):
`off` performs no learned scoring; `shadow` may score and log but cannot
actuate; `controlled` may actuate only inside an explicitly marked controlled
evaluation; and `active` additionally requires a reviewed activation receipt. The receipt binds the exact trained-state hash,
feature-protocol version, retrieval/controller/product gate artifacts, and a
distinct prior controller state that the current runtime can load for rollback.
Missing, modified, or unloadable artifacts fail closed. QPP1/QPP2
`active` and `NMG_CONTROLLER_RERANK=active` therefore expose capabilities, not
authority by themselves. A zero-step controller is inert, and all active
outputs remain inside hard minimum/normal/expanded envelopes.

Only typed numeric `allocate`, `fold`, and stable rerank decisions cross this
channel. Candidate policy text, activation metadata, controller protocol, and
gate artifacts never enter the answering Agent's prompt. Controlled and active
actuation logs include mode, feature-protocol version, and candidate hash so a
run can be attributed to the exact learned artifact.

The bridge records baseline and learned node order in a bounded log under
`NMG_DATA_DIR`. Exact records fetched from a session-owned Active Graph are
logged as disclosure; the conservative answer-to-memory matcher used by
automatic recall is logged as diagnostic attribution. Neither trains the
controller. Evidence ranking and budget heads train only from verified
user/tool/official-benchmark evidence joined offline. Injection, rank position,
mere exposure, answer overlap, and silence are never positive labels. Explicit
`nmg_remember action=feedback`
labels remain a separate source for task success, evidence sufficiency,
expansion utility, noise, and no-memory-needed judgments; cross-session graph
IDs fail closed. Missing explicit feedback remains unknown. Thus shadow mode
cannot change retrieval, while active QPP modes are an explicit experimental
product choice rather than an automatic calibration promotion.

All ordinary clients resolve the shadow log and database through one data-path
contract: explicit `NMG_DATA_DIR` wins, otherwise the user-level `~/.nmg` store
is used. Controlled/headless evaluations pass a project-local `.nmg` fallback or
set `NMG_DATA_DIR` explicitly. The Pi extension, daemon client, CLI service,
shadow exporter, and non-Pi adapter share this resolver. **Implemented and
covered by path-contract tests.** This distinction prevents ordinary long-term
memory from fragmenting by working directory while keeping benchmark state
isolated.

Because answer-quality labels only become observable after an Agent turn, the
Pi bridge keeps completed retrievals whose evidence was actually disclosed and
whose explicit task labels are missing in session-local state. Diagnostic answer
overlap does not participate in this choice. On the next distinct user turn the
bridge exposes at most one one-shot
review reminder containing the AG ID and stable query task ID. Internal Pi tool
loops with the same user prompt cannot consume the reminder. The Agent may
submit `evidenceSufficient`, `expansionUseful`, `excessiveNoise`, and
`noMemoryNeeded` through the existing remember feedback action. Missing review
remains unknown; completion, silence, exposure, or lack of a correction is not
itself a label.

Reminder exposure is logged as a non-training `tool_flow/feedback_nudge_shown`
event. This separates "the Agent skipped an observable reminder" from "no
reminder was presented" without turning either case into a relevance label.
Query-derived task IDs establish lifecycle separation, not semantic diversity;
calibration must additionally require enough varied natural tasks and must not
count paraphrases of one decision as broad evidence.

The stable daemon already owns agent-neutral `search -> get(activeGraphId)`
disclosure tracking and diagnostic answer attribution. The richer feedback
action stays in the Pi adapter because only the
harness can observe answer completion, user correction, tool rounds, and model
usage. A future second adapter should implement the same versioned shadow-event
contract rather than adding a Lab-dependent feedback method to the stable daemon
protocol.

Controller activation evidence uses one scored-artifact contract rather than
joining unrelated benchmark summaries. Every matched Pi row records prompt-to-
settled and whole-answer latency, tool dispatches, tool-bearing model rounds, and
provider input/output/cache token usage from the exact Pi event stream. Official
scorers add a `rowScore` that always preserves the benchmark's numeric task score
while making binary `taskSuccess` nullable: PersonaMem and LongMemEval provide a
binary task label, whereas BEAM partial rubric/Kendall scores and LoCoMo's
continuous official score do not. Evidence sufficiency is likewise nullable and
typed by provenance (`id` or diagnostic `text`); missing labels are never
converted to zero.

Only complete same-case/same-repeat arm pairs may aggregate into
`ControllerMatchedProductMetrics`. Aggregation fails closed on a missing arm,
missing binary task label, missing all-evidence label, mismatched evidence kind,
missing token/tool/latency telemetry, or a candidate that did not actually
affect retrieval. The matched runner requires an explicit frozen candidate
state, checks its feature protocol and non-zero training steps, hashes it into
the report, and copies it only into the candidate arm. Runtime
`allocate|fold|rerank` actions are typed events; the scorer derives causal
eligibility from these events and rejects any baseline actuation rather than
trusting a report-authored boolean. An official score artifact with
non-null gate-safe metrics can be fed into the offline controller evaluation through
`NMG_CONTROLLER_MATCHED_PRODUCT_REPORT`; the exact scoring and calibration
commands are documented in the [evaluation workflow](../../../evals/README.md#real-use-controller-calibration)
and [controller calibration guide](../../../skills/nmg-memory/references/qpp-calibration.md#natural-controller-shadow-collection).
Malformed or diagnostic-only artifacts remain absent from the product gate. A
one-question causal smoke proves this execution path; it does not establish
candidate quality or authorize active/default routing.

The same bounded log records harness-level progressive-disclosure interventions
as separate `tool_flow` events. In particular, a third explicit search made
without loading evidence is recorded as `search_suppressed`; it is not counted
as a retrieval, a task success, or a relevance label. This makes prompt/tool
loops measurable without contaminating controller training targets.

Retrieval events retain the existing AG query fingerprint, QPP components and
expansion stages, and per-selection scores. The offline controller-dataset
exporter joins retrieval/disclosure/attribution/outcome/feedback by graph,
accepts only separately labelled rows, and performs a chronological split over whole
`semanticTaskId` groups. Query fingerprints remain diagnostic identifiers and
are never promoted to semantic-task labels. Sparse logs produce explicit
blockers and cannot authorize a policy change.

Task grouping alone is not a sufficient leakage barrier. Query-derived task IDs
can differ for paraphrases that share the same evidence. Calibration therefore
derives a conservative **primary evidence target** only from verified claim
support, never from loading or answer overlap. The activation gate requires
enough distinct primary targets in training
without letting one multi-evidence task inflate the diversity count. Leakage is
checked more strictly against the complete verified-evidence sets: any memory used by
both training and validation rejects the split, even when it was not the primary
record in either row. The primary target is a diversity proxy, not a claim that
one record completely represents a semantic task; multi-evidence questions
retain their complete verified-evidence set in the replay row.

Every new retrieval event also stores the exact
`CONTROLLER_FEATURE_PROTOCOL_VERSION` feature snapshot and the contemporaneous
Active Graph hard-budget envelope. This is required for offline replay: labels,
QPP scores, and observed cost alone cannot reconstruct the controller input or
its normalized budget targets. Legacy rows without either snapshot are reported
and excluded.

`npm run eval:controller-calibrate` consumes only fully labelled chronological
train/validation rows. It trains a fresh candidate, evaluates baseline versus
residual learned node ranking plus the generic stop/expand head, reports
retrieval/controller/end-to-end/token/tool costs, and writes an auditable
candidate artifact with source-log fingerprint, feature version, effective
configuration, data window, metrics, and rollback-state fingerprint. The
artifact is never installed automatically and always reports
`eligibleForActivation: false`; activation remains a later matched gate.

That later gate is now explicit and has three independent parts. The retrieval
gate protects upstream candidate recall; the controller gate protects held-out
ranking/control quality and inference latency; and the product gate requires a
matched baseline/candidate comparison with enough paired cases. The product gate
fails closed when matched evidence is absent and requires non-degraded task
success and evidence sufficiency together with bounded mean tool rounds, tokens,
and end-to-end latency. These product costs are not added to the AG allocation
head: tool rounds include non-NMG tools, and observational task success does not
identify the causal effect of a memory action. Hard AG and harness limits remain
outside the differentiable graph.

Progressive disclosure also constrains tool sequence, not only returned text.
Within one Pi user turn, automatic recall is free, but after two explicit
searches without loading selected evidence the adapter folds another search
into a request to call `nmg_get` or use a current-source tool. A successful
exact get reopens search for a complementary hop. The guard is keyed by Pi
session plus user prompt because `before_agent_start` also fires during internal
tool loops; resetting on that lifecycle event alone would make the bound
ineffective. This is a harness cost/safety boundary, not a relevance judgment
and not a replacement for QPP.

### UOp op catalogue

Read the complete responsibility: [UOp op catalogue](learnable-routing-and-differentiable-query-graphs/uop-catalogue.md).

### Performance optimisations

Element-wise ops use raw `for` loops. Matmul uses ikj loop order for cache
locality. `Negate` is compile-time folded from `multiply(x, Constant(-1))`.
`SumN` fuses chain-add sequences into a single N-input op. `Tensor.fromBuffer()`
enables zero-copy constant construction. Controller auto-batches inputs into
`[F,B]` matrices at threshold B≥8.

### Architecture

The persistent semantic graphs, the session Active Graph, immutable projection
revisions, and differentiable computation graphs are distinct objects:

```text
persistent STG + LTG in SQLite
  → retrieve candidates for a session/task frame
  → HierarchicalActivation.propagate(query, candidates, neighborhood, AG state)
     ├─ g₁: query → candidates cross-attention (learnable temperature)
     ├─ g₂: g₁ → neighborhood cross-attention
     ├─ g₃: L2Normalize(g₁+g₂+h₁+h₂+h₃)  spatial fusion
     ├─ h₁: EMA of g₁ across propagate() calls  (short-term temporal)
     ├─ h₂: mean of medium-term stable vectors   (from graphState)
     ├─ h₃: mean of long-term stable vectors     (from graphState)
     └─ 7-weight blended scoring → nodeScores
  → update the memory-resident session AG under hard budgets
  → optional MGR traversal over a bounded selected subgraph
  → HA rescore + DifferentiableController(node/edge/control/budget scores)
  → freeze a discrete ProjectionRevision for model exposure
```

The autodiff computation graph is ephemeral — created per propagate/train call
and discarded. The session AG is also non-persistent, but can survive multiple
turns and compaction within its owning session. SQLite, semantic provenance,
consolidation, immutable projection revisions, and hard budget enforcement
remain ordinary deterministic system components.

Variable semantic granularity remains an experimental question. Hierarchy-only,
record-vector, and independently ranked union retrieval are retained as
diagnostic modes, but none is a mandatory NMG representation until a matched,
fingerprinted, repeated benchmark demonstrates a quality/cost advantage.
