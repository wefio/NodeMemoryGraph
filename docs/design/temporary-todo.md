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

As of the latest 2026-08-24 read-only audit, the bounded shadow log contains
1,111 events, 345 retrieval graphs, and still only 52 fully labelled natural
graphs. It contains one disclosure, one `verified_claim_support`, eight
diagnostic attributions, and 342 outcomes. The joined controller dataset has 52
rows across 36 independent tasks (44/8 rows and 28/8 tasks in chronological
train/validation splits), but all 52 rows lack verified claim attribution. They
can supervise control labels only, not evidence ranking or budgets. The dataset
and calibration CLIs now support `--compact`, so this blocker can be audited
without printing every replay row.

A controlled ordinary-Pi smoke produced the first disclosure, one verified
attribution, and an outcome with measured tool rounds, tokens, and latency; it
is excluded from natural labels.
The source and installed Skill now require
`nmg.v6` and fail closed instead of silently dropping attribution or claim-origin
RPC. The shared daemon was explicitly restarted on 2026-08-20 and is now a
compatible v6 process, so subsequent ordinary Pi sessions can exercise the new
event path. Existing labels meet the provisional sample-count target but do not
supply verified useful-evidence targets in either split. New
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

Ordinary Pi now also emits a one-shot next-user-turn reminder for a completed
Active Graph that disclosed memory but has no attributable claim outcome. The
reminder is advisory and repeats the same fail-closed boundary: only an exact
current user excerpt or a successful tool result may support or contradict a
specific disclosed memory. Failed tool results are excluded from Pi evidence
projection, and answer overlap, task completion, silence, or lack of correction
remain non-evidence. Reminder display is separately counted in the shadow report.
This closes the discoverability and successful-tool plumbing gap; it does not
manufacture a natural label or complete the collection item above.

Automatic recall now applies the existing `retrieve|cue|none` load gate. Pi also
enforces a per-turn construction-process budget (three searches, five total
search/get calls, exact-evidence progression, and no-gain stopping), preventing
repeated tool expansion from bypassing the final AG projection budget.

The NMG Skill now carries the natural-evidence loop so ordinary Agents can
collect the missing data during real work and act when it matures. It documents
passive shadow capture, exact search→get attribution, partial/unknown label
semantics, claim evidence, compact readiness audits, candidate calibration,
matched quality/cost gates, rollback, and the stricter consolidation/identity
merge boundary. Two Skill eval cases cover natural tool-verified outcomes and
fail-closed calibration. `skill:nmg:sync` atomically installs the complete Skill
and `skill:nmg:check` detects source/install drift; the current user-level copy is
in sync. This automates collection and future Agent action but does not convert
the current sparse observations into natural validation.

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
(`npm run eval:qpp-tau`). The matched runners now require an explicit frozen
candidate through `NMG_CONTROLLER_CANDIDATE_STATE`, validate its feature protocol
and non-zero training steps, hash it into the report, and copy it into only the
candidate arm. The unresolved requirement is evidence-diverse natural data plus
a sufficiently sized matched held-out result, not worker plumbing or another
fixed sample-count threshold.

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

The former observational smoke correctly emitted no gate metrics because its
shadow arm only logged. The causal protocol now keeps QPP mechanics, corpus,
prompt, model, and thinking fixed while the candidate alone receives a frozen
trained controller. Runtime `allocate|fold|rerank` actuation is written as typed
telemetry; every scored row carries its actuation summary; the aggregator rejects
a contaminated baseline and refuses to trust a report-authored boolean.

A one-question 2026-08-20 causal LongMemEval smoke (`6a1eabeb`) exercised a
25-step candidate. It recorded two candidate actions with one real change and no
baseline action. Both NMG arms answered correctly and retained identical official
retrieval (recall 0.5, NDCG 0.613), while candidate disclosed 981 rather than
3,368 characters. Official scoring therefore emitted the first causal typed
product metrics. This proves the execution and scoring path, not candidate
quality: the remaining work is a sufficiently sized, evidence-diverse matched
held-out run plus natural product observations.

The fixed 14-question `development-v1` causal run now supplies the first
gate-sized, evidence-diverse held-out engineering comparison. The 25-step
candidate changed ranking in all 14 cases and improved official answer accuracy
from 9/14 to 12/14, official evidence sufficiency from 9/14 to 11/14, mean
session recall from 0.762 to 0.905, and NDCG from 0.769 to 0.858. It also raised
mean tokens from 17,850 to 24,068, end-to-end latency from 9.00 s to 11.26 s,
and tool rounds from 2.07 to 2.36. The controller-quality gate passed, but token
and latency bounds failed; the independent small LoCoMo retrieval gate also
failed. Eligibility therefore remains shadow-only. The 14-pair answer gain is
not statistically conclusive (exact two-sided McNemar p=0.25), and this local
development manifest is neither natural product evidence nor a leaderboard
split. The unresolved requirement is matched natural observations with explicit
evidence outcomes and acceptable costs, not another execution-path smoke.

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

The read-only natural-maintenance audit now applies the same source-actor gate as
the production automatic-merge assessment: evidence must be user/tool authored,
and both candidate nodes must share at least one source-actor class. A regression
compares audit eligibility, reasons, and target identity against the production
assessment for an eligible pair, a user/tool mismatch, and Assistant-authored
evidence. This closes an audit-parity bug but does not supply the natural
false-merge evidence required for default enablement.

The same audit now distinguishes active and logically retracted STG→LTG
materializations by reading the durable `consolidated_from_stg` marker on every
LTG status, reports each source/target association, and flags duplicate active
targets for one STG source. The regression covers idempotent materialization,
idempotent retraction, retained deleted history, and exclusion of a same-text
manual LTG row without the marker. This makes reversibility observable when
natural examples arrive; the controlled fixture is not itself precision
evidence.

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
2026-08-24 live audit found 296 LTG memories (253 active), one active project STG
memory, four LTG claim outcomes in three semantic tasks with two posteriors, zero
STG→LTG materializations, one pending `refines` proposal, zero identity
proposals/transforms/rollbacks, 14 uncompacted index deltas, and 23 pending
accesses. Claim outcomes now retain
`natural|controlled|legacy` provenance: the current four events are one controlled
smoke and three migrated legacy events, so the natural count remains zero. The
first ordinary v5 search/get/write sequence reduced the distributed write backlog
from 17 nodes to 14. Subsequent smoke writes raised it to 17 deltas across 16
nodes, and the next ordinary attributable v6 state write drained it again to 13
deltas across 13 nodes, with a per-node maximum of one. The current audit has 14
active nodes with writes, a maximum of one pending write per node, and no
distributed write or access pressure. This repeat validates bounded
sparse-backlog maintenance without claiming consolidation quality. The remaining
zeros are product-evidence gaps; the audit command and controlled tests do not
convert them into natural validation.

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
