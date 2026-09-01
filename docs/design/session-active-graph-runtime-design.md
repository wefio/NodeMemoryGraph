# Session Active Graph runtime

**Status:** 0.11 / core implemented; task/branch lifecycle and combined budget open
**Updated:** 2026-09-01

This topic document is the implementation blueprint for the session-owned Active
Graph (AG) runtime. It refines the normative model in [design.md](design.md) §7
and the decision in
[`docs/decisions/proposed/2026-08-29-session-active-graph-runtime.md`](../decisions/proposed/2026-08-29-session-active-graph-runtime.md).
It exists so a future Agent can see what the runtime is, what remains, and how
each acceptance criterion maps to code — without re-deriving the design.

## 1. What the runtime is

`SessionActiveGraphRuntime` (`src/core/session-active-graph.ts`) is the single
working-memory container for one Agent session, owned by the daemon and
memory-resident. It is deliberately **non-authoritative**: durable truth stays in
STG/LTG, and the whole graph disappears when its owning session is released.

Four distinct identities partition the design (design.md §7.1):

- `agId` — the session working graph (one per session);
- `taskFrameId` — one semantic task partition inside AG;
- `projectionId` — one immutable exposure/feedback boundary (a frozen revision);
- `boardChannelId` — a Task Board coordination channel (not part of AG content).

Every model-visible retrieval freezes an immutable `ProjectionRevision` from the
mutable AG. `get`, diagnostic attribution, and claim outcomes resolve the
projection back to its owning persisted traces and reject cross-session use.

## 2. Current implementation (verified core)

Implemented and covered by tests:

- Session-scoped mutable graph with a stable `agId`, monotonic projection
  `sequence`, `latestProjectionId`, and per-projection `parentProjectionId`
  within the same task frame.
- Immutable frozen projections: `deepFreezeGraph` freezes the graph, selections,
  expansions, ledger, budget, and usage; parts are copied into frozen sets.
- Projection-to-trace provenance and cross-session rejection
  (`projection(projectionId, sessionId)` returns null for another session).
- `observe()` for bounded tool observations and Task Board projections
  (`kind: "tool_observation" | "board_projection"`), hidden from the model until
  `activateTemporaryProjection`, deduplicated by content hash, and evicted by a
  bounded item/character budget.
- `reasoning_artifact` kind exists in the item type but has **no TTL layer yet**.
- Bounded sessions/items/characters/projections with deterministic eviction
  (`compareEvictionPriority`: activation, then last-activated time).
- `release(sessionId)` removes the session and its projection ownership.
- `snapshot()` projects active items plus (when the temporary projection is
  active) observations.

Runtime tests: `tests/core/session-active-graph.test.ts` (identity/projection
immutability, temporary observation hiding, release cleanup, plus the task-frame
behavior tests added in the current change).

## 3. Independent verification against the literature (surveyed 2026-09-01)

The AG runtime design in this document is **not derived from** the work below.
It comes from NMG's own design corpus: the four-identity model and
working-memory framing in [design.md](design.md) §7.1, the task-frame/cooling/
budget definitions in the [AG runtime decision](../decisions/proposed/2026-08-29-session-active-graph-runtime.md),
and the STG/LTG/AG model in [memory-graphs.md](memory-graphs.md). The survey
below is a **post-hoc cross-check only**: it confirms NMG's independent design
has no obvious blind spot relative to current agent-memory research and
engineering practice. It is not a source of requirements.

### 3.1 Research context

| Work | Reference | Mechanism | Cross-check against §4 |
| --- | --- | --- | --- |
| **MemGPT** | [arXiv:2310.08560](https://arxiv.org/abs/2310.08560) | OS-style virtual context; LLM manages fast (core) vs slow (archival) memory; pressure heuristic triggers archival | §4.3 unified budget covers the same problem (bounded working context) with a deterministic hard ledger instead of a learned/LLM-driven signal. |
| **A-MEM** | [arXiv:2502.12110](https://arxiv.org/abs/2502.12110), NeurIPS 2025 | Zettelkasten dynamic memory: notes linked by similarity, memory "evolves" | NMG's typed node/edge graphs + relation proposals are stricter: co-occurrence never creates edges; AG state never becomes durable structure. |
| **Zep** | [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) | Temporal knowledge graph for agent memory + Graph RAG | NMG's HistoryRecord + temporal/logical chains cover temporal structure; the AG runtime adds session working memory with immutable exposure revisions. |
| **AgentFold** | [arXiv:2510.24699](https://arxiv.org/abs/2510.24699), ICLR 2026 | Treats context as a "dynamic cognitive workspace"; learns multi-scale **folding** (granular condensation vs deep consolidation) | Same problem as §4.1 cooling set + task return, but NMG uses deterministic task-frame eviction rather than a learned folding policy; NMG keeps details retrievable instead of irreversibly consolidating them. |
| **Memory surveys** | [arXiv:2512.13564](https://arxiv.org/abs/2512.13564); [arXiv:2505.00675](https://arxiv.org/pdf/2505.00675) | Function taxonomy: factual / experiential / **working** memory | Confirms NMG's placement: AG = working memory; STG/LTG = factual + experiential. The "working memory" function is exactly what §4.1–4.4 operationalize. |

### 3.2 Engineering practice

| Source | Best practice | NMG AG runtime correspondence |
| --- | --- | --- |
| [Anthropic: effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | **Context rot**: model recall degrades as context grows (finite attention budget); curate the smallest high-signal set | §4.3 hard token/item budget + §4.5 disclosure ledger directly enforce "smallest high-signal set". |
| Anthropic (same) | **Structured note-taking / agentic memory**: notes outside context, pulled back later | AG's semantic items + task frames are NMG's structured working memory; durable notes are LTG via governed `remember`. |
| Anthropic (same) | **Tool result clearing**: drop raw tool output once used | §4.5 disclosure ledger + `observe()` dedup/eviction: tool observations are temporary and hidden until projected. |
| Anthropic (same) | **Sub-agent architectures**: isolate focused work in clean contexts | Task-frame isolation (§4.1/4.2) is the in-graph analogue; the Task Board covers cross-agent coordination. |
| [Context as an Environment](https://arxiv.org/html/2608.21690) | Programmatic context management: stale spans evicted but **recoverable via an eviction index** | §4.1 cooling set is the recoverability mechanism: evicted frames stay retrievable (until the bounded cap), unlike irreversible compaction. |

**Conclusion of the cross-check:** the surveyed research and practice solve the
same working-memory problem with learned folding, pressure heuristics, or
agent-written notes. NMG's §4 design differs in being **deterministic,
provenance-preserving, and budget-checked**; the survey found no mechanism in
these systems that §4 is missing. In particular, AgentFold's irreversibility
(deep consolidation loses detail) is a known failure mode that NMG's cooling set
and LTG-governed writes avoid by design.

## 4. Remaining work (this blueprint)

The decision's acceptance criteria that are still open:

| # | Capability | Status | Owner surface |
| --- | --- | --- | --- |
| 4.1 | Task-frame lifecycle: switch + bounded cooling set + return | Open | `session-active-graph.ts` |
| 4.2 | Branch ownership: same-frame branches with correct parent chains, no cross-frame contamination | Open | `session-active-graph.ts` |
| 4.3 | Unified semantic + tool + reasoning budget ledger | Open | `types.ts`, `session-active-graph.ts` |
| 4.4 | TTL/provenance for reasoning artifacts (bounded MGR output) | Open | `session-active-graph.ts` |
| 4.5 | Host-neutral disclosure ledger (Pi injection window moves into AG) | Open | adapters, `session-active-graph.ts` |
| 4.6 | HA admission/rescoring on the AG (optional, gated) | Open | HA + runtime wiring |

### 4.1 Task-frame lifecycle

Design intent (design.md §7.1, decision §Proposal): AG keeps **one active task
frame and a small bounded cooling set** so a task switch does not destroy state
and a return does not reconstruct everything from the transcript.

Concrete model:

- `SessionState` gains `frames: Map<taskFrameId, FrameState>` where `FrameState`
  holds its own `items`, `edges`, `latestProjectionId`, `lastActivatedAt`, and
  `parentProjectionId`.
- `registerProjection` and `observe` already receive an explicit `taskFrameId`;
  the runtime tracks `activeTaskFrameId`. Switching frames cools the previous
  frame (kept in the bounded set) instead of dropping it.
- `maxTaskFramesPerSession` bounds the cooling set; the oldest cooled frame is
  evicted beyond the cap (LRU by last activation).
- Returning to a cooled frame resumes its own parent chain (the next projection's
  `parentProjectionId` is that frame's latest, not the other frame's).

Acceptance mapping (decision §Acceptance): "Task-switch tests cover continuation,
A-to-B switch, A-to-B-to-A return, shared constraints, false switches, compaction,
and session cleanup."

### 4.2 Branch ownership

A task frame may branch (A→B→A return, or concurrent sub-goals). Branch rules:

- Each projection records the frame it was frozen from; the parent chain is
  frame-local, so a return to a frame never links across frames.
- `taskFrame(sessionId, taskFrameId)` exposes a frame's snapshot (items, edges,
  latest projection) so an Agent can inspect cooled state.
- Session release clears every frame; no frame survives its session.

### 4.3 Unified semantic + tool + reasoning budget

Design intent (decision §Proposal): `B` is a **hard total budget** over nodes,
edges, evidence, tokens, graph depth, temporary observations, reasoning steps,
task frames, and latency.

Current `ActiveGraphBudget` (`types.ts`) covers retrieval dimensions only
(nodes/edges/evidence/tokens/hops/tier/latency). The combined budget adds:

- `maxObservations` and `maxReasoningSteps` (or folds observations into the
  existing item/character bounds and adds reasoning to the token budget);
- the ledger gains dimensions for `tool_observations` and `reasoning_artifacts`
  so `budgetLedger` reports a single shared account, not per-call snapshots.

The runtime enforces the shared account at `observe()` (tool observations) and at
reasoning-artifact admission (3.4): consuming one reduces the same pool that
retrieval selections consume.

### 4.4 TTL/provenance for reasoning artifacts

Design intent (decision §Proposal): MGR results are **hypothetical, attributed,
TTL-bound**; they can reach STG/LTG only through a separate verified or explicit
`remember` path.

- `SessionActiveGraphItem` gains `ttlMs` and `sourceKind` (e.g. `"mgr"`) for
  `reasoning_artifact` items; an item expires after its TTL from `createdAt` and
  is excluded from snapshots (and evicted) once expired.
- Provenance is recorded on the item (`sourceId` chain to the MGR invocation);
  no artifact is ever written to STG/LTG by the runtime.
- A projection that contains an expired artifact must still be readable (the
  frozen revision is immutable), but the live AG stops surfacing it.

### 4.5 Host-neutral disclosure ledger

Design intent (design.md §7.1, decision §Proposal): the Pi injection window moves
into the AG disclosure ledger so every adapter exposes model context through the
same immutable projection mechanism.

- The runtime records which projection IDs were disclosed to the model
  (`disclosedProjectionIds` per session) and what each projection's visible items
  were — a session-local, memory-resident disclosure record.
- Adapters (Pi/DSH/Claude) render from `snapshot()`/`projection()` instead of
  maintaining adapter-local windows; the per-session "already injected" fold
  window becomes a ledger query rather than a separate adapter cache.

### 4.6 HA admission (optional, gated)

Hierarchical activation may later score admission/cooling/reactivation against
the AG and rescore MGR artifacts before a projection freezes. It remains
**opt-in Lab**, does not change semantic confidence or edge stability, and has no
persistent weights in AG. Wiring is deferred until 3.1–3.4 land and natural
evidence exists.

## 5. Acceptance criteria (from the decision)

The decision lists these as the bar for promoting from proposed to implemented:

- [x] Four identities distinguished (agId / taskFrameId / projectionId /
      boardChannelId).
- [x] AG memory-resident, session-owned; no AG content persisted as semantic
      memory.
- [x] Projection freezes exact exposure; get/attribution/replay supported.
- [ ] Tool observations and retrieved semantic references share **one total
      budget**.
- [ ] HA fast state isolated by session/branch; activation cannot raise semantic
      confidence or edge stability by itself.
- [ ] MGR uses bounded selected AG subgraphs, records derivation provenance,
      emits hypothetical TTL-bound artifacts.
- [ ] Task-switch tests cover continuation, A→B, A→B→A, shared constraints,
      false switches, compaction, session cleanup.
- [ ] Current query-scoped AG / Pi runtime AG / continuation-map behavior
      migrated or removed (no permanent compatibility layers).

## 6. Implementation lineage

- **Introduced** (core runtime): protocol v9 session AG RPC, projection registry,
  Pi tool/Task Board ingestion — commit `e03150c` (partial), consolidated in the
  initial `SessionActiveGraphRuntime`.
- **Hardened** (this change): task-frame lifecycle + cooling set + branch
  ownership + combined budget ledger + TTL reasoning artifacts — see the PR that
  lands this document.
