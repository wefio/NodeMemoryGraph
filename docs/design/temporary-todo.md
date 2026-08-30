# NMG active TODO list

**Purpose:** unresolved work only.
**Authority:** working queue, not design specification or implementation history.
**Updated:** 2026-08-30

Durable behavior belongs in the owning design or operating document; current
implementation evidence belongs in
[completion-audit.md](completion-audit.md); completed history belongs in Git.
Use [`doc-maintenance`](../../skills/doc-maintenance/SKILL.md) when moving a
result to its durable owner. Remove an item as soon as it is implemented or
deliberately closed.

## 1. Implement the session Active Graph runtime

- [x] Introduce a bounded memory-resident, session-owned AG registry with
  deterministic cleanup and immutable projection revisions.
- [x] Separate `agId`, `taskFrameId`, `projectionId`, retrieval `traceIds`, and
  `boardChannelId`; route disclosure, attribution and claim outcomes through the
  projection-to-trace registry.
- [ ] Add branch ownership, automatic semantic task-frame switching/cooling,
  task return, and one combined semantic/tool/reasoning budget.
- [ ] Represent semantic references, tool observations, activation edges, and
  hypothetical reasoning artifacts as typed AG layers with provenance and TTL.
- [x] Replace Pi `SessionRuntimeAg` with thin tool/Task Board event ingestion to
  the daemon-owned AG; all daemon search consumers receive projection revisions.
- [ ] Move the Pi injection window into a host-neutral AG disclosure ledger.
- [x] Isolate HA fast state by session and clear it on session release.
- [ ] Use HA for admission, cooling,
  task return, redundancy-aware retention, and budget proposals without
  changing semantic confidence.
- [x] Require explicitly enabled MGR to consume a session-owned bounded AG
  projection and label its result non-persistent/hypothetical.
- [ ] Materialize MGR derivations as provenance-carrying TTL AG artifacts and
  add the optional HA rescore loop; never auto-write them to STG/LTG.
- [ ] Add behavior tests for task continuation, A→B, A→B→A, shared constraints,
  false switches, compaction, projection replay, concurrent branches, budget
  exhaustion, and session cleanup.

**Available mechanism:** current query-scoped AG budgets and ledgers,
retrieval/disclosure traces, Pi runtime tool capture, HA, MGR, controller hard
gates, and session lifecycle hooks provide reusable implementation pieces.

**Current blocker:** the core owner and identities are unified, but task/branch
lifecycle, combined budget accounting, disclosure-ledger migration and runtime
reasoning artifacts are not yet complete.

**Done when:** every supported adapter receives model context through immutable
projection revisions frozen from one bounded session AG; no duplicate working
memory remains in Pi; task and branch isolation plus cleanup are proven; HA and
MGR can be enabled independently without bypassing provenance or hard budgets.

## 2. Collect trustworthy verified-evidence supervision

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

## 3. Calibrate retrieval and the differentiable controller

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

## 4. Validate unattended memory maintenance

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

## 5. Remove the per-client OmniMemEval bridge process

- [ ] Move the official-adapter transport to one runner-owned NMG daemon while
  keeping corpus mapping, judge metadata, forget semantics, and benchmark
  rendering in the adapter rather than adding benchmark RPCs to Core.
- [ ] Define and test benchmark namespace cleanup over the generic scope/store
  lifecycle before deleting the NDJSON bridge compatibility path.

**Available mechanism:** the daemon already exposes generic JSON-RPC over HTTP;
the Python `NmgClient` owns the official benchmark API; Core already supports
scope, session and actor isolation. The shared embedding cache now joins
concurrent same-process misses and persists vectors in SQLite.

**Current blocker:** `bridge.ts` still owns substantial benchmark-specific
ingestion, rendering, per-user store lifecycle, evaluation-chain and audit
behaviour. Replacing only its transport would duplicate those policies in
Python or leak benchmark operations into the product daemon.

**Done when:** a parity test shows identical add/search/delete behaviour through
one shared daemon, each benchmark worker closes without stopping that daemon,
and the bridge subprocess can be removed without changing official inputs,
outputs, scoring, or product RPC semantics.

## 6. Harden the RCP evidence boundary

- [ ] Validate receipt integrity when looking up a reusable result instead of trusting
  parsed `decision: verified` fields alone.
- [ ] Bind receipt reuse to the active route and verifier definition, not only the
  Contract digest, scoped observed revision, and operation key.
- [ ] Prove that verified workspace bytes match the recorded commit/forge head and
  fail closed when Git observation is unavailable.
- [ ] Add a read-only receipt list/scan surface before treating the local append-only
  store as an auditable history rather than an idempotency cache.
- [ ] Define an executable terminal predicate, attempt/time budgets, cancellation,
  and cycle detection before adding any iterative reconciler. The current CLI
  deliberately stops after one `reconcileOnce` attempt.

**Available mechanism:** deterministic RCP product tests cover one-shot planning,
apply, scope enforcement, named verification, retryable receipts, forge binding and
optional/no-NMG operation. These tests do not establish semantic refactor
equivalence or portable attestation.

**Done when:** stale or tampered receipts cannot be reused, verified bytes are bound
to the claimed commit and verifier identity, local receipt history is inspectable,
and any future iterative mode has explicit convergence and resource boundaries.

## Explicitly deferred — not missing current work

These options return to the active checklist only after their prerequisite is
observed:

- Cloud synchronization and multi-device conflict resolution: only when
  multi-device operation enters scope.
- Rust/Python rewrites: only after a measured TypeScript bottleneck or an
  unavoidable native dependency.
- vLLM as a runtime dependency: rejected for the local-first default.
- RCP continuous watcher/queue/catalog: only after a real continuous Contract
  demonstrates that run-to-completion operation is insufficient.
- Portable RCP receipt attestation: only when receipts must be independently
  verified across machines or organizations; local receipts remain sufficient for
  current operator audit and idempotency.
- Strict Huffman storage: only if tier/block access misses measured scale or
  latency targets.
- Automatic multi-edge motif consolidation: only after ordinary node and edge
  adaptation have trustworthy natural labels.
- L5 physical purge: only after privacy, recovery, and user-consent policy is
  reviewed and implemented.
- Full long-horizon reinforcement learning: only after a real sequential
  credit-assignment problem is demonstrated.
- Cross-session AG continuation, automatic reasoning-workspace capture, event
  archival, and implicit STG/LTG promotion remain deferred. The new AG is
  session-owned and memory-resident; only its immutable observation traces may
  persist.
- MGR default/automatic inference remains deferred. Wiring the opt-in engine to
  bounded AG input is implementation work, but enabling it automatically still
  requires demonstrated reasoning value.
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
- Runtime RPC registration and catalog hot reload: only after a trusted dynamic
  extension use case defines handler ownership, in-flight request behavior,
  capability withdrawal, and cache invalidation. The current process-lifetime
  catalog is frozen and additive discovery uses its deterministic fingerprint.

## Completion rule

Delete this file when every active item above is completed or explicitly closed.
