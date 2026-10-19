# Executable v1 specification and decision gates

[简体中文](executable-v1-specification-and-decision-gates.zh-CN.md) · [Terms used](executable-v1-specification-and-decision-gates.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../agent-convergence-feedback-design.md).

## Executable v1 specification and decision gates

This section and [Low-compute, router-only candidate](harness-formalization/low-compute-router-candidate.md#low-compute-router-only-candidate) override incompatible earlier theoretical claims. The
objective is verified task utility per end-to-end resource budget, not fitting
lifecycle labels. The specification is revisable; failure to beat a fixed rule
is a valid experiment result and blocks extra architecture by default.

### Runtime ownership and dataflow

```text
RCP / board / bookmark / harness event (source-owned identity and version)
  -> session/task-frame observation (bounded, temporary, replay-idempotent)
  -> pre-action feature snapshot + permission/budget mask
  -> fixed fallback OR explicitly authorized experimental router
  -> decision journal (must succeed before any side effect)
  -> fixed action executor -> host model exposure
  -> fixed-window external verifier + measured costs
  -> outcome journal -> admission -> grouped offline dataset
  -> train / validation selection / untouched test -> reviewed policy artifact
```

No new authoritative global event service is required. Producers retain their
own facts and supply references through adapters. The harness owns the join and
ordered journal; AG owns temporary working state, not task acceptance. Board
resolve is a self-report event, commit a version event, and SimHash a textual
change event. They can trigger attention, never automatically a task reward.
RCP verifies only its declared contract. A failed receipt is useful feedback,
not evidence of either whole-task failure or permission to widen scope.

### Exact feature contract

`context-features-v1` has 16 values followed by 16 missing indicators. Missing
is `(0,1)`; observed zero is `(0,0)`. Ratios are in `[0,1]`, previous verified
reward in `[-1,1]`. The three counts saturate at 32 and divide by 32.

| Index | Feature | Encoding |
| --- | --- | --- |
| 0 | contextOccupancy | used / hard context capacity |
| 1 | remainingTokenRatio | remaining / initial token budget |
| 2 | remainingToolRatio | remaining / initial tool-call budget |
| 3 | topCandidateScore | bounded score under a versioned retrieval procedure |
| 4 | candidateScoreGap | first minus second bounded score |
| 5 | candidateCount | count / 32, saturated |
| 6 | candidateRedundancy | duplicate fraction under fixed identity rules |
| 7 | candidateFreshness | fraction whose source version remains current |
| 8 | stepsSinceVerification | count / 32, saturated |
| 9 | consecutiveFailures | count / 32, saturated |
| 10 | returnedFromInterruption | observed 0 or 1 |
| 11–14 | previousNone/Cue/Resurface/Retrieve | previous executed action one-hot |
| 15 | previousReward | earlier independently verified window only |

Unavailable measurements stay missing, never guessed by an LLM. Empty or zero
initial budgets yield missing ratios plus hard action denial, not division by
zero. All features must be available before selection. History is task/frame
scoped, clears on acceptance-version changes, and cannot read future outcomes.
The history-free ablation masks indices 8–15 with their missing indicators.

### Actions, journal and failure handling

`none` returns no extra content; it does not cancel mandatory safety feedback.
`cue` uses the fixed versioned reminder. `resurface` selects whole existing
fragments in caller-provided order. `retrieve` invokes one fixed procedure with
an abort signal and context cap. The host is required to check authorization
before calling and before exposure. The current adapter returns bounded content
but does not itself expose it to the main model; model-exposure integration
remains open (see the acceptance table). Context truncation at whole-fragment
boundaries preserves source identity; a fragment too large is omitted rather
than silently rewritten. All actions share the same hard envelope. Cost
subtraction never raises that envelope.

The journal records immutable decision, execution and outcome revisions. An
unwritten decision cannot execute. A write failure after execution leaves an
unknown outcome and forbids automatic re-execution; reconcile with the external
tool's idempotency identity first. Exact repeated delivery is deduplicated;
changed decisions under the same ID are errors. An error or reopening revision
retracts the label on dataset rebuild. Existing trained artifacts containing a
retracted label must be invalidated/retrained before promotion, not silently
patched by treating reopening as another independent negative example.

`runContextTrial` awaits every sink barrier, including asynchronous sinks. Its
execution revision fingerprints generated content and source IDs and records
actual executor tool calls. Evaluation receives a copy; the independent verifier
receives a separate actual-result snapshot, not an evaluator-mutated object.
Outcome tool-call totals below the executor count are rejected even on dataset
replay. Tokens, reward, model exposure and broader-window costs still require
source-backed verification; neither a digest nor `() => true` authenticates them.
Timeout abort signals are distinguished from other executor cancellations.

`ContextTrialJournal` is an optional local durable sink, not a distributed event
service. It holds an exclusive lifetime lock, appends/fsyncs each record, checks
identity/phase transitions, refuses duplicate decision reservations, preserves
reopening and replays latest states. A corrupt/torn tail or stale lock fails
closed; an uncertain write poisons the instance. Size caps stop further writes
rather than silently rotating away idempotency evidence. Operators must inspect
crash state before unlocking/rotation. Cross-journal/task serialization, safe
recovery, model exposure and external evidence verification remain host duties;
local fsync is not portable third-party attestation or a distributed transaction.

### Learner and low-dimensional history decision

The initial architecture remains `32 -> 4`, 132 parameters, observed-action
squared-error regression using the existing autodiff substrate. Selection is
cost-adjusted epsilon-greedy over allowed actions; propensity is a sampling
probability, not calibrated confidence. Do not train on a shadow choice. Snapshot
branches label only actions actually executed in each branch.

First compare fixed rules, the history-free linear head, and that same head
with measured history features. Only if held-out sequential tasks show an
unresolved history-dependent error should the next comparison add an 8-dimensional
recurrent state or bounded causal history-node attention. Such nodes belong to
Agent decision steps, not inaccessible main-LLM hidden layers. Their parameters,
state reset rules, gradient tests, compute and memory limits must be specified
in that experiment before fitting. There is no reason yet to implement either
this network or the optional 596-parameter MLP merely to fill a diagram.

### Calibration and activation

Benchmark data is allowed for training and calibration; natural data volume is
not a prerequisite for an offline experiment. Preserve source dataset hash,
conversation/task group, executor/feature/acceptance versions, policy identity,
actual execution, outcome window, provenance and cost measurement method.
Synthetic fixtures establish mechanisms only. Source groups, not nearby rows
or paraphrases, define independent train/validation/test partitions. Select
hyperparameters on validation only; after inspecting test results, subsequent
changes require a new independent evaluation or an explicitly exploratory label.

The LoCoMo component probe is custom lexical evidence scoring, not a product
retrieval benchmark. It cannot test cue utility, sequential history or main-model
success. The official answer pipeline remains owned by OmniMemEval; integration
must preserve official scoring and compare matched context interventions under
identical main-model settings. End-to-end windows include later model/tool cost,
rework and final acceptance, not only inserted characters.

Promotion requires a predeclared task metric, non-inferiority margin, budget and
failure thresholds; held-out independent groups; uncertainty estimates; no safety
violations; and no unacceptable quality/cost regression relative to the fixed
fallback. Until these are supplied, the gate is closed rather than inventing
thresholds after seeing results. Policy artifacts bind data/code/feature hashes,
training settings and approval scope. The host can revert to the fixed rule
without changing memory content. A good offline score alone never enables the
policy globally.

### Remaining integration acceptance

| Integration | Required acceptance before calling it complete |
| --- | --- |
| Lifecycle producers | source IDs, replay dedup, task/frame isolation and failure receipts reach AG without becoming rewards |
| Bookmarked fragments | exact source/version checks, external text treated as data, total AG budget enforced, stale/missing source remains explicit |
| Long-lived quests | existing governed memory stores externally approved target/version/evidence; resume revalidates it, not trusts board resolve |
| Model exposure | captured projection matches actual injected context; cancelled/non-exposed actions cannot become executed-model samples |
| Production journal | local duplicate/replay protection exists; cross-journal recovery, task serialization and late-reopen invalidation of dependent deployed artifacts remain required |
| Outcome admission | independent source adapters verify score, identity, window and costs; unverified self-report remains excluded |
| Efficacy | matched held-out main-model tasks beat or meet predeclared fallback quality/cost gates; component tests do not substitute |

These gates distinguish a specified design from an implemented system and an
implemented system from an empirically useful default. No overall completion
claim is authorized while these integrations remain open.
