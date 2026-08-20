# NMG active TODO list

**Purpose:** track only unresolved work. Completed implementation history belongs
in Git; durable behavior and decisions belong in the design, Skill, or operating
documents. Remove an item here as soon as it is implemented or deliberately
closed.

## 1. Collect trustworthy verified-evidence supervision

- [ ] Accumulate materially independent Pi+NMG tasks with retrieval, exact
  `get` disclosure, expansion depth, user/tool-verified evidence,
  outcome/correction, injected
  tokens, tool rounds, and end-to-end latency.
- [ ] Label evidence sufficiency, expansion usefulness, excessive noise, and
  no-memory-needed separately. Silence or an uncorrected answer remains
  `unknown`, not success.

The capture, session-ownership, provenance, aggregation, and chronological
task-group splitting plumbing is implemented. Controlled examples may validate
plumbing but cannot count as natural product evidence: ordinary Pi writes
`natural`, headless probes write `controlled`, and legacy events without a
collection origin are excluded. A cross-process lock protects JSONL rotation.

As of the latest 2026-08-20 read-only audit, the bounded shadow log contains
1,078 events, 338 retrieval graphs, and 52 fully labelled natural graphs. A
controlled ordinary-Pi smoke produced the first disclosure, one
`verified_claim_support`, one diagnostic `answer_overlap`, and an outcome with
measured tool rounds, tokens, and latency; it is excluded from natural labels.
The source and installed Skill now require
`nmg.v6` and fail closed instead of silently dropping attribution or claim-origin
RPC. The shared daemon was explicitly restarted on 2026-08-20 and is now a
compatible v6 process, so subsequent ordinary Pi sessions can exercise the new
event path. Existing labels meet the provisional sample-count target but do not
supply useful-evidence targets in the held-out segment. New
collection must therefore emphasize tasks where the Agent receives explicit
evidence confirmation or a tool-verifiable outcome, along with natural
corrections and failed outcomes; more binary sufficiency labels alone will not
unlock calibration. API answer overlap and black-box counterfactual response
differences remain diagnostics and must not fill this gap.

The stable Agent memory policy now exposes the claim-outcome boundary instead
of leaving it discoverable only through an action parameter description. It
asks for an exact current-session user message or successful tool result that
independently supports or contradicts a disclosed claim, and explicitly rejects
retrieval, answer reuse, task completion, silence, and lack of correction as
claim evidence. An isolated two-turn Pi probe verified search -> exact get ->
independent user confirmation -> `claim_outcome=supported`; the event retained
its evidence record and `controlled` origin. This proves prompt discoverability
and provenance plumbing, but it remains controlled evidence and does not close
the natural-data collection item.

Automatic recall now applies the existing `retrieve|cue|none` load gate. Pi also
enforces a per-turn construction-process budget (three searches, five total
search/get calls, exact-evidence progression, and no-gain stopping), preventing
repeated tool expansion from bypassing the final AG projection budget.

## 2. Calibrate retrieval and the differentiable controller

- [ ] On semantic-task/time splits, compare the frozen heuristic with a shadow
  candidate and persist feature version, data window, effective configuration,
  metrics, and rollback target.
- [ ] Add distinct next-tier and search-recommendation labels only when real
  traces separate them reliably from generic expansion.
- [ ] Optimize evidence/answer sufficiency together with explicit token,
  tool-call, depth, and latency costs; keep hard safety and budget limits outside
  the differentiable graph.
- [ ] Promote only low-risk decisions after a matched shadow evaluation. Do not
  introduce a contextual bandit or long-horizon RL without the corresponding
  logged propensities or sequential credit-assignment evidence.

QPP1, QPP2, and search recommendation remain independently switchable. Their
current constants are cold-start priors, not calibrated probabilities. The
2026-08-20 chronological calibration used 43 training rows and 7 validation
rows. Its control accuracy was 0.857 and learned-controller inference averaged
0.036 ms, but the gate correctly rejected promotion: training had only one
primary useful-evidence target and validation had none. Baseline and learned
precision/recall were consequently both zero. The calibration runner now times
the heuristic baseline and learned controller separately instead of comparing a
combined learned path against a hard-coded zero baseline.

The rolling worker and rollbackable shadow artifact already exist
(`npm run eval:qpp-tau`). The unresolved requirement is evidence-diverse natural
data plus a matched held-out shadow result, not worker plumbing or another fixed
sample-count threshold.

Active/default eligibility now also has a separate fail-closed matched-product
gate. It requires paired baseline/candidate task-success and evidence-sufficiency
rates plus bounded mean tool rounds, tokens, and end-to-end latency; absent
matched measurements cannot pass. Tool rounds deliberately remain outside the
AG budget head because they include non-NMG tools, while observational task
success alone is not a causal policy target. The unresolved work is to collect
matched natural arms and feed these typed metrics into the gate; offline replay
cannot substitute for that product evidence.

The matched runners now capture exact Pi tool rounds, tool calls, provider token
usage, prompt latency, and answer lifecycle latency. Official scoring emits a
lossless nullable row shape: continuous BEAM/LoCoMo scores are not relabelled as
binary success, PersonaMem has no invented evidence label, and LongMemEval keeps
its official session-ID any/all/recall/NDCG evidence metrics. A fail-closed paired
aggregator emits the five typed product-gate metrics only when every same-case,
same-repeat arm pair is complete and the candidate actually affected ranking.
The controller evaluator can consume such an official score artifact through
`NMG_CONTROLLER_MATCHED_PRODUCT_REPORT`.

A one-question 2026-08-20 LongMemEval smoke run verified the full telemetry and
official-scoring path. Both NMG arms answered correctly and loaded one of two
official evidence sessions; the artifact correctly emitted no gate metrics with
`candidate_does_not_affect_ranking`, because the existing shadow arm only logs.
The remaining work is a true causal baseline/candidate matched protocol and
evidence-diverse natural product observations—not measurement plumbing and not a
join across OmniMemEval artifacts.

## 3. Validate unattended memory maintenance

- [ ] Measure STG-to-LTG consolidation precision and reversibility on natural
  outcomes before enabling unattended promotion by default.
- [ ] Evaluate automatic node-merge proposals on natural data, including false
  merges, scope conflicts, aliases, rollback, and source-actor identity.

The deterministic gates, rollback mechanisms, and controlled tests exist.
Natural-data validation is the missing evidence, not another merge algorithm.
The automatic identity actuator is now wired behind the default-off
`NMG_TOPOLOGY_AUTO_MERGE=1` switch. It accepts only strongly gated `same_as`
proposals with one unambiguous scope identity, stores the resulting reversible
transform on the proposal, and limits each maintenance pass. The assessment now
also rejects Assistant/system-authored identity evidence and requires the two
candidate nodes to share at least one user/tool source-actor class. This is a
local provenance-class safety gate; its natural false-rejection/false-acceptance
cost still needs measurement. Do not enable it by
default until scope, temporal-state, same-name identity, false-merge, and
rollback outcomes are represented in the natural validation set.

The latest ordinary-Pi topology audit found one pending `refines` proposal,
zero `same_as` or `distinct_from` relations, zero accepted or rejected identity
proposals, and zero transforms or rollbacks. Before default enablement, natural
validation must include true identity pairs, accepted merges, rejected false
merges, scope conflicts, and competing `distinct_from`/`contradicts` evidence.

A second ordinary online-Pi audit found that the real stores had STG records but
zero `claim_outcome_events`, zero claim posteriors, and therefore zero
consolidation candidates or reversals. The missing product boundary is now
wired explicitly: Pi `nmg_remember action=claim_outcome` and CLI
`nmg claim outcome` accept only attributable `supported|contradicted` results
with stable source lineage and semantic-task identity. Ordinary retrieval,
answer reuse, and silence still do not create votes. The default actuator remains
off; natural precision and reversal evidence must now accumulate through this
boundary.

The Pi bridge now also connects this boundary to controller supervision. After
the daemon accepts an attributable user/tool outcome, Pi emits a cumulative
`verified_claim_support` event for the exact current-session Active Graph that
contained the memory. A model-authored `task` outcome updates its explicit claim
posterior but cannot silently become a verified retrieval target. A live v5
source-audit task exercised the canonical database path with one supported and
one contradicted memory: both events retained the exact tool excerpt through a
non-null `evidence_id`. A controlled ordinary-Pi run after adapter reload then
proved the complete search → exact get → tool-source outcome → verified shadow
attribution path without being counted as natural calibration evidence.

The evidence inventory is reproducible without touching the live stores:
`npm run eval:natural-maintenance -- --project-dir <project>` opens every input
SQLite database read-only and reports the exact claim, posterior, consolidation,
proposal, transform, rollback, and maintenance-backlog counts. The latest
Post-restart live traffic on 2026-08-20 found 286 LTG memories (243 active), one active project STG
memory, four LTG claim outcomes in three semantic tasks with two posteriors, zero
STG→LTG materializations, one
pending `refines` proposal, zero identity proposals/transforms/rollbacks, 13
uncompacted index deltas, and 23 pending accesses. Claim outcomes now retain
`natural|controlled|legacy` provenance: the current four events are one controlled
smoke and three migrated legacy events, so the natural count remains zero. The
first ordinary v5 search/get/write sequence reduced the distributed write backlog
from 17 nodes to 14. Subsequent smoke writes raised it to 17 deltas across 16
nodes, and the next ordinary attributable v6 state write drained it again to 13
deltas across 13 nodes, with a per-node maximum of one. Both distributed-pressure
flags are false. This repeat validates bounded sparse-backlog maintenance without
claiming consolidation quality. The remaining zeros are product-evidence
gaps; the audit command and controlled tests do not convert them into natural
validation.

## 4. Separate controller policy from the Agent answer policy

- [x] Give the progressive-recall controller its own policy channel that cannot
  leak controller protocol into the user-facing answer. A SkillOpt candidate may
  alter only `SKILLOPT_POLICY_CHANNELS.controller`; the answering Agent always
  receives the reviewed canonical YAML through `SKILLOPT_POLICY_CHANNELS.agent`.

The original readiness and promotion experiment are complete. The formal export
passes at 12 train, 6 chronological validation, and 6 untouched test tasks. An
official three-epoch SkillOpt run improved held-out validation hard accuracy from
1/6 to 4/6 and untouched test hard accuracy from 1/6 to 2/6. The matched Pi+NMG
gate then rejected the candidate: canonical policy passed 6/6 cases, while the
candidate passed 4/6 and emitted internal `recall_action`/`fold_noise` JSON in
user answers. This is useful evidence that the offline controller contract and
the global Agent policy are different artifacts. The canonical YAML was not
changed. The two channels are now physically separate and covered by a
candidate-isolation regression. The Lab candidate is not applied to the
answering Agent; until a typed controller actuator consumes it, controller
quality is evaluated only through the isolated SkillOpt adapter.

## Explicitly deferred — not missing current work

These options return to the active checklist only after their prerequisite is
observed:

- Cloud synchronization and multi-device conflict resolution: only when
  multi-device operation enters scope.
- Rust/Python rewrites: only after a measured TypeScript bottleneck or an
  unavoidable native dependency.
- vLLM as a runtime dependency: rejected for the local-first default.
- Strict Huffman storage: only if tier/block access misses measured scale or
  latency targets.
- Automatic multi-edge motif consolidation: only after ordinary node and edge
  adaptation have trustworthy natural labels.
- L5 physical purge: only after privacy, recovery, and user-consent policy is
  reviewed and implemented.
- Full long-horizon reinforcement learning: only after a real sequential
  credit-assignment problem is demonstrated.
- Automatic reasoning-workspace capture, cross-session continuation, archival
  policy, and STG/LTG promotion: only after real interruption or compaction tasks
  show that the ordinary transcript and AG are insufficient. The explicit Lab
  tool, same-session atomic persistence, process-restart resume, and one-shot
  post-compaction checkpoint injection are implemented.
- Memory-Graph Reasoner edge-following and automatic inference: only after that
  reasoning-workspace need is established; global scoring is a retained Lab
  prototype, not a Lite dependency.
- A SkillOpt `memory_maintenance_policy` and three-way content/scope/retrieval
  defect attribution: only after the recall-policy readiness and promotion gate
  is completed with natural labels.
- Full physical privacy erasure, learned-aggregate reset, adapter erasure hooks,
  and erasure receipts: before a privacy-erasure product claim, after threat
  model and user-consent review. Current delete/forget is logical withdrawal.
- GPU/WGSL execution for the tiny autodiff substrate: only after profiling finds
  a workload that violates the CPU/WASM budget. Backend-selection estimates are
  experimental and must not imply an executable GPU backend.

## Completion rule

Delete this file when every active item above is completed or explicitly closed.
