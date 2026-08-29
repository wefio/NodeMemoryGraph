# Session-owned Active Graph runtime

[中文](2026-08-29-session-active-graph-runtime.zh-CN.md)

**Status:** proposed
**Date:** 2026-08-29

## Problem

NMG currently uses "Active Graph" for a query-scoped retrieval result while the
Pi adapter separately keeps a flat `SessionRuntimeAg` for recent tool state. The
two structures serve different parts of working memory, duplicate lifecycle
logic, and leave the task-state term in `AG_t = Project(STG, LTG, q_t, task_t)`
without a stable runtime owner. `activeGraphId` also names the retrieval trace,
so a mutable working graph and an immutable exposure record cannot be
distinguished.

Hierarchical Activation (HA) and the Memory-Graph Reasoner (MGR) already provide
candidate activation and graph traversal primitives, but they remain beside the
runtime rather than operating on one bounded working graph.

## Proposal

Redefine AG as a **session-owned, mutable, memory-resident runtime graph**. It is
the only working-memory container, but it remains non-authoritative: durable
truth and provenance stay in STG/LTG, and AG disappears when its owning session
is released.

AG contains task frames, STG/LTG references, bounded tool observations,
temporary relations, unresolved working state, reasoning artifacts, activation
metadata, and a disclosure ledger. It may keep one active task frame and a
small bounded set of cooling frames so a task switch does not destroy state and
a return does not require reconstructing everything from the transcript.

Each model-visible retrieval freezes an immutable `ProjectionRevision` from the
mutable AG. Use four distinct identities:

- `agId`: the session working graph;
- `taskFrameId`: one semantic task partition inside AG;
- `projectionId`: one immutable selection/disclosure/feedback boundary;
- `boardChannelId`: a Task Board coordination channel.

The target update is:

```text
candidates_t = Project(STG, LTG, q_t, TaskBelief_t)
AG_(t+1) = Update_B(AG_t, candidates_t, observations_t, TaskBelief_t)
Projection_t = Freeze(VisibleSubset(AG_(t+1)))
```

`B` remains a hard total budget over nodes, edges, evidence, tokens, graph
depth, temporary observations, reasoning steps, task frames, and latency. HA
scores activation, cooling, reactivation, and budget allocation. MGR may
traverse the selected AG subgraph and emit bounded hypothetical nodes or
reasoning edges. HA can then rescore those artifacts before a projection is
frozen.

AG has three typed edge layers which must not silently reinforce each other:

1. semantic edges referenced from STG/LTG;
2. activation/attention edges produced by HA;
3. hypothetical reasoning/operator edges produced by MGR.

Activation is not truth, and an MGR result is not a memory write. MGR artifacts
start as attributed, TTL-bound hypotheses and can reach STG/LTG only through a
separate verified or explicit `remember` path. Persistent HA/MGR model weights,
if later justified, live in versioned controller/Lab state rather than AG.

Current query-scoped `ActiveGraph` objects become projection revisions. Pi's
flat `SessionRuntimeAg` becomes a short event-ingestion adapter or is removed
after tool observations enter the shared session AG. The injection window moves
into the AG disclosure ledger. Current APIs remain implementation evidence, not
compatibility requirements for the target design.

## Alternatives considered

1. **Keep query-scoped AG and add a separate task-state manager.** This is the
   smallest implementation change but retains two working-memory containers and
   makes compaction/task-return behavior adapter-specific.
2. **Persist AG as a third semantic graph.** Rejected because temporary
   activation, tool state, and hypotheses would become confused with durable
   memory and shared truth.
3. **Make MGR or HA own working memory.** Rejected because scoring and reasoning
   engines should remain replaceable capabilities; neither should own evidence,
   session lifecycle, or disclosure provenance.
4. **Treat the entire session as one task.** Rejected because topic drift causes
   contamination and repeated query hashes provide a poor estimate of
   independent tasks for stability learning.

## Acceptance criteria

- The normative design distinguishes AG, task frame, projection revision, and
  Task Board channel identities.
- AG is memory-resident and session-owned; no AG content is persisted as
  authoritative semantic memory.
- A projection revision freezes exact model exposure and supports later exact
  get, attribution, verified outcomes, and replay after AG mutation.
- Tool observations and retrieved semantic references share one total AG budget
  without becoming durable writes.
- HA fast state is isolated by session/branch; its activation cannot increase
  semantic confidence or edge stability by itself.
- MGR uses only bounded selected AG subgraphs, records derivation provenance,
  and emits hypothetical TTL-bound artifacts.
- Task-switch tests cover continuation, A-to-B switch, A-to-B-to-A return,
  shared constraints, false switches, compaction, and session cleanup.
- Current query-scoped AG, Pi runtime AG, and continuation-map behavior are
  migrated or removed rather than kept as permanent compatibility layers.

## Risks

- Task over-segmentation can break causal continuity; under-segmentation can
  retain irrelevant state.
- HA and MGR can form a self-reinforcing loop if activation, reasoning, semantic
  confidence, and stability are not kept as typed channels.
- Mutable session state complicates concurrency, branch ownership, cleanup, and
  deterministic replay.
- Multiple cooling task frames can consume prompt and memory budgets without
  measurable benefit.
- Migrating adapters before the shared runtime exists can create more duplicate
  implementations. The core session AG and projection contract must land before
  host-specific wiring.
