# NMG temporary TODO list

**Created:** 2026-08-01  
**Purpose:** short-lived implementation checklist; delete or fold into the main design documents after the decisions are resolved.

This list distinguishes incomplete product paths from implemented Lab prototypes.
An unchecked item is not automatically a commitment.

## P0 — close correctness and isolation gaps

- [x] Bind every Active Graph and retrieval trace to the Pi `sessionId`.
- [ ] Add a non-forgeable `runtimeId` only when a harness exposes one; the
  current local daemon authentication and Pi session identity are the boundary.
- [x] Validate ownership when an Active Graph is expanded, read, or receives
  usefulness/outcome feedback.
- [x] Add cross-session rejection tests for AG lookup, expansion, and feedback.
- [x] Decide how the Pi session injection window learns that context was
  compacted. Prefer a stable Pi lifecycle event; otherwise document the
  conservative 12-turn expiry as the fallback.

Implemented through Pi's stable `session_before_compact` event. The daemon
also connects `nmg_search.activeGraphId` to explicit `nmg_get` use attribution;
automatic recall alone is not labelled useful.

## P1 — replace real placeholders

- [ ] Replace or explicitly freeze the placeholder
  `DEFAULT_QPP_THRESHOLD = 0.55` using held-out, production-like trace feedback.
- [ ] Calibrate QPP component weights or document the hand-set values as an
  intentionally untrained heuristic.
- [ ] Implement the rolling QPP calibration worker only if trace labels are
  sufficiently reliable; keep QPP optional until then.
- [x] ~~Decide whether the four `NmgStoreBase` mixin stubs~~ — resolved
  2026-08-03 by moving the three base helpers that caused the upward calls
  into their consuming clusters (`recordActiveGraphUseInner` → maintenance,
  `searchWithVector` → retrieval, `redirectRelations` → graph); the stubs are
  deleted and base no longer depends on cluster methods.

## P1 — finish the user-facing memory lifecycle

- [ ] Add a Pi/user interface for forgetting or deleting a selected memory.
- [ ] Add an export path for user-owned memories and their evidence/provenance.
- [ ] Define physical erasure of derived artifacts and learned aggregate
  signals after a privacy deletion request.
- [ ] Verify deletion across FTS, embeddings, leaf blocks, derived memories,
  caches, traces, and controller statistics.

## P2 — session capture and consolidation

- [ ] Add a versioned validator for the Pi session/branch shape before relying
  on automatic transcript capture.
- [ ] Automatically retain only useful source messages, not routine assistant
  prose, tool output, or logs.
- [ ] Decide whether session shutdown should create/update a bounded session
  archive; keep Pi as the primary transcript owner where possible.
- [ ] Complete the evidence-driven STG → LTG consolidation loop using repeated
  cross-task reuse and attributable outcomes, not retrieval frequency alone.
- [ ] Measure consolidation precision and reversibility before enabling
  unattended promotion.

## P2 — automatic topology maintenance

- [ ] Evaluate automatic node-merge proposals on natural data, including
  false-merge cost, scope conflicts, aliases, and rollback.
- [ ] Define a high-precision acceptance gate for automatic node merging.
- [ ] Keep uncertain merge/split proposals pending for explicit review.
- [ ] Measure whether graph adaptation beats NMG Lite before making unattended
  topology mutation a default feature.

## P2 — matched product evaluation

- [ ] Run matched comparisons with the same model, histories, prompts, and
  context budgets for: no memory, flat hybrid retrieval, NMG Lite, and NMG
  Graph.
- [ ] Report answer quality, official evidence recall, injected tokens, search
  latency, model/tool-call latency, and storage/indexing cost separately.
- [ ] Evaluate tiered disclosure and the session injection window for token
  savings and stale-context failures.
- [ ] Test multilingual automatic-recall gating and measure false positives and
  false negatives instead of expanding regexes without evidence.
- [ ] Keep ANN non-default until it demonstrates a useful recall/latency
  crossover at the intended scale.

## Decision required — implemented but not connected to Pi

**Update 2026-08-03:** the `lab/` boundary is now enacted. `ReasoningWorkspace`,
`MemoryGraphReasoner`, `ForkMerge`, the differentiable-controller stack
(`autodiff`, `differentiable-controller`, `controller-protocol/-runtime/-gate`,
`shadow-evaluation`), and `rank-fusion` live under `src/lab/` and are no longer
exported from `src/index.ts`; the public API now equals wired capability.
`hierarchical-activation.ts` remains in `src/core/` because the production
`Router` imports it — extracting the hierarchical routing out of `Router` is
the remaining step. Open decisions that stay:

- [ ] Decide whether `ReasoningWorkspace` should become Pi's optional
  session-scoped reasoning scratchpad.
- [ ] If adopted, expose the minimum lifecycle needed to survive compaction;
  do not inject checkpoints automatically unless they improve matched tasks.
- [ ] Extract the hierarchical-activation routing out of `src/core/router.ts`
  so `hierarchical-activation.ts` can join `src/lab/`.
- [ ] Do not imply that these prototypes affect normal NMG retrieval until a
  runtime integration and matched evaluation exist.

## Scale and concurrency — only when demanded by measurements

- [ ] Stress-test concurrent Agent sessions against the single daemon writer
  and synchronous SQLite handle.
- [ ] Measure database, cache, and incremental index behavior at 100K and 1M
  useful memories before changing storage engines.
- [ ] Revisit automatic STG working-set sync and cache invalidation only if
  measured latency or memory usage warrants it.

## Explicitly deferred — not current missing work

- [ ] Cloudflare synchronization and multi-device conflict resolution.
- [ ] Rust or Python rewrites of the TypeScript core/adapter.
- [ ] vLLM as a required runtime dependency.
- [ ] Strict Huffman-tree storage rather than the current block/tier policy.
- [ ] Automatic multi-edge motif consolidation.
- [ ] L5 physical purge without a reviewed privacy and recovery policy.

## Completion rule

When an item is completed, move the durable design or operating instructions
to the appropriate document and remove it here. Delete this file when no
unresolved implementation decisions remain.
