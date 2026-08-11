# NMG temporary TODO list

**Created:** 2026-08-01  
**Purpose:** short-lived implementation checklist; delete or fold into the main design documents after the decisions are resolved.

This list distinguishes incomplete product paths from implemented Lab prototypes.
An unchecked item is not automatically a commitment.

## Agreed implementation route — 2026-08-09

This is the current execution order. Later sections retain the wider backlog;
this section identifies the path that has actually been agreed.

### A. `remember` as the LLM semantic boundary

- [x] Keep the model-facing surface at `remember`, `search`, and `get`.
- [x] Make normal `remember` a one-call path: the LLM supplies a durable,
      self-contained statement plus type, actor, time, scope, and importance; NMG
      enforces admission, stable IDs, provenance, transactions, exact deduplication,
      state invariants, and incremental index maintenance.
- [x] Return a bounded set of ambiguous supersession candidates to the LLM
      instead of letting lexical/vector similarity mutate history automatically.
- [x] Allow the same `nmg_remember` tool to submit a second-phase
      `action=supersede` decision. NMG validates that both records exist in the same
      LTG or session-owned STG store and have identical scope before applying it.
- [x] Extend semantic maintenance beyond supersession without turning similarity
      into mutation. Exact/canonical node names attach deterministically;
      `remember action=relate` records evidence-backed pending
      same/related/refines/conflict/distinct proposals. Alias materialization and
      reversible identity merge remain behind the measured topology-maintenance
      gate below rather than being silently performed by `remember`.
- [x] Trigger an LLM semantic judge only for bounded ambiguous candidates;
      exact duplicates and stable `stateKey + scope` replacement remain
      deterministic, and ordinary new concepts incur no second model call.

### B. Cheap write maintenance, amortized structural maintenance

- [x] Keep synchronous `remember` work bounded to admission, exact/near
      duplicate detection, state replacement, evidence binding, and Delta/dirty
      index updates.
- [x] Accumulate per-node pending maintenance counters and mark a node due after
      a configurable amount of write/access change.
- [x] Run tier rebalance and due leaf compaction in bounded event-loop batches,
      with durable backlog recovery and a configurable per-batch node limit.
- [x] Add a separately budgeted semantic phase for STG expiry, relation
      consolidation/demotion, and pending topology-proposal generation. Proposal
      acceptance remains explicit; similarity or edge strength never authorizes
      an identity merge.
- [x] Record maintenance latency and rows touched so the threshold can be tuned
      from real use rather than benchmark assumptions.

### C. Claim posterior outcome loop

- [x] Preserve extraction confidence as an immutable prior and add auditable
      per-claim posterior state (`alpha`, `beta`, independent vote count).
- [x] Store outcome votes as provenance-bearing events keyed by claim and
      independent semantic task/source lineage. Repeated turns in one task must not
      multiply the vote.
- [x] Restrict the outcome API to attributable strong-signal classes: explicit user
      confirmation/correction, tool verification, official eval verdict, or an
      explicit task outcome tied to memories actually used. Retrieval, rendering,
      silence, and un-attributed failure are not votes. Automatic signal capture is
      still pending; callers must provide a semantic task ID and source lineage.
- [x] Start with a weak Beta prior derived from extraction confidence; expose
      posterior mean and a conservative lower bound without overwriting the prior.
- [x] Run posterior updates in shadow first. The current posterior is auditable
      through the private RPC and does not affect retrieval ranking. Only after minimum independent
      evidence and calibration may retrieval ranking consume the conservative
      posterior. Keep history immutable and archive weak memories instead of
      deleting them.
- [x] Add tests for task deduplication, contradictory votes, restart/migration,
      provenance, insufficient-evidence hysteresis, and absence of self-reinforcing
      retrieval feedback.

### D. QPP calibration from real Agent use

- [x] Document the calibration procedure in the NMG Skill rather than freezing
      benchmark-optimal parameters as product truth.
- [ ] Collect real-use traces for search trigger, exact `get`, expansion depth,
      actual memory use, correction/outcome, injected tokens, tool rounds, and
      end-to-end latency.
      The optional Pi controller shadow now records retrieval origin, AG usage,
      exact-get use, input/output tokens, tool-result count, and end-to-end
      latency. It also records the exact injected character count (plus a clearly
      estimated token count). `nmg_remember action=feedback` accepts explicit
      task success, correction, evidence-sufficiency, expansion-usefulness,
      excessive-noise, and no-memory-needed labels for the owning Active Graph.
      Natural traces and explicit labels still need to accumulate; silence is
      never converted into a positive outcome.
      The agent-independent CLI now accepts
      `nmg get --active-graph-id <ID_FROM_SEARCH>` and the NMG Skill requires
      forwarding it. A live daemon smoke verified that exact get updates the
      owning trace's `useful_memory_ids_json`; CLI users no longer lose
      actual-use attribution merely because they are not running the Pi adapter.
      The bounded Pi smokes are recorded in `real-use-shadow-2026-08-09.md`:
      the first captured nine retrievals and exposed a repeated-search/stop
      failure because the requested policy was absent; after that verified
      policy was remembered, the follow-up used one automatic recall and
      produced one explicit successful/sufficient label. This is useful wiring
      evidence, not enough calibration data. A later live-code-review smoke also
      validated the per-user-turn `search -> get/current source` progression
      guard: Pi's repeated internal Agent loops no longer reset its allowance,
      and helper-owned daemons are closed after success, abort, or timeout.
      Current controlled Pi coverage is 48 retrievals, 11 exact uses, 48
      outcome-cost records, four feedback events, three fully labelled graphs,
      and three query-derived task IDs spanning only two actual topics. The first
      multi-turn probe exposed and fixed two collection bugs:
      internal Pi tool loops could consume a reminder inside the same user turn,
      and the newest graph could be a header-only automatic recall rather than
      the explicitly used graph. Reminders now appear only on the next distinct
      user turn and only for a graph with exact-use attribution. This closes the
      collection-loop engineering gap without manufacturing labels. Reminder
      display is now separately logged as `feedback_nudge_shown`, so a skipped
      review can be distinguished from a missing reminder without becoming a
      label. Broader natural use still has to accumulate before policy
      calibration is credible; query hashes do not prove semantic diversity.
- [ ] Label evidence sufficiency, expansion usefulness, excessive noise, and
      no-memory-needed separately on real-use traces. The separate fields and
      session ownership validation are implemented; an uncorrected answer is
      unknown, not success. Actual-use attribution is agent-neutral through
      `get(activeGraphId=...)`; richer outcome labels intentionally remain
      harness-adapter telemetry because Core cannot observe answer/correction
      lifecycle and must not depend on `src/lab/`.
- [x] Keep QPP1, QPP2, and search recommendation independently switchable.
      They use `NMG_QPP1_MODE`, `NMG_QPP2_MODE`, and
      `NMG_SEARCH_RECOMMENDATION` respectively.
- [ ] Calibrate on semantic-task/time splits, compare a candidate policy in
      shadow mode, and persist its feature version, data window, effective config,
      metrics, and rollback target. `npm run eval:controller-dataset` now joins
      graph-scoped retrieval/use/outcome/feedback events and assigns whole
      semantic tasks to chronological train/validation splits. New events persist replayable versioned
      controller features and their AG budget envelope; legacy rows missing
      either are excluded explicitly. `npm run eval:controller-calibrate` now
      trains/evaluates a fresh candidate and writes the requested version,
      window, config, metrics, source fingerprint, and rollback fingerprint,
      while refusing to run when real-use blockers remain. The first two complete
      controlled tasks now exercise a two-task train / one-task validation split and
      produce a non-active candidate artifact. Baseline and learned validation
      precision/recall were both 0.333/1.0, control accuracy was 1.0 on the
      single validation row, and the controller gate rejected activation for
      insufficient training cases. The gate now also derives a conservative
      primary exact-use evidence target per row, requires at least eight distinct
      primary training targets, and checks train/validation leakage against every
      exact record actually used, not only the primary record. The current
      artifact has two/one primary train/validation targets, seven/two complete
      exact-use targets, and one shared exact target, so
      `enoughEvidenceDiversity` and `evidenceTargetsHeldOut` both fail.
      This prevents paraphrased queries over one memory from masquerading as
      independent evidence. The item remains unchecked because this is protocol
      proof, not a credible calibration sample or matched policy improvement.

### E. Differentiable controller before reinforcement learning

- [x] Use the existing lightweight autodiff graph to train a bounded controller
      over QPP features, score shape, current tier, remaining token budget, and
      previous expansion state.
- [x] Begin with supervised shadow prediction for memory/node/edge usefulness,
      stop versus expand, and bounded budget allocation. The Pi bridge is
      opt-in through `NMG_CONTROLLER_SHADOW=1`, lazy-loaded, and observes exact
      `nmg_get` use without changing retrieval.
- [ ] Add separately labelled next-tier and search-recommendation actions only
      after real traces distinguish them reliably from generic expansion.
- [ ] Optimize answer/evidence sufficiency together with explicit token,
      tool-call, depth, and latency costs. Hard safety and budget limits remain
      deterministic outside the differentiable graph.
- [ ] Promote only low-risk decisions after matched shadow evaluation. Use a
      contextual bandit with logged action propensity only when outcomes are
      available solely for the chosen action; do not introduce full long-horizon
      RL until a real sequential credit-assignment need is demonstrated.

### F. Session evidence retention and topology

- [x] Retain only the smallest exact source excerpt supporting an accepted
      memory, explicit retention request, durable decision/obligation,
      conflict/exception, or irreproducible result. Routine assistant prose, logs,
      and reproducible tool output remain owned by the harness.
      Pi now resolves LLM-selected evidence against the current branch and NMG
      validates actor, message identity, session ownership, and the 4 KiB bound.
- [x] Preserve tool output only when it verifies a durable fact, caused an
      adopted decision, records a reusable failure constraint, or may disappear.
      Tool results are never captured automatically as durable memory; durable
      retention requires an explicit `sourceActor=tool` evidence excerpt through
      `remember`.
- [x] Keep ordinary tool outcomes in a bounded session-local runtime AG rather
      than persisting them. Pi retains the original result until compaction;
      after compaction the 32-record/8,000-character FIFO is projected through
      `<nmg_runtime_ag>`, and session shutdown drops it. Durable promotion still
      requires an explicit semantic `remember` decision.
- [x] Keep node attachment, relation creation, and identity merge as distinct
      decisions. High edge stability does not imply node identity.
- [x] Let an LLM propose `same entity`, `related`, `refines`, `conflict`, or
      `distinct` during bounded `remember` ambiguity; let NMG validate scope/time,
      record a reversible proposal/transform, and leave uncertain cases pending.

### G. Explicitly outside the current route

- Cloud synchronization, sandbox infrastructure, Rust/Python rewrites, vLLM as
  a runtime requirement, strict Huffman storage, and full long-horizon RL are
  not current implementation work.
- Local `uv`/venv plus a free small embedding model remains sufficient. ANN and
  alternative storage engines stay measurement-driven rather than mandatory.

## P0 — close correctness and isolation gaps

- [x] Bind every Active Graph and retrieval trace to the Pi `sessionId`.
- External prerequisite: add a non-forgeable `runtimeId` only when a harness
  exposes one. Until then, local daemon authentication plus Pi session identity
  is the documented boundary; NMG must not invent a forgeable substitute.
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

- [x] Explicitly freeze `DEFAULT_QPP_THRESHOLD = 0.55` as an uncalibrated
      cold-start prior. It must not change until held-out, production-like trace
      feedback exists; benchmark-only tuning is not accepted as product evidence.
- [x] Calibrate QPP component weights or document the hand-set values as an
      intentionally untrained heuristic. Source comments and the Skill identify
      `Top1 + 0.5*NQC`, threshold `0.55`, and the hard floor as frozen cold-start
      priors rather than learned probabilities.
- [x] Keep the rolling QPP calibration worker unimplemented until trace labels
      are sufficiently reliable. QPP remains independently switchable; this is
      a gated decision, not a missing unconditional worker.
- [x] ~~Decide whether the four `NmgStoreBase` mixin stubs~~ — resolved
      2026-08-03 by moving the three base helpers that caused the upward calls
      into their consuming clusters (`recordActiveGraphUseInner` → maintenance,
      `searchWithVector` → retrieval, `redirectRelations` → graph); the stubs are
      deleted and base no longer depends on cluster methods.

## P1 — finish the user-facing memory lifecycle

- [x] Add a Pi/user interface for forgetting or deleting a selected memory.
      Pi keeps the stable three-tool surface via `nmg_remember action=forget`;
      the CLI exposes `nmg memory delete MEMORY_ID`. Both perform auditable
      logical withdrawal, not physical privacy erasure.
- [x] Add an export path for user-owned memories and their evidence/provenance.
      `nmg memory export --json` emits the versioned
      `nmg.memory-export.v1` bundle and defaults to user-authored memories;
      `--all-actors` and `--include-deleted` are explicit expansions.
- [x] Define physical erasure of derived artifacts and learned aggregate
      signals after a privacy deletion request. The propagation contract is in
      `design.md`; implementation remains deliberately deferred with L5 purge.
- [x] Verify logical withdrawal across FTS, embeddings, leaf blocks, derived
      memories, in-process caches, Active Graph traces, claim state, evidence
      links, and pending topology proposals. External controller/shadow logs are
      part of the future physical-erasure adapter hook, not the logical-delete
      claim.

## P2 — session capture and consolidation

- [x] Add a versioned validator for the Pi session/branch shape before relying
      on source-message projection. The adapter uses `pi.branch.v1` and fails
      closed to self-contained evidence when a message entry is incompatible.
- [x] Retain only useful source excerpts, not routine assistant prose, tool
      output, or logs. Current admission is driven by explicit accepted
      `remember.evidence`; there is deliberately no bulk transcript capture.
- [x] Decide whether session shutdown should create/update a bounded session
      archive. It does not: Pi remains the primary transcript owner; NMG keeps
      only governed exact excerpts and semantic memories.
- [x] Complete the evidence-driven STG → LTG consolidation loop using repeated
      cross-task reuse and attributable outcomes, not retrieval frequency alone.
      Claim posteriors now expose qualified STG candidates; the service can copy
      their exact evidence into shared LTG through an idempotent cross-store path.
      Unattended actuation remains off by default (`NMG_STG_AUTO_CONSOLIDATE=1`)
      until the precision item below is satisfied.
- [ ] Measure consolidation precision and reversibility before enabling
      unattended promotion. Reversibility and positive-label coverage are now
      measured in `consolidation-evaluation-2026-08-09.md`: the zero-annotation
      prior needs five official positive tasks, 75/1,434 LoCoMo evidence items
      qualify, and retention hysteresis requires 2–4 later contradictions to
      retract them. The runtime now withdraws only source-marked automatic LTG
      copies and preserves manual duplicates. This remains unchecked because
      LoCoMo has no authoritative false-promotion labels, so actual precision
      and false-consolidation cost are still unknown. LongMemEval knowledge
      updates expose a separate cross-store consistency issue: a newer STG state
      must not coexist with an older consolidated LTG state while posterior
      retraction waits for repeated contradictions. Runtime projection now keeps
      only the newest same-scope `stateKey` (and preserves old versions for
      historical queries), but this does not manufacture the missing precision
      labels. The separate HaluMem operation adapter and official-judge wrapper
      are now complete. Its first natural slice found full expected-memory
      recall but 0.683 all-candidate weighted accuracy, 0/1 interference
      rejection, and 3/4 correct updates. This proves the raw-message benchmark
      ingress is too permissive. The Agent-filtered arm then reduced the same
      session from 30 to 12 candidates, raised all-candidate accuracy and
      interference rejection to 1.0, and updated 4/4 targets, but expected-point
      recall fell to 0.5 because it omitted one explicit attitude/causal detail.
      This validates the Agent/Core responsibility split while exposing its
      precision/recall trade-off; it still precedes posterior promotion. A
      second matched slice (session 5) repeated the volume reduction (52 to 8),
      retained 7/8 ordinary gold points, achieved 1.0 candidate accuracy and a
      correct update, but also exposed that the official interference aggregate
      can penalize an inference the judge accepts without an attributable
      injected candidate. Promotion gates must therefore retain per-record
      evidence instead of optimizing only the aggregate interference score.
      The attributable STG arm is now implemented against the real
      `recordClaimOutcomes` posterior. Sessions 5–6 observed through 11 admitted
      17 candidates (three assistant-only/unattributable candidates rejected),
      while sessions 1–2 observed through 11 admitted 16; neither window found a
      later exact independent user confirmation, so both qualified zero.
      HaluMem can audit admission and updates but cannot supply the product-like
      outcomes needed to estimate false-promotion or retraction cost. Remaining
      gate: collect attributable natural-use outcomes and measure those costs
      before enabling unattended actuation. See
      `halumem-operation-evaluation-2026-08-11.md`.

## P2 — automatic topology maintenance

- [ ] Evaluate automatic node-merge proposals on natural data, including
      false-merge cost, scope conflicts, aliases, and rollback. The first
      LoCoMo speaker-identity gate audit is documented in
      `topology-gate-evaluation-2026-08-09.md`: injected same-person candidates
      passed 20/20, cross-person candidates were rejected 10/10, all 20 eligible
      candidates became ineligible after a competing `distinct_from`, and the
      read-only assessment made zero topology mutations. This remains unchecked
      because candidate discovery, aliases/homonyms, and end-to-end false-merge
      cost are not covered by LoCoMo. Journaled physical merge rollback is now
      implemented and deterministically tested: it restores ownership and the
      exact local relation set, but refuses rollback after intervening edits.
      The BPID hard-negative audit in
      `topology-bpid-evaluation-2026-08-09.md` adds 10,000 independently labelled
      identity pairs and non-oracle, multi-field candidate generation. It finds
      that a `0.98` blocking score still yields only 92.12% precision and 5.12%
      recall; all six bounded physical rollback probes restore correctly. The
      item remains unchecked because BPID is synthetic/pair-labelled and does
      not measure online candidate prevalence or downstream false-merge cost.
      A content-only LoCoMo discovery arm now removes speaker labels, node names,
      and scope from ranking and selects one late fragment per early fragment.
      It recovers 16/20 true identities (80% recall/precision) and produces four
      natural false candidates. A forced diagnostic merge co-locates 12 foreign
      records (three per error), and all four journaled transforms roll back.
      This closes the earlier “candidate discovery is entirely oracle” gap and
      measures structural false-merge contamination, confirming that similarity
      must remain proposal-only. A streaming, read-only Namesakes adapter is now
      implemented (`topology-namesakes-evaluation.md`) for labelled alias-like
      positives and same-name `Other` negatives. The complete official Figshare
      entity file was checksum-verified and evaluated: 3,975 entities produced
      23,996 pairs (17,294 positives and 6,702 negatives). No hashing-similarity
      threshold provided a safe identity operating point; at 0.5, recall was
      94.16% but precision only 71.63%, while stricter thresholds sacrificed
      recall without reaching automatic-merge precision. This independently
      confirms that the current content signal is suitable only for candidate
      generation. A read-only online-arrival counterfactual now measures proposal
      prevalence and structural contamination: at 0.5 it would propose 94.74% of
      arrivals and attach 6,450 foreign records across 2,307/3,975 entities; even
      at 0.7, 1,479 entities receive a false proposal and contamination reaches
      3,003 records. A fixed ten-entity paired Agent attribution probe now adds
      one independently resolved foreign-page record to otherwise identical
      clean evidence. A five-repeat DeepSeek V4 Flash run produced 50 paired
      observations: clean/foreign exact attribution was 84%/88%, five pairs
      changed correct-to-wrong, seven changed wrong-to-correct, exact McNemar
      p=0.774, and the foreign record was rejected in all 50 cases. The one-repeat
      ten-point decline was therefore model variance, not a stable effect. An earlier
      same-page construction was rejected as invalid because its `Other`
      paragraphs still described the target. The corrected probe therefore
      does not demonstrate false attribution or downstream answer damage.
      The item remains unchecked because Namesakes has no natural user correction
      events and the small single-run probe does not measure correction/recovery
      cost, larger-pair behavior, or end-to-end answer damage.
- [x] Define a high-precision acceptance gate for automatic node merging.
      The read-only gate requires a pending `same_as` proposal, repeated
      observations, near-certain mean judge confidence, multiple evidence
      memories balanced across both nodes, identical evidence scope, and no
      competing conflict/distinct proposal. Passing does not actuate.
- [x] Keep uncertain merge/split proposals pending for explicit review. The
      evaluator is read-only and `reviewTopologyProposal` remains the only
      mutation path; repeated semantic judgments accumulate evidence instead
      of silently merging nodes.
- [x] Measure whether graph adaptation beats NMG Lite before making unattended
      topology mutation a default feature. In the matched seven-category probe,
      Lite and Graph both passed 5/7 while Graph added graph retrieval work; no
      benefit was demonstrated. The sample is not a general capability claim,
      but it is sufficient for the product decision: unattended topology
      mutation stays disabled and graph adaptation remains Lab-only until a
      larger matched evaluation reverses this result.

## P2 — matched product evaluation

- [x] Run matched comparisons with the same model, histories, prompts, and
      context budgets for: no memory, flat hybrid retrieval, NMG Lite, and NMG
      Graph. The four-arm runner isolates tools and state and counterbalances
      arm order. A seven-category engineering probe is recorded in
      `matched-evaluation-2026-08-09.md`: flat passed 7/7, Lite and Graph 5/7,
      and no-memory 1/7. The sample proves protocol closure and exposes cost and
      failure modes, but remains too small for a general capability claim.
- [x] Report answer quality, official evidence recall, injected tokens, search
      latency, model/tool-call latency, and storage/indexing cost separately.
      LongMemEval reports answer and retrieval scores independently,
      `officialRetrievalByMode` from immutable source references,
      `injectedContextByMode` as characters plus explicitly estimated tokens,
      provider token/cache usage, client-observed model-stream versus tool time,
      NMG per-section search timings, and deterministic ingestion/indexing
      preparation cost.
- [x] Evaluate tiered disclosure and the session injection window for token
      savings and stale-context failures. `evals/disclosure/` deterministically
      reduces a 32-record L1 result from 5,314 to 2,645 estimated tokens and the
      second same-session header from 8,563 to 1,220 characters. Extension tests
      verify changed/expired content is reinjected and compaction clears the
      window. Provider tokenization and answer-quality impact remain part of the
      matched/real-use evaluations rather than this mechanism probe.
- [x] Test multilingual automatic-recall gating and measure false positives and
      false negatives instead of expanding regexes without evidence. The
      deterministic 24-case probe in `evals/gate/` covers English, Chinese,
      German, French, Japanese, and Spanish and currently reports zero errors on
      its curated set. This is a regression boundary, not production-frequency
      calibration; real-use trace calibration remains under P0-D.
- [x] Keep ANN non-default until it demonstrates a useful recall/latency
      crossover at the intended scale. The 100K/1M scale work and hierarchy
      probes are recorded in `scale-evaluation-2026-08-09.md` and
      `evals/hierarchy-scale/README.md`: SQLite FTS remains fast, while the
      current USearch record/leaf ANN loses too much recall unless its candidate
      set grows large. ANN therefore remains an explicit non-default diagnostic.

## Decision required — implemented but not connected to Pi

**Update 2026-08-03:** the `lab/` boundary is now enacted. `ReasoningWorkspace`,
`MemoryGraphReasoner`, `ForkMerge`, the differentiable-controller stack
(`autodiff`, `differentiable-controller`, `controller-protocol/-runtime/-gate`,
`shadow-evaluation`), and `rank-fusion` live under `src/lab/` and are no longer
exported from `src/index.ts`; the public API now equals wired capability.
`hierarchical-activation.ts` remains in `src/core/` because the production
`Router` imports it — extracting the hierarchical routing out of `Router` is
the remaining step. Open decisions that stay:

- [x] Keep `ReasoningWorkspace` as a Lab prototype rather than making it Pi's
      session scratchpad by default. The concept remains valid, but runtime
      integration requires matched evidence that it preserves useful reasoning
      across compaction without leaking hidden chain-of-thought.
- [x] Because it is not adopted, do not expose or auto-inject a checkpoint
      lifecycle. A future integration must begin opt-in and session-scoped.
- [x] Keep `hierarchical-activation.ts` in core. Production `Router` depends on
      it, and the later decision that lightweight differentiable/routing support
      may belong in NMG Lite supersedes the earlier plan to move it into Lab.
- [x] Keep Lab prototypes explicitly out of normal-retrieval capability claims
      until runtime integration and matched evaluation exist; `src/index.ts`
      does not export them as wired product capability.

## Scale and concurrency — only when demanded by measurements

- [x] Stress-test concurrent Agent sessions against the single resident-service
      writer and synchronous SQLite handle. The bounded 32-session/800-write
      probe completed without failures; results and limits are recorded in
      `scale-evaluation-2026-08-09.md`. It intentionally does not spawn daemons.
- [x] Measure database and index behavior at 100K and 1M records before changing
      storage engines. `scale-evaluation-2026-08-09.md` records the no-embedding
      result: FTS5 remains sub-millisecond while unindexed semantic/route scans
      become seconds-level. This does not justify replacing SQLite.
- [x] Revisit automatic STG working-set sync and cache invalidation only if
      measured latency or memory warrants it. The scale result points to missing
      semantic indexing, not STG synchronization or cache invalidation, so no
      speculative cache subsystem change is made.

## Explicitly deferred — not current missing work

These are recorded design options, not unchecked completion requirements. They
must return to the active checklist only after their stated prerequisite is
observed:

- Cloudflare synchronization and multi-device conflict resolution: revisit only
  when multi-device operation is in scope.
- Rust or Python rewrites of the TypeScript core/adapter: revisit only after a
  measured TypeScript bottleneck or an unavoidable native dependency.
- vLLM as a required runtime dependency: rejected for the local-first default;
  an optional external model service may still be used.
- Strict Huffman-tree storage: revisit only if tier/block access fails measured
  scale and latency targets.
- Automatic multi-edge motif consolidation: Lab-only until ordinary edge and
  node adaptation have trustworthy natural-data labels.
- L5 physical purge: prohibited until privacy, recovery, and user-consent policy
  is reviewed and implemented.
- [x] Add the SkillOpt offline Lab boundary, de-identified policy dataset,
      official-checkout adapter, chronological train/selection/test split,
      fail-closed readiness gate, and isolated candidate-policy Pi hook. Mutable
      facts/evidence remain outside the optimizer and production retains
      `nmg-prompts.yaml` as its only prompt source.
- [ ] Collect enough materially independent natural retrieval outcomes for the
      SkillOpt gate (default engineering floor: 24 tasks = 12 train, 6 held-out
      validation, 6 untouched test). The current three controlled tasks only
      validate plumbing; `--allow-insufficient` must never authorize training.
- [ ] Once ready, run SkillOpt and a matched Pi+NMG promotion experiment over
      answer quality, evidence recall, pollution, tokens, tool calls, and
      latency. Adopt a winning `best_skill.md` only through reviewed changes to
      `nmg-prompts.yaml`; never load it as a second production prompt source.

## Completion rule

When an item is completed, move the durable design or operating instructions
to the appropriate document and remove it here. Delete this file when no
unresolved implementation decisions remain.
