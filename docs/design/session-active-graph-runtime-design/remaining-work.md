# Remaining work (this blueprint)

[简体中文](remaining-work.zh-CN.md) · [Terms used](remaining-work.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../session-active-graph-runtime-design.md).

## Remaining work (this blueprint)

The [decision's](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision) acceptance criteria and their current status:

| # | Capability | Status | Owner surface |
| --- | --- | --- | --- |
| 4.1 | Task-frame lifecycle: switch + bounded cooling set + return | **Implemented** | `session-active-graph.ts` |
| 4.2 | Branch ownership: same-frame branches with correct parent chains, no cross-frame contamination | **Implemented** | `session-active-graph.ts` |
| 4.3 | Unified semantic + tool + reasoning budget ledger | **Partial**: runtime item/character bounds exist; the full multidimensional shared account remains open | `session-active-graph.ts` + retrieval budget |
| 4.4 | TTL/provenance for reasoning artifacts (bounded MGR output) | **Runtime primitive implemented**; automatic MGR admission remains deferred | `session-active-graph.ts` |
| 4.5 | Host-neutral disclosure ledger (adapter windows move into AG) | **Implemented** for Pi, DSH, WorkBuddy and MCP | runtime + adapter RPC calls |
| 4.6 | HA admission/rescoring on the AG (optional, gated) | **Intentionally deferred** until natural utility evidence exists; the separate explicit `hierarchical-activation` retrieval mode remains available, but AG admission/rescoring is not wired | HA + runtime wiring |

### Task-frame lifecycle

Design intent ([design.md §7.1](../design.md#71-session-ag-update-and-projection-revisions),
[decision](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)):
AG keeps **one active task frame and a small bounded cooling set** so a task
switch does not destroy state and a return does not reconstruct everything from
the transcript.

Concrete model:

- `SessionState` gains `frames: Map<taskFrameId, FrameState>` where `FrameState`
  holds its own `items`, `edges`, `latestProjectionId`, `lastActivatedAt`, and
  `parentProjectionId`.
- `registerProjection` and `observe` already receive an explicit `taskFrameId`;
  the runtime tracks `activeTaskFrameId`. Switching frames cools the previous
  frame (kept in the bounded set) instead of dropping it.
- `maxTaskFramesPerSession` caps all retained frames, including the active frame.
  When a new frame would exceed the cap, the least recently activated cooled
  frame is evicted (LRU); with one active frame, at most cap minus one cooled
  frames remain.
- Returning to a cooled frame resumes its own parent chain (the next projection's
  `parentProjectionId` is that frame's latest, not the other frame's).

Acceptance mapping ([decision](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)):
"Task-switch tests cover continuation, A-to-B switch, A-to-B-to-A return, shared
constraints, false switches, compaction, and session cleanup."

### Branch ownership

A task frame may branch (A→B→A return, or concurrent sub-goals). Branch rules:

- Each projection records the frame it was frozen from; the parent chain is
  frame-local, so a return to a frame never links across frames.
- `taskFrame(sessionId, taskFrameId)` exposes a frame's snapshot (items, edges,
  latest projection) so an Agent can inspect cooled state.
- Session release clears every frame; no frame survives its session.

### Unified semantic + tool + reasoning budget

Design intent ([decision](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)):
`B` is a **hard total budget** over nodes, edges, evidence, tokens, graph depth,
temporary observations, reasoning steps, task frames, and latency.

Current `ActiveGraphBudget` (`types.ts`) covers retrieval dimensions only
(nodes/edges/evidence/tokens/hops/tier/latency). The combined budget adds:

- `maxObservations` and `maxReasoningSteps` (or folds observations into the
  existing item/character bounds and adds reasoning to the token budget);
- the ledger gains dimensions for `tool_observations` and `reasoning_artifacts`
  so `budgetLedger` reports a single shared account, not per-call snapshots.

The runtime enforces the shared resident account at `observe()` (tool
observations), reasoning-artifact admission and dedicated current-state admission:
consuming one reduces the same item/character pool that retrieval selections
consume. Maintained state has explicit admission refusal and is not silently
removed by ordinary-item trimming; it can reduce available retrieval capacity.
This remains distinct from the full multidimensional and model-input budget.

### TTL/provenance for reasoning artifacts

Design intent ([decision](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)):
MGR results are **hypothetical, attributed, TTL-bound**; they can reach STG/LTG
only through a separate verified or explicit `remember` path.

- `SessionActiveGraphItem` gains `ttlMs` and `sourceKind` (e.g. `"mgr"`) for
  `reasoning_artifact` items; an item expires after its TTL from `createdAt` and
  is excluded from snapshots (and evicted) once expired.
- Provenance is recorded on the item (`sourceId` chain to the MGR invocation);
  no artifact is ever written to STG/LTG by the runtime.
- A projection that contains an expired artifact must still be readable (the
  frozen revision is immutable), but the live AG stops surfacing it.

### Host-neutral disclosure ledger

Design intent ([design.md §7.1](../design.md#71-session-ag-update-and-projection-revisions),
[decision](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)):
the Pi injection window moves into the AG disclosure ledger so every adapter
exposes model context through the same immutable projection mechanism.

- The runtime records disclosed projection IDs plus bounded content entries:
  stable memory ID, hash of the representation visible at that depth, greatest
  disclosure depth, and model-turn number.
- Pi, DSH, WorkBuddy and MCP ask the daemon to classify candidates as fresh or
  already in context, then keep their host-specific rendering. No adapter owns a
  second disclosure cache.
- A deeper request or changed visible content is rendered again. By default,
  entries expire after 12 turns and the ledger holds at most 128 records; runtime
  options can change both limits. Compaction clears only disclosure state
  (because the model context was removed). Adapters with a host
  shutdown lifecycle release the whole AG; the stateless WorkBuddy hook has no
  shutdown event, so its bounded ledger lives until daemon eviction or restart.
- RPC failure degrades toward showing requested evidence, never silently folding
  content whose disclosure cannot be confirmed.

The [shared information-output foundation](../../decisions/implemented/2026-10-07-shared-information-output.md)
now separates pure preparation from exact rendered-fragment confirmation. It
snapshots admitted views, fingerprints only sourced rows that fit, and returns
reader-local candidates without writing this ledger. Legacy text interfaces use
that same preparation. Actual next-input/authorization confirmation and ledger
commitment are not wired by this foundation; `details` or `structuredContent`
field names alone cannot establish model visibility. Its character cap is per
prepared text, not [Unified semantic + tool + reasoning budget](#unified-semantic--tool--reasoning-budget)'s unified semantic/tool/reasoning budget.

### HA admission (optional, gated)

Hierarchical activation may later score admission/cooling/reactivation against
the AG and rescore MGR artifacts before a projection freezes. The existing
`hierarchical-activation` retrieval mode is a separate surface; the described AG
admission/rescoring integration is not wired. This integration does not change
semantic confidence or edge stability and adds no persistent weights to AG.
Wiring remains deferred until natural-utility evidence exists, as specified in
the [decision's Deferred section](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#deferred).
