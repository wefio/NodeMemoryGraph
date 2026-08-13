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
As of 2026-08-13 the ordinary-Pi shadow log contains 6 fully labelled natural
graphs. Session-local latest-graph feedback removed fragile UUID copying, and
online Pi blackboard audits now contribute ordinary multi-Agent supervision
without launching controlled headless probes. This is real progress, not enough
for calibration or promotion.

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
current constants are cold-start priors, not calibrated probabilities.

## 3. Validate unattended memory maintenance

- [ ] Measure STG-to-LTG consolidation precision and reversibility on natural
  outcomes before enabling unattended promotion by default.
- [ ] Evaluate automatic node-merge proposals on natural data, including false
  merges, scope conflicts, aliases, rollback, and source-actor identity.

The deterministic gates, rollback mechanisms, and controlled tests exist.
Natural-data validation is the missing evidence, not another merge algorithm.
An ordinary online-Pi audit on 2026-08-13 also confirmed that automatic merge
actuation is not currently wired: `same_as` can accumulate into a pending
proposal and pass a read-only eligibility assessment, but acceptance and
`mergeNodes` remain explicit. The existing physical merge primitive must not be
connected automatically until scope, temporal-state, same-name identity, and
rollback outcomes are represented in that validation set.

## 4. Run the SkillOpt promotion gate

- [ ] Reach the default readiness floor of 24 materially independent labelled
  retrieval tasks: 12 train, 6 chronological validation, and 6 untouched test,
  with sufficient action and noise-label diversity.
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
- Reasoning-workspace activation, archival/resume, and STG/LTG promotion: only
  after real interruption or compaction tasks show that the ordinary transcript
  and AG are insufficient. The existing Lab prototype remains available.
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
