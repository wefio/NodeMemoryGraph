# NMG active TODO list

**Purpose:** track only unresolved work. Completed implementation history belongs
in Git; durable behavior and decisions belong in the design, Skill, or operating
documents. Remove an item here as soon as it is implemented or deliberately
closed.

## 1. Collect trustworthy real-use supervision

- [ ] Accumulate materially independent Pi+NMG tasks with retrieval, exact
  `get`, expansion depth, actual evidence use, outcome/correction, injected
  tokens, tool rounds, and end-to-end latency.
- [ ] Label evidence sufficiency, expansion usefulness, excessive noise, and
  no-memory-needed separately. Silence or an uncorrected answer remains
  `unknown`, not success.

The capture and session-ownership plumbing is implemented. Controlled examples
may validate plumbing but must not be counted as natural product evidence. This
is enforced by `collectionOrigin`: ordinary Pi writes `natural`, the headless
probe writes `controlled`, and legacy events without the field are excluded.
As of 2026-08-13 the authoritative shadow report contains 23 fully labelled
natural graphs. Session-local latest-graph feedback removed fragile UUID
copying, and online Pi blackboard audits now contribute ordinary multi-Agent
supervision without launching controlled headless probes. The report contains
634 events across 224 retrieval graphs and 25 semantic tasks. Before the latest
negative-task batch, useful labels were strongly positive-skewed: only 3
evidence-insufficient examples, 5 expansion-not-useful examples, 2
excessive-noise positives, and 2 no-memory-needed positives; there are still
no failed-task or user-correction-positive outcomes. Four independent negative
tasks added four no-memory decisions, four insufficient-evidence decisions,
four useless-expansion decisions, and two excessive-noise observations. The
report and both dataset exporters now aggregate non-null labels across
incremental feedback calls for the same graph; mixed controlled/natural
provenance fails closed to controlled. This recovered valid existing feedback
without inventing labels. This is real progress, not enough for calibration or
promotion. The next natural
tasks should preferentially
cover irrelevant-memory, noisy-expansion, ambiguous-evidence, and correction
scenarios instead of repeating successful recall audits.

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
2026-08-13 authoritative report has 23 fully labelled natural graphs and still
fails closed. This is enough to justify continuing collection, not enough to
implement or promote rolling threshold calibration; use at least 50 balanced
positive/negative examples with a held-out time segment before moving the
threshold. The rolling worker and rollbackable shadow artifact now exist
(`npm run eval:qpp-tau`); the unresolved item is trustworthy data plus matched
promotion evidence, not worker plumbing.

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
transform on the proposal, and limits each maintenance pass. Do not enable it by
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

## 4. Run the SkillOpt promotion gate

- [ ] Reach the default readiness floor of 24 materially independent labelled
  retrieval tasks: 12 train, 6 chronological validation, and 6 untouched test,
  with sufficient action and noise-label diversity. The current exporter reports
  23 tasks split as 15 train, 4 validation, and 4 test; the gate remains closed.
- [ ] Run SkillOpt, then a matched Pi+NMG promotion experiment covering answer
  quality, official evidence recall, pollution, tokens, tool calls, and latency.
  Adopt a winner only through reviewed edits to `src/prompts/nmg-prompts.yaml`.

The offline adapter, de-identified exporter, fail-closed readiness gate, and
isolated candidate-policy hook are implemented. `--allow-insufficient` is only
an adapter smoke test and never authorizes training or promotion.

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
