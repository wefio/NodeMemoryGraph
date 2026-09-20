# Session-owned Active Graph runtime

[中文](2026-08-29-session-active-graph-runtime.zh-CN.md)

**Status:** implemented
**Approved:** unrecorded
**Relates to:** [Session AG runtime blueprint](../../design/session-active-graph-runtime-design.md)

## Problem

NMG used "Active Graph" for a query-scoped retrieval result while the Pi adapter separately kept a
flat `SessionRuntimeAg` for recent tool state. The two structures served different parts of working
memory, duplicated lifecycle logic, and left the task-state term in `AG_t = Project(STG, LTG, q_t,
task_t)` without a stable runtime owner. `activeGraphId` also named the retrieval trace, so a mutable
working graph and an immutable exposure record could not be distinguished.

Hierarchical Activation (HA) and the Memory-Graph Reasoner (MGR) already provided candidate
activation and graph traversal primitives, but they remained beside the runtime rather than operating
on one bounded working graph.

## Decision

AG is a **session-owned, mutable, memory-resident runtime graph**. It is the only working-memory
container, but it remains non-authoritative: durable truth and provenance stay in STG/LTG, and AG
disappears when its owning session is released.

AG holds task frames, STG/LTG references, bounded tool observations, temporary relations, unresolved
working state, reasoning artifacts, activation metadata, and a disclosure ledger. It may keep one
active task frame and a small bounded set of cooling frames, so a task switch does not destroy state
and a return does not require reconstructing everything from the transcript.

Each model-visible retrieval freezes an immutable `ProjectionRevision` from the mutable AG. Four
identities are kept distinct:

- `agId`: the session working graph;
- `taskFrameId`: one semantic task partition inside AG;
- `projectionId`: one immutable selection/disclosure/feedback boundary;
- `boardChannelId`: a Task Board coordination channel.

The update is:

```text
candidates_t = Project(STG, LTG, q_t, TaskBelief_t)
AG_(t+1) = Update_B(AG_t, candidates_t, observations_t, TaskBelief_t)
Projection_t = Freeze(VisibleSubset(AG_(t+1)))
```

`B` is a hard total budget over nodes, edges, evidence, tokens, graph depth, temporary observations,
reasoning steps, task frames, and latency. HA scores activation, cooling, reactivation, and budget
allocation. MGR may traverse the selected AG subgraph and emit bounded hypothetical nodes or
reasoning edges. HA can then rescore those artifacts before a projection is frozen.

AG has three typed edge layers which must not silently reinforce each other:

1. semantic edges referenced from STG/LTG;
2. activation/attention edges produced by HA;
3. hypothetical reasoning/operator edges produced by MGR.

Activation is not truth, and an MGR result is not a memory write. MGR artifacts start as attributed,
TTL-bound hypotheses and can reach STG/LTG only through a separate verified or explicit `remember`
path. Persistent HA/MGR model weights, if later justified, live in versioned controller/Lab state
rather than AG.

The query-scoped `ActiveGraph` became a projection revision, the Pi adapter's flat `SessionRuntimeAg`
was removed, and the injection window moved into the AG disclosure ledger. The APIs of the day were
implementation evidence, not compatibility requirements for the target design.

The criteria this decision set, each one a requirement on the runtime and its host wiring:

- the normative design distinguishes AG, task frame, projection revision, and Task Board channel
  identities;
- AG is memory-resident and session-owned; no AG content is persisted as authoritative semantic
  memory;
- a projection revision freezes exact model exposure and supports later exact get, attribution,
  verified outcomes, and replay after AG mutation;
- tool observations and retrieved semantic references share one total AG budget without becoming
  durable writes;
- HA fast state is isolated by session/branch; its activation cannot increase semantic confidence or
  edge stability by itself;
- MGR uses only bounded selected AG subgraphs, records derivation provenance, and emits hypothetical
  TTL-bound artifacts;
- task-switch tests cover continuation, A-to-B switch, A-to-B-to-A return, shared constraints, false
  switches, compaction, and session cleanup;
- the query-scoped AG, the Pi runtime AG, and the continuation map are migrated or removed rather
  than kept as permanent compatibility layers.

## Alternatives considered

1. **Keep query-scoped AG and add a separate task-state manager.** This is the smallest
   implementation change but retains two working-memory containers and makes compaction/task-return
   behavior adapter-specific.
2. **Persist AG as a third semantic graph.** Rejected because temporary activation, tool state, and
   hypotheses would become confused with durable memory and shared truth.
3. **Make MGR or HA own working memory.** Rejected because scoring and reasoning engines should
   remain replaceable capabilities; neither should own evidence, session lifecycle, or disclosure
   provenance.
4. **Treat the entire session as one task.** Rejected because topic drift causes contamination and
   repeated query hashes provide a poor estimate of independent tasks for stability learning.

## Consequences

- The runtime that carries this decision is `src/core/session-active-graph.ts`: one active frame plus
  a bounded cooling set, frame-local parent chains, a unified item/character budget across all
  frames, `ttlMs` on artifacts, and the disclosure ledger a host writes with `markDisclosed`.
- The three compatibility layers the decision named are gone. The Pi adapter's runtime AG was
  removed, the continuation map no longer exists, and the query-scoped AG is now the projection
  revision; the identity collision the problem statement named is resolved by the four identities.
- Which capability stands where, and how each criterion maps to code, is owned by the
  [runtime blueprint](../../design/session-active-graph-runtime-design.md) §4; this record does not
  restate that status table.
- The disclosure ledger is host-neutral: the Pi extension, the Claude plugin, WorkBuddy and DSH mark
  a projection through the runtime instead of keeping an injection window of their own, so a host that
  kept one would be a second home for the same rule.

## Deferred

- The full multidimensional shared account (blueprint 4.3): the runtime bounds items and characters
  across all frames, and the semantic/tool/reasoning account as one ledger remains open.
- Automatic MGR admission (blueprint 4.4): the runtime primitive for TTL-bound, attributed artifacts
  is implemented; admitting MGR output without an explicit act remains deferred.
- HA admission and rescoring on AG (blueprint 4.6): intentionally deferred until natural-utility
  evidence exists; explicit Lab invocation and its isolation remain available.
