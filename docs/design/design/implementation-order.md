# Revised implementation order

**Authority:** [Parent scope](../design.md).

"Complete" labels mark the scope stated in each item, not overall product
completeness or demonstrated utility. A qualifier such as "at adapter level" or
"as a controlled mechanism ablation" defines that item's boundary; explicitly
open evidence or activation work remains open.

## Revised implementation order

### P0: make the memory plugin small and real

1. Add a Pi package manifest and stable installable extension entry.
2. Reduce the default model-facing API to search, get, and remember.
3. Keep SQLite surface-anchor retrieval plus word-level FTS as the
   zero-configuration/degraded path.
4. **Complete at benchmark and Pi boundaries:** wire optional fine-grained
   record embeddings behind the same SQLite store, synchronize only missing
   records at add/turn boundaries, and retain surface anchors plus FTS as the
   zero-configuration and not-yet-ready fallback. Node/leaf-only and the
   current union ranker are explicitly gated off after the LoCoMo ablation.
5. **Complete:** expose the application boundary through an
   agent-independent `nmg` CLI and cross-platform JSON-RPC-over-HTTP daemon. This
   plan's `nmg.v7` label is historical; the current protocol version is `nmg.v9`. The Pi extension uses the same daemon through a
   persistent HTTP client and ownership-aware lifecycle.

### P1: incremental correctness and fair evaluation

1. **Complete:** Inbox/Delta retrieval and dirty-node local rebuild scheduling.
2. **Complete:** stable leaf identities, Float32 binary vector storage, and a
   disposable contiguous appendable in-memory cache.
3. **Complete at causal runner level:** the strict LongMemEval matched gate
   compares no-memory, deterministic NMG, and NMG with one explicit frozen
   trained controller using identical prompts and independent copies of one seed
   corpus. Runtime actions, candidate hash/configuration, and contamination are
   audited. Larger repeated capability runs remain ongoing benchmark work.
4. **Complete:** deterministic temporal, aggregation, conflict, multi-hop,
   exact-detail, privacy, and memory-pollution cases.
5. **Complete at adapter level:** LongMemEval, PersonaMem, LoCoMo, and BEAM have
   official-format loaders, stratified validation, shared matched experiment
   arms, ignored local data/results, and fixture coverage. Larger repeated
   capability runs remain benchmark work rather than implementation work.

### P2: adaptive semantic graph experiments

1. **Complete:** record ambiguity, fallback, contradiction, usefulness, and
   co-retrieval signals.
2. **Complete:** propose delayed links and scoped refinements with evidence,
   thresholds, cooldown hysteresis, and explicit review.
3. **Complete as a controlled mechanism ablation:** compare adaptive topology
   with fixed nodes and flat retrieval over 30 deterministic cases.
4. **Complete as a controlled label test:** the framework-independent online
   router is updated only from explicit useful-node labels.

### P3: runtime memory model and consolidation

1. **Complete:** add explicit STG/LTG lifecycle state, provenance-preserving promotion,
   expiry, and demotion; keep immediate atomic LTG promotion for governed facts,
   preferences, constraints, and replaceable states.
2. **Superseded target, reusable mechanism complete:** the current query-scoped
   `ActiveGraph` provides selected nodes, relations, local evidence, temporary
   cross-graph edges, and a unified budget ledger. Reuse these mechanics while
   replacing its trace-shaped identity with a mutable session AG plus immutable
   `ProjectionRevision`.
3. **Open breaking runtime work:** implement session/branch ownership, bounded
   task frames, tool-observation ingestion, disclosure ledger, typed
   semantic/activation/reasoning layers, deterministic cleanup, and the
   `agId`/`taskFrameId`/`projectionId`/`boardChannelId` identity split.
4. **Open integration work:** bind HA fast state to session AG and let explicitly
   enabled MGR consume only bounded selected subgraphs. Keep both optional and
   subordinate to deterministic hard budgets and governed persistence.
5. **Complete with conservative attribution:** record scored node and edge
   activation from retrieval traces and agent-directed exact-memory use, with
   durable selection reasons, expansion paths, and budget accounting; retrieval
   frequency alone does not establish usefulness.
6. **Complete:** estimate edge stability from independent tasks, evidence coverage, verified
   usefulness, contradiction, and time decay while preventing self-reinforcing
   retrieval loops.
7. **Complete for pairwise local subgraphs:** add auditable, reversible
   local-subgraph consolidation into LTG with minimum
   evidence, hysteresis, cooldown, and explicit evaluation gates. Pi runs this
   conservative maintenance policy automatically after completed turns.
8. **Autodiff and bounded actuation complete as Lite infrastructure; promotion separately gated:**
   implement a tinygrad-inspired UOp engine and a serializable multi-head
   controller for node, edge, STOP/EXPAND, and budget decisions. The numerical
   substrate ships with Lite; trained rerank/allocation/fold actuation is wired
   behind explicit modes, while default activation remains gated on a fixed
   feature contract and matched evidence-recall/cost evaluation.
9. **Mechanism complete, utility evaluation open:** independently selectable QPP1
   allocation, QPP2 progressive folding, and search recommendation are wired
   through the Pi adapter. QPP2 preserves folded candidates in the current
   query-scoped projection; the target stores them in the projection revision.
   Calibration and matched answer-quality/cost evaluation are not complete;
   activation and composition remain user/operator policy.

### P4: selective reasoning workspace

1. **Complete as a Lab prototype:** typed session reasoning nodes and edges,
   atomic local persistence, bounded checkpoints, Pi compaction lifecycle
   integration, and a matched full/compacted development benchmark.
2. **Rejected after experiment:** automatic user-input capture and ordinary-turn
   checkpoint injection. It added latency and regressed compacted-task accuracy.
   Do not restore it without a new benchmark and a materially different design.
3. **Complete at the structural provenance boundary:** evidence nodes require
   stable references; supported conclusions/decisions require direct or
   transitively anchored support; cycles cannot manufacture evidence; reference
   removal cannot orphan a supported descendant; checkpoints mark unsupported
   hypotheses explicitly. External source truth remains a harness/tool concern.
4. **Complete for the bounded Lab lifecycle:** exact add retries are idempotent,
   explicit `clear` resets only the owning session, process restart resumes that
   session, and a 30-day idle TTL removes abandoned scratch files. Per-node stale
   retirement is expressed through explicit status and checkpoint priority.
   Task-completion archival, cross-session resume, and promotion are deliberately
   absent rather than implicit defaults.
5. Keep measuring the explicit workspace on tasks with real interruption or
   compaction risk; do not treat synthetic success as justification for default
   activation.
6. Only then define reviewed STG/LTG promotion of supported conclusions and
   decisions.

### P5: optional platform capabilities

1. Measure retention transitions from indexed cold storage through implemented
   L4 Dormant/Unindexed and L5 Quarantine states before considering automatic
   physical purge. The CLI exposes dry-run candidates and explicit
   archive/quarantine/restore operations through the resident service.
2. The CLI exposes semantic-memory deletion with dependent index cleanup while
   retaining immutable source history. Full privacy erasure/export, including
   raw history and learned-signal erasure, remains separate work.
3. Add optional encrypted cloud synchronization only after the local protocol
   and multi-device conflict semantics are specified.

### Immediate validation order

The next work should reduce uncertainty rather than add another subsystem:

1. Evaluate QPP1, QPP2, and search recommendation independently against the
   same fixed baseline. Report each module's score change, evidence recall,
   tool-call count, injected tokens, and end-to-end latency. Do not make
   exhaustive module combinations a project requirement.
2. Calibrate QPP1 against oracle evidence depth and QPP2 against evidence
   retention. Do not call a module useful merely because a larger pool raises
   raw recall.
3. Test whether the model follows one search recommendation when useful,
   ignores it when unnecessary, and stops after an unproductive search.
4. **Mechanism complete; evidence collection open:** claim-outcome posteriors,
   source lineage, semantic-task deduplication, conservative bounds, and
   reversible STG materialization exist. Accumulate independent natural
   verified-evidence outcomes before calibrating or enabling unattended
   consolidation.
5. **Complete:** harden the plugin boundary with an installable Pi package
   manifest, validated Pi session-entry schema, an explicit daemon concurrency
   contract, and user-facing delete/export.
6. Leave activation and module composition to explicit user/operator policy.
7. Keep ANN, unattended topology mutation, cloud sync, and automatic reasoning
   workspace activation deferred until their measured prerequisite appears.
