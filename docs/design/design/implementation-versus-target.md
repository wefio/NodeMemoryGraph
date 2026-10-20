# Current implementation versus target

**Authority:** [Parent scope](../design.md).

## Current implementation versus target

The session Active Graph decision deliberately treats the current query-scoped
graph and existing Pi runtime as migration inputs, not as the final architecture.
The following list records what exists today; it must not be read as evidence
that the mutable session AG, task frames, projection identity split, or HA/MGR
runtime loop has been implemented.

Implemented and verified in the current prototype:

- a normal Pi package manifest, stable extension entry, three durable-memory
  tools plus the Lab capability entry point and the unified `nmg_state` tool;
- progressive `nmg_search` headers followed by exact `nmg_get` evidence loading;
- a persistent Inbox/Delta path that survives restart, participates in hierarchy
  retrieval before compaction, and is acknowledged only after external leaf
  embeddings finish;
- dirty-node threshold scheduling and node-local leaf rebuilding with stable
  content-derived block IDs that preserve unchanged embedding cache entries;
- Float32 BLOB persistence with backward-compatible JSON migration and
  disposable contiguous vector caches that support geometric append/update;
- local SQLite selective history evidence, semantic memory, typed relations,
  evidence links, and source-message identities;
- state supersession, event time, actor/truth status, scope, merge/split, and
  redirects;
- static temporal/logical memory chains over reusable record IDs, with bounded
  post-retrieval expansion, live successor pointers, acyclic order edges,
  complete daemon/CLI administration, session-owned STG isolation, exact-get
  hydration, and shared agent-facing logical-DAG projection consumed by Pi,
  Claude MCP, and CLI search metadata without statement duplication;
- resident/automatic/cue execution layers;
- a Lab-only, file-backed session reasoning workspace with bounded compaction
  checkpoints and explicit hypothesis/evidence status;
- a task-scoped shared coordination board with attributed entries, TTL, cursor
  reads, explicit resolution, always-available CLI/RPC access, opt-in adapter
  access, a system-layer
  online-agent registry, capability discovery and stable-name directed delivery,
  and no LTG/FTS indexing;
- a bounded `searchContext` result that approximates an early Active Graph by
  combining resident, automatic, and agent-directed recall;
- explicit STG/LTG residence on memories and nodes, governed immediate atomic
  LTG writes, ID-preserving promotion/demotion, STG expiry, and append-only
  lifecycle audit events;
- a first-class query-scoped `ActiveGraph` returned by `searchContext`, with persistent and
  temporary edges plus a shared node/edge/evidence/token/hop/tier/latency budget
  and a per-dimension measured usage ledger;
- durable per-memory selection explanations, score components, estimated token
  cost, and relation expansion paths, all recoverable from one retrieval trace;
- Pi propagation of current Active Graph/trace IDs from `nmg_search` to `nmg_get`, so exact
  expansion acts as the current operational signal that a recalled memory was
  actually selected for use;
- query/task-deduplicated edge observations, separate selection/use/
  contradiction/rejection activation statistics, time-decayed edge stability,
  and protection against increasing stability from retrieval alone;
- auditable stability-driven relation consolidation and hysteretic demotion,
  with explicit relations protected from automatic demotion;
- automatic turn-end maintenance in the Pi harness: STG expiry, due-node batch
  rebalancing, and conservative stability-driven consolidation/demotion;
- accepted and rejected write-policy audit events, including durable write
  reason and source while deliberately excluding rejected statement/evidence
  content;
- FTS5, hashing evaluation vectors, model-neutral external embeddings with
  explicit query/document profiles, node/leaf indexing, and a
  rebuildable USearch experiment;
- L0-L3 local tiers, accumulated access statistics, and batch rebalancing;
- LTG-only L4 Dormant/Unindexed and L5 Quarantine lifecycle states, explicit
  restore, and conservative dry-run retention reports (without automatic
  physical purge);
- persisted ambiguity, fallback, contradiction, usefulness, and node-pair
  co-retrieval telemetry;
- delayed evidence-backed link/split proposals with observation thresholds,
  gain thresholds, cooldown hysteresis, persistent review state, and explicit
  accept/reject application;
- independently selectable QPP1 allocation, QPP2 progressive local folding,
  and model-facing search recommendations, with folded candidates preserved in
  the Active Graph rather than discarded;
- Pi RPC regression tests, initial LongMemEval development runs, and scale
  experiments.
- local quality automation for type checking, ESLint, Prettier verification,
  Node test execution, and C8 coverage, with a matching GitHub Actions workflow.

Important gaps between the prototype and the target plugin:

- the reasoning workspace is an implemented Opt-in Lab capability, not a Lite
  default, and has no learned automatic activation gate. This is an explicit
  product boundary: the tool is absent unless Lab mode is enabled, the model
  decides whether to write it, and NMG injects it only once after Pi compaction;
- reasoning nodes distinguish type, lifecycle status, and structural support.
  Evidence nodes require stable references; supported nodes require direct or
  transitively anchored support; unsupported hypotheses are marked in every
  checkpoint and cannot enter consolidation. Reference existence/truth is still
  the caller's responsibility rather than an independently verified claim;
- reasoning checkpoints are bounded, session-persistent, and resumable within
  the same Pi session, but scratchpad expiry, archive policy, cross-session task
  continuation, and explicit promotion into STG/LTG remain undesigned or manual;
- the workspace exposes consolidation candidates in core code, but Pi does not
  automatically review or promote them; this is intentional until provenance
  and false-promotion evaluation are stronger;
- `MemoryGraphReasoner` remains a numerical Lab prototype that scores the
  global unvisited candidate set rather than following graph edges;
- QPP1, QPP2, and search recommendation are independently wired at the Pi
  boundary. QPP1 `active` performs a non-persistent planning probe and applies a
  learned hard-bounded AG budget only after attributable controller training;
  QPP2 `active` enables Fibonacci expansion and may fold a learned low-mass tail
  without removing its IDs from the AG; an explicit caller limit disables that
  fold. Search recommendation remains a trailing, optional model nudge. Their
  utility and cost are not yet sufficiently characterised. QPP1 budget
  prediction correlated poorly
  with the oracle Fibonacci tier in the full LoCoMo audit; QPP2 scores are
  listwise rather than absolutely calibrated; and the cost/benefit of asking
  the model to search again has not been measured. Active behavior remains an
  explicit operator choice rather than a default selected by NMG;
- QPP2 folding is lossless at the store/Active-Graph layer but not necessarily
  lossless for the model: a needed candidate can remain folded unless the model
  explicitly unfolds the directory. A matched end-to-end test must measure
  answer quality, evidence use, extra tool calls, tokens, and latency. The
  activation gate now has typed inputs and fail-closed checks for those paired
  product measurements, but no current natural run supplies the two matched
  arms, so this is evaluation work rather than an authorization to activate;
- the [posterior confidence loop](core-data-model.md#confidence-as-a-posterior-the-outcome-feedback-loop)
  now has a shadow-mode storage and RPC path: immutable extraction confidence seeds a weak Beta prior,
  attributable supported/contradicted events are deduplicated by semantic task,
  and the store exposes posterior mean plus a conservative lower bound. It does
  not change extraction confidence or retrieval ranking. Automatic collection
  of trustworthy task outcomes and real-use calibration remain open;
- the ANN experiment has unacceptable recall on the near-duplicate workload;
- automatic extraction evaluation and the matched full-history sample are not
  yet large enough to make a product-quality claim;
- the four official benchmark adapters validate and use official-format parsing.
  One full matched BEAM 100K run now establishes a dataset-specific capability
  gain over empty retrieved context, but repeated runs and cross-suite evidence
  are still required for a general capability claim;
- the HaluMem operation-level adapter now measures extracted records,
  interference rejection, and update retrieval with the official judges. Its
  first natural slice exposed raw-message ingress pollution (0/1 interference
  rejection and 0.683 all-candidate weighted accuracy). On the same slice an
  Agent executing the current durable-write policy rejected the interference,
  produced 12 rather than 30 candidates, achieved 1.0 candidate accuracy and
  4/4 updates, but retained only 1/2 ordinary gold points. This supports keeping
  semantic admission in the harness while requiring recall audits. A second
  matched slice reduced 52 turns to 8 accurate candidates, retained 7/8
  ordinary gold points, and updated 1/1 target. Its benchmark interference
  aggregate also showed why gates must inspect attributable per-record outcomes:
  an official judge may accept a labelled interference inference even when the
  injected wording was never stored. A real STG posterior audit then admitted 17
  attributable candidates from sessions 5–6 and observed sessions 7–11, but
  found no later exact independent confirmation and therefore qualified zero. A
  second sessions 1–2 / observations 3–11 window also qualified zero. This shows
  both that HaluMem lacks product-like outcome labels and that some extracted
  records remain too compound; it does not authorize weakening the posterior
  gate or enabling unattended consolidation;
- accepted topology proposals are an offline/Lab maintenance operation, not an
  unattended production mutation policy;
- Pi/CLI logical withdrawal and a versioned user-memory export now exist;
  physical privacy erasure of every provenance copy and learned aggregate remains
  gated future work;
- automatic recall exposure is recorded as selection, and Pi performs a
  precision-favoured answer-to-evidence attribution at `agent_end`. Matching and
  empty overlap observations are diagnostic only: they neither train the shadow
  controller nor alter stability. Exact `get` records disclosure, not use.
  Stability and evidence-ranking supervision require explicit user outcomes,
  tool validation, or official benchmark evidence;
- stability currently consolidates a pairwise local subgraph as a typed
  `related_to` relation. Larger multi-edge motif consolidation remains an
  experiment rather than a P3 requirement.
- optional encrypted synchronization and multi-device conflict handling are
  design-only; Cloudflare is not a runtime dependency.
