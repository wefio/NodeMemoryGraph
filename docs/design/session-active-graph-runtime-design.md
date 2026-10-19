# Session Active Graph runtime

[中文](session-active-graph-runtime-design.zh-CN.md) · [Terms used](session-active-graph-runtime-design.terms.yaml)

**Status:** current
**Updated:** 2026-10-15

Use this blueprint to locate the implemented session Active Graph core and its
remaining acceptance gaps. Existing slices include task/branch lifecycle,
bounded items, maintained state and the host-neutral disclosure ledger. This
refines the [design baseline](design.md) and the
[AG runtime decision](../decisions/implemented/2026-08-29-session-active-graph-runtime.md);
it does not declare the whole target integrated.

## What the runtime is

`SessionActiveGraphRuntime` (`src/core/session-active-graph.ts`) is the single
working-memory container for one Agent session, owned by the daemon and
memory-resident. It is deliberately **non-authoritative**: durable truth stays in
STG/LTG, and the whole graph disappears when its owning session is released.

Four distinct identities partition the design:

- `agId` — the session working graph (one per session);
- `taskFrameId` — one semantic task partition inside AG;
- `projectionId` — one immutable exposure/feedback boundary (a frozen revision);
- `boardChannelId` — the design's Task Board channel identity, selected through
  `taskId` in board APIs, not an AG frame or a new API argument.

Every model-visible retrieval freezes an immutable `ProjectionRevision` from the
mutable AG. `get`, diagnostic attribution, and claim outcomes resolve the
projection back to its owning persisted traces and reject cross-session use.

## Current implementation (verified core)

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
- `reasoning_artifact` supports bounded TTL and explicit source provenance; expiry
  removes it from live snapshots without rewriting frozen projections.
- Bounded sessions/items/characters/projections with deterministic eviction
  (`compareEvictionPriority`: activation, then last-activated time).
- `release(sessionId)` removes the session and its projection ownership.
- `snapshot()` projects active semantic references and `working_state`, plus
  ordinary observations when the temporary projection is active.
- Dedicated `bindWorkingState`/`replaceWorkingState`/`clearWorkingState` maintain
  one exact provisional text per frame. `observe` cannot write this kind. A
  replacement keeps the item ID, updates its content hash and captured binding
  provenance, and never creates a disclosure or semantic record. Blank, secret,
  oversize, stale or capacity-rejected writes preserve the previous value.
- State consumes the same resident item/character caps; ordinary item eviction
  protects it. Explicit clear, frame/session eviction and release remove it.
  Clearing the disclosure window does not. The default state ceiling is the
  smaller of resident capacity and the 8,000-code-unit preparation ceiling minus
  the required temporary label and separator; configuration cannot raise it.
- AG writer enablement through the normal [state-space entry](state-spaces.md),
  `nmg_state`, leases existing authority and captures a session working-frame
  fence. Legacy internal lease/RPC paths remain compatible; daily model-facing
  Lab use is rejected. Clients attach the fence outside model input and keep
  it unchanged on retry. Session/AG incarnation, active frame and binding must
  still match at the synchronous write. Rebinding, switching or release invalidates
  old writes. These metadata are fencing, not authentication.
- Current tool/RPC adapters explicitly use a session working frame while the
  lease is enabled, rather than query hashes. Library callers may bind an actual
  trusted task frame. Semantic task detection and adapter A→B→A restoration are
  not implemented; do not infer a task from a board channel.

Runtime tests: `tests/core/session-active-graph.test.ts` and
`tests/core/working-state.test.ts`; service/client contracts:
`tests/cli/working-state.test.ts` and `tests/integration/working-state-client.test.ts`.
The [working-state decision](../decisions/implemented/2026-10-08-ag-working-state.md)
records this bounded slice. Short write acknowledgements and surface preparation
are not host-input replacement, visibility commitment or cost/continuity proof.

### Dedicated state carriage

The shared `working-state-input.ts` contract reads the current snapshot and
prepares one complete provisional body under the shared output budget, fenced by
session, AG incarnation, frame, captured binding and content/text hashes. It owns
no history, no visibility cache and no competing store, and it always remains
unconfirmed.

Pi carries that body once per user turn as a labelled block in the persisted
`nmg-context` message returned by `before_agent_start`; the extension registers
no per-inference `context` hook, so later model calls in the same turn re-send
nothing and rewrite or remove no earlier position. State stays out of the mixed
recall projection. A mid-turn read uses the history already in the session or the
read-only `/nmg state` view. An unavailable owner, a foreign or incompletely
prepared snapshot or a session changed during the read contributes no body and
never presents old progress as current. Clear/release ends carriage from the next
turn and removes the corresponding live state; it does not delete prior host
messages. If compaction removes a turn message while state remains current, the
next user turn carries it again.
The Pi 1.1.0 hook surface documented by this slice permits later input/payload
replacement and provides no final request-body confirmation. The adapter reports
confirmation unsupported and commits no state exposure to the disclosure ledger. This is carriage, not a
guarantee of final provider input. Scope and proof:
[carriage decision](../decisions/implemented/2026-10-08-ag-working-state-input.md).

## Literature cross-check (surveyed 2026-09-01)

The recorded survey was a post-hoc author cross-check, not independent semantic
review, a requirement source or a fresh online verification. NMG's requirements
come from its [design baseline](design.md),
[AG runtime decision](../decisions/implemented/2026-08-29-session-active-graph-runtime.md)
and [memory model](memory-graphs.md). The historical comparisons identify related
problems; they do not establish research completeness or measured superiority.

### Research context

| Recorded work | Reference | Mechanism described in the survey | NMG comparison |
| --- | --- | --- | --- |
| MemGPT | [arXiv:2310.08560](https://arxiv.org/abs/2310.08560) | OS-style virtual context, fast core and slow archival memory, pressure-triggered archival | Unified-budget work addresses bounded context; it does not prove optimal high-signal selection. |
| A-MEM | [arXiv:2502.12110](https://arxiv.org/abs/2502.12110), NeurIPS 2025 | Similarity-linked evolving notes | NMG distinguishes typed relations, proposals and admitted durable structure; co-occurrence is not structural admission. |
| Zep | [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) | Temporal knowledge graph and Graph RAG | Historical/temporal chains and session projections address different parts of that problem. |
| AgentFold | [arXiv:2510.24699](https://arxiv.org/abs/2510.24699), ICLR 2026 | Learned multi-scale context folding, condensation and consolidation | NMG proposes deterministic task-frame cooling/eviction; this is not a comparative detail-loss result. |
| Memory surveys | [arXiv:2512.13564](https://arxiv.org/abs/2512.13564); [arXiv:2505.00675](https://arxiv.org/pdf/2505.00675) | Factual, experiential and working-memory taxonomy | AG provides working context; STG/LTG hold provisional/durable meaning. The taxonomy is explanatory, not an acceptance test. |

### Engineering practice

| Recorded source | Survey theme | NMG comparison |
| --- | --- | --- |
| [Anthropic: effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Context rot and selecting a small high-signal set | Hard budgets and disclosure bound output; they do not prove that the chosen set is the smallest or best. |
| Anthropic (same) | Structured notes outside context | Frames organize working context; durable notes require governed `remember`. |
| Anthropic (same) | Tool-result clearing | `observe()` deduplication/eviction and disclosure control temporary output. |
| Anthropic (same) | Isolated sub-agent contexts | Frame isolation is an in-graph analogy; Task Board owns cross-Agent coordination. |
| [Context as an Environment](https://arxiv.org/html/2608.21690) | Eviction with indexed recovery | Cooling frames are recoverable while retained within the cap. Evicted ephemeral state is not promised recoverable. |

These overlaps motivate provenance-preserving, deterministic budget checks.
They do not prove every mechanism is covered, every detail survives eviction,
or NMG outperforms the cited systems. STG/LTG-backed references remain retrievable
only while their backing records remain available; a cooling set is bounded.
[Remaining work](#remaining-work-this-blueprint) retains the unfulfilled contract.

## Remaining work (this blueprint)

Read the complete responsibility: [Remaining work (this blueprint)](session-active-graph-runtime-design/remaining-work.md).

## Acceptance criteria (from the decision)

The decision lists these as the bar for promoting from proposed to implemented:

- [x] Four identities distinguished (agId / taskFrameId / projectionId /
      boardChannelId).
- [x] AG memory-resident, session-owned; no AG content persisted as semantic
      memory.
- [x] Projection freezes the selected retrieval surface; get/attribution/replay
      resolve its provenance. This does not confirm final provider input.
- [ ] Tool observations and retrieved semantic references share **one total
      budget**.
- [x] HA fast state isolated by session/branch; activation cannot raise semantic
      confidence or edge stability by itself.
- [ ] MGR uses bounded selected AG subgraphs, records derivation provenance,
      emits hypothetical TTL-bound artifacts.
- [ ] Task-switch tests cover continuation, A→B, A→B→A, shared constraints,
      false switches, compaction, session cleanup.
- [x] Adapter-local disclosure/continuation caches
      migrated or removed (no permanent compatibility layers).

## Implementation lineage

- **Introduced** (core runtime): protocol v9 session AG RPC, projection registry,
  Pi tool/Task Board ingestion — commit `e03150c` (partial), consolidated in the
  initial `SessionActiveGraphRuntime`.
- **Later hardening:** bounded task-frame/cooling lifecycle, branch ownership,
  resident item/character budgets and TTL artifacts. Current source/tests above
  establish those boundaries; a single combined semantic/observation budget and
  full reasoning integration remain acceptance gaps.
