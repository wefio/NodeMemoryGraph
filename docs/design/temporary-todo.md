# NMG active TODO list

**Purpose:** unresolved work only.
**Authority:** working queue, not design specification or implementation history.
**Updated:** 2026-08-24

Durable behavior belongs in the owning design or operating document; current
implementation evidence belongs in
[completion-audit.md](completion-audit.md); completed history belongs in Git.
Use [`doc-maintenance`](../../skills/doc-maintenance/SKILL.md) when moving a
result to its durable owner. Remove an item as soon as it is implemented or
deliberately closed.

## 1. Collect trustworthy verified-evidence supervision

- [ ] Accumulate materially independent Pi+NMG tasks with retrieval, exact
  `get` disclosure, expansion depth, user/tool-verified evidence,
  outcome/correction, injected tokens, tool rounds, and end-to-end latency.
- [ ] Label evidence sufficiency, expansion usefulness, excessive noise, and
  no-memory-needed separately. Silence or an uncorrected answer remains
  `unknown`, not success.

**Available mechanism:** session ownership, provenance, chronological task
splits, disclosure capture, claim outcomes, compact readiness reports, and the
natural-evidence Skill workflow are implemented. Controlled examples validate
the plumbing but cannot count as natural evidence.

**Current blocker:** the collected natural graphs do not contain enough
independently verified claim attribution to train evidence ranking or budgets.
Collection should prioritize explicit user confirmation, successful
tool-verifiable outcomes, corrections, and failures. Answer overlap, task
completion, silence, or lack of correction must not be relabelled as evidence.

**Done when:** a time-separated natural dataset contains enough attributable
positive, negative, partial, and no-memory outcomes to support the matched gates
below without relying on controlled or API-only diagnostics.

## 2. Calibrate retrieval and the differentiable controller

- [ ] Compare the frozen heuristic with a frozen shadow candidate on semantic
  task and time splits; persist feature version, data window, effective
  configuration, metrics, candidate identity, and rollback target.
- [ ] Add distinct next-tier and search-recommendation labels only when natural
  traces reliably distinguish them from generic expansion.
- [ ] Optimize evidence/answer sufficiency together with explicit token,
  tool-call, depth, and latency costs. Keep hard safety and budget limits outside
  the differentiable graph.
- [ ] Promote only low-risk decisions after a matched natural evaluation. Do not
  add contextual-bandit or long-horizon-RL machinery without logged propensities
  or a demonstrated sequential credit-assignment problem.

**Available mechanism:** QPP1, QPP2, search recommendation, a framework-free
autodiff controller, frozen candidates, typed actuation telemetry, chronological
calibration, rollbackable shadow artifacts, official benchmark scoring, and
fail-closed quality/cost gates exist.

**Current blocker:** the development comparison improved answer and evidence
metrics but increased token and latency cost, failed an independent LoCoMo gate,
and is neither natural product evidence nor statistically conclusive. Current
constants remain cold-start priors rather than calibrated probabilities.

**Done when:** a sufficiently sized, evidence-diverse matched natural evaluation
shows useful causal actions and passes answer/evidence quality plus token,
tool-round, depth, latency, and rollback gates.

## 3. Validate unattended memory maintenance

- [ ] Measure STG-to-LTG consolidation precision and reversibility on natural
  outcomes before enabling unattended promotion by default.
- [ ] Evaluate automatic node-merge proposals on natural data, including false
  merges, scope conflicts, aliases, temporal identity, source-actor identity,
  `distinct_from`/`contradicts` evidence, and rollback.

**Available mechanism:** deterministic consolidation and identity gates,
provenance-aware claim outcomes, reversible transforms, read-only maintenance
audits, backlog accounting, and a default-off automatic merge actuator exist.

**Current blocker:** ordinary stores contain too few natural attributable claim
outcomes and identity decisions. Existing controlled fixtures prove plumbing and
audit parity, not natural precision or false-merge safety.

**Done when:** natural examples cover accepted and rejected consolidation,
reversal, true identity, false identity, scope conflicts, same-name entities, and
rollback with acceptable precision and recovery cost.

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
- Automatic reasoning-workspace capture, cross-session continuation, event
  archival, and STG/LTG promotion: only after real interruption or compaction
  tasks show that the transcript, private AG, and explicit Lab workspace are
  insufficient.
- Memory-Graph Reasoner automatic inference: explicit edge-following is now
  implemented, but automatic inference waits for a demonstrated reasoning need;
  MGR remains a read-only opt-in Lab capability rather than a Lite dependency.
- Automatic SkillOpt optimization and extraction for `memory_maintenance_policy`:
  the hash-bound proposal store, three-way content/scope/retrieval attribution,
  long-horizon gate and explicit review channel are implemented. Learning and
  automatic proposal generation wait for enough natural labels; review never
  actuates a mutation.
- Full physical privacy erasure, learned-aggregate reset, adapter erasure hooks,
  and erasure receipts: before any privacy-erasure product claim, after threat
  model and user-consent review. Current delete/forget is logical withdrawal.
- GPU/WGSL execution for the tiny autodiff substrate: only after profiling finds
  a workload that violates the CPU/WASM budget.

## Completion rule

Delete this file when every active item above is completed or explicitly closed.
