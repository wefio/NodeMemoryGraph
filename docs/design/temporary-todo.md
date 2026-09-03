# NMG active TODO list

**Purpose:** unresolved work only.
**Authority:** working queue, not design specification or implementation history.
**Updated:** 2026-09-03

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
- [x] Add explicit branch ownership, bounded task-frame cooling/task return, and
  one runtime item/character budget across semantic/tool/reasoning items.
- [x] Represent semantic references, tool observations, and hypothetical
  reasoning artifacts as typed AG items with provenance and TTL.
- [ ] Replace query-derived frame IDs with a validated automatic semantic
  task-frame classifier, including false-switch behavior.
- [ ] Unify retrieval's multidimensional token/node/edge ledger with runtime
  observation/reasoning admission; the current runtime item/character cap is not
  yet the full design-wide budget `B`.
- [x] Replace Pi `SessionRuntimeAg` with thin tool/Task Board event ingestion to
  the daemon-owned AG; all daemon search consumers receive projection revisions.
- [x] Move Pi, DSH, WorkBuddy and MCP disclosure windows into one host-neutral,
  bounded AG ledger; clear it on compaction and release it with the session.
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

**Current blocker:** explicit task/branch state and disclosure ownership are
unified. Automatic semantic frame classification, the full multidimensional
budget `B`, typed activation/reasoning edges, and optional MGR artifact admission
remain incomplete. HA/MGR default actuation also lacks natural utility evidence.

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

## 6. Make embedding work by default on store and retrieve

User requirement: embedding must be present on the normal write and search
paths; local hashing is a fallback, not a substitute. Observed failure: the
embedding config lived only in a repo `.env` that the daemon never reads, so a
daemon restart silently dropped the API key and every subsequent search fell
back to lexical while the operator believed embedding was on
(`embedding_index_state.status = "failed"` after a single free-tier 429,
`last_succeeded_at = null` → search always lexical). The configured provider
did build 96 vectors on 2026-09-01 and then never ran again.

- [x] Trigger a bounded embedding drain on every remember/search (no
  writeThreshold/accessThreshold batching): each operation tops up one small
  batch of missing vectors in the background, so low-activity stores still
  converge and a 429 just queues the rest for the next operation.
  (`syncEmbeddingTarget` `maxBatches`, `#drainEmbeddings` fires on every
  `#signalMaintenance` from remember/search with `{ maxBatches: 1 }`.)
- [x] Treat provider rate-limit / transient failures as *pause, not fail*: a
  429/5xx must not set the whole index to `failed` (which permanently disables
  hybrid until a full rebuild); record `last_failed_at` + reason and resume on
  the next drain. Only persistent (non-rate-limit) failure degrades.
  (Search now serves hybrid from a *partial* index — `LEFT JOIN` keeps lexical
  results while indexed records get the vector lift — so a failed/429'd index
  is never a dead end; the drain retries on later operations. Provider
  failures additionally start a 30s cooldown so a down provider cannot hang
  every query; search reports `degraded: true` with the reason.)
- [x] Retrieve with a local-hashing degrade when no external vector exists —
  **evaluated and closed: not doing.** The current fallback degrades to plain
  lexical with `degraded: true` + reason, which is the intended end state. A
  local-hashing blend was measured and rejected: on the real store, 256-d
  `nmg-hashing-v1` blended retrieval is byte-identical to pure lexical
  (self-recall 45/154 both arms; vector scores ≈ 0), matching the published
  dimensionality bottleneck for low-dimensional hashing vectors. The known
  fix — NUMEN-style very high dimensions (16K–32K) that beat BM25 — costs
  enormous fixed memory per vector, which is not acceptable for a local,
  SQLite-backed store. Feature-hashing/SimHash are word-level tools
  (spelling, near-dedup), not semantic retrieval. See the rejected decision
  record (2026-09-03-hashing-vector-retrieval-fallback).
- [x] Drop the `NMG_EMBED_AUTO_SYNC` gate: presence of a configured provider
  (+key) implies auto-sync. Keep the env as an explicit *disable* switch.
- [x] Persist embedding configuration at the deployment layer (User-level env /
  documented daemon launch) so a restart keeps provider + key; document this in
  the owning guide/ADR rather than inventing a new config-file mechanism.
  (User env set 2026-09-03; daemon restart keeps `provider: gemini` +
  `indexId` ready.)

**Available mechanism:** write and access paths already `signalMaintenance`
(`src/cli/service.ts` #remember/#search); `#drainEmbeddings` already runs
records→leaves→nodes incrementally from the SQLite missing-vector queue
(`embeddingDocuments` with a limit, batch 64); every record already carries
local hashing vectors (`memory_embeddings` model `nmg-hashing-v1`, 327 rows);
`searchMemoryContext` already has a lexical fallback seam and a
`degraded/reason` return shape; `embedding_index_state` already tracks
running/ready/failed with `last_error`.

**Current blocker:** the drain is gated behind the maintenance threshold
(16 writes / 32 accesses) so low-activity use never converges; one 429 marks
the index `failed` and there is no pause-and-resume; and without the env the
configured provider silently disappears on daemon restart (operator's real
incident). Industry practice confirms the direction: async post-write
embedding with background queue and automatic semantic-search upgrade
(mcp-memory-ts), and a provider lifecycle that degrades only on *persistent*
failure with an unavailable-reason + fallback path (openclaw #94240/#101272).

**Done when:** with a configured provider, a fresh `remember` produces a
searchable vector within one operation cycle and a later `search` reports
hybrid; a simulated 429 pauses the drain without `status = failed` and the next
operation resumes it; with no provider (or provider down), search degrades to
lexical with `degraded: true` and an explicit reason; and a daemon restart with
persisted config keeps embedding enabled (verified against the real store).

## 7. Feature hashing / SimHash as a lexical-layer complement (candidate)

Word-level uses of hashing were explicitly kept out of the rejected
semantic-retrieval decision
([2026-09-03-hashing-vector-retrieval-fallback](../decisions/rejected/2026-09-03-hashing-vector-retrieval-fallback.md));
this ticket scopes the candidate
([memory-system precedent](https://github.com/nikhilsitaram/claude-memory-system/issues/53)):

- [ ] Evaluate whether `statementSimilarity` (word-set Jaccard) misses
  near-duplicates whose spelling or word form differs ("embedding" vs
  "embeddings", typos), and whether a stored 64-bit SimHash fingerprint
  (Hamming ≤ 3) recalls candidates the Jaccard path cannot.
- [ ] Decide where it plugs in: supersede / near-dup candidate recall on the
  write path — NOT search ranking, NOT the rejected semantic-retrieval blend.
- [ ] If adopted, keep the store small and offline: one integer column per
  memory, in-memory index under ~KB per thousand entries, no external
  dependency.

**Available mechanism:** `statementSimilarity` (word-level Jaccard) exists and
NMG acts only on exact normalized equality; surface anchors already give
character-level (trigram) tolerance for explicit tokens. Supersede/dup
candidates currently come from token overlap, which is blind to word-form
variants.

**Current blocker:** no fingerprint index; the exact gap (word-form/spelling
variant recall) is asserted but not measured, and the write-path judge is not
the current dedup consumer.

**Done when:** a measurement shows the Jaccard path misses word-form variant
duplicates that a SimHash pre-filter recalls (or shows the gap is already
covered), with a decision recorded either way — no speculative index until the
recall gap is real.

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
