# Session AG update and projection revisions

[中文](session-ag-and-projection-revisions.zh-CN.md) · [Terms used](session-ag-and-projection-revisions.terms.yaml)

**Authority:** [Parent scope](../active-graph-activation-and-consolidation.md).

## Session AG update and projection revisions

For query `q_t`, current task belief `TaskBelief_t`, and bounded runtime
observations `O_t`, NMG targets:

```text
candidates_t = Project(STG, LTG, q_t, TaskBelief_t)
AG_(t+1) = Update_B(AG_t, candidates_t, O_t, TaskBelief_t)
Projection_t = Freeze(VisibleSubset(AG_(t+1)))
```

`AG_t` is mutable but session-owned and memory-resident. `Projection_t` is
immutable and records exactly what the model could see. `B` is one hard
multidimensional budget over injected tokens, nodes, edges, records/evidence
excerpts, temporary observations, task frames, reasoning steps, local
tier/depth, graph expansion, and latency. AG may contain:

- resident critical LTG constraints;
- newly active STG observations and task state;
- retrieved LTG nodes and bounded local content;
- selected persistent relations;
- temporary STG-to-LTG, LTG-to-LTG, or query-local relations used only for the
  current task;
- bounded harness-local tool observations that remain virtual and session-owned;
- one active task frame and a small bounded cooling set, allowing task return
  without retaining an unbounded transcript.

Identity is explicit rather than overloaded: `agId` owns the session runtime,
`taskFrameId` partitions semantic work inside AG, `projectionId` names one
immutable exposure/feedback boundary, and `boardChannelId` names a Task Board
coordination channel. Current `activeGraphId` and query-hash `taskId` behavior is
implementation evidence to migrate, not a compatibility constraint.

AG can act as one Agent's **private working blackboard**, but cannot itself
communicate across Agents. When coordination is required, Agents use the independent
task-scoped **Task Board** in the daemon. Its attributed, expiring entries are
read through a task-local cursor and projected into each caller's private AG.
They are never inserted into memory records, FTS, embeddings, QPP, or LTG search.
An Agent may separately admit a supported durable conclusion through `remember`.

```text
Agent A private AG ─┐
                    ├─ read/write ─ Task Board(taskId, cursor, TTL)
Agent B private AG ─┘                       │
                                           └─ explicit remember only ─▶ STG/LTG
```

**Implementation status:** the daemon owns the bounded, memory-resident session
AG registry. Every service search freezes a distinct `projectionId` while
retaining a stable session `agId`, monotonic projection sequence, `taskFrameId`,
parent revision, and persisted retrieval `traceIds`. `get`, diagnostic
attribution, and claim outcomes resolve the projection to its owning traces and
reject cross-session use. Pi tool and Task Board observations enter the shared
runtime through `sessionActiveGraph`; compaction activates temporary state and
clears the content-disclosure ledger, while session shutdown releases the AG.
Pi, DSH, WorkBuddy and MCP use that daemon ledger for bounded content-hash/depth
folding instead of adapter-local injection caches. Explicit task frames, bounded
cooling and frame-local parent chains are implemented; reliable **automatic
semantic** task-frame classification remains open and must not be inferred from
the current query-derived task identifier.

The shared Task Board is implemented in SQLite and
exposed by daemon RPC and CLI (`nmg board put/read/resolve`). Adapters expose the
`nmg_state` board operations and wake polling by default; false-like
`NMG_ENABLE_COORDINATION` values suppress board operations, not private AG state.
It records `agentId` and source session, supports task
isolation, cursor reads, TTL deletion, and explicit resolution. Ordinary Pi reads stage open entries in the caller's daemon-owned session AG
as temporary `board_projection` items; history reads do not stage entries.
Membership/ACLs and remote
multi-device transport are not implemented; local callers sharing the daemon
must agree on a task ID and should set stable `NMG_AGENT_ID` values.

AG and Task Board share admitted information views and pure text preparation
through `core/information-view.ts` and `integration/information-output.ts`.
Domain owners still enforce access and lifecycle. Body plus required labels
are indivisible under the per-surface character budget; private temporary AG
statements are not shortened by a display preview. Long board conventions are
opt-in, and compact reads retain delivery/verdict metadata. Prepared source
fingerprints are not `projectionId`, acceptance, or proof of disclosure. Exact
fragment confirmation returns reader-local candidates only; host-confirmed
ledger commitment remains open. Pi's grouped dynamic context uses the
[shared information-item contract](../../state-spaces.md#unified-context-information-items), including
one combined preparation budget; this does not establish provider-send or cost
confirmation. See the
[foundation decision](../../../decisions/implemented/2026-10-07-shared-information-output.md).

The accepted [state-space entry contract](../../state-spaces.md) directly uses this
view/output foundation for one `state read/write` entry across AG and board
spaces, without merging their owners. Its interface and implementation boundary
are owned by the topic and [interface decision](../../../decisions/implemented/2026-10-12-state-space-entry.md).

The explicitly leased AG working-state writer maintains one exact provisional
text per frame through dedicated `state` replace/clear operations, never ordinary `observe`.
Admission checks the resident cap and prepared-text ceiling before mutation;
ordinary item eviction protects this state, while frame/session eviction and
release remove it. A captured session/AG/frame generation fences late writes,
not caller authentication. Ordinary tools supply only text or empty clear input;
clients attach context metadata outside those model parameters. Current adapters
explicitly use a session working frame while enabled so query changes cannot
move the state. That fallback is not semantic task detection or A→B→A recovery.
Acknowledgements are only updated/unchanged/cleared; no acceptance, durable write,
disclosure or host-history removal follows from the write. Dedicated state input
carriage is a separate shared contract: Pi carries one prepared body per user
turn inside the persisted turn message and registers no per-inference hook, so
nothing is re-sent or reordered inside a turn. Final provider confirmation
remains unsupported; see
[the runtime input owner](../../session-active-graph-runtime-design.md#dedicated-state-carriage)
and the [working-state decision](../../../decisions/implemented/2026-10-08-ag-working-state.md).

The shared Agent policy maintains a compact status anchor for ongoing multi-step
work at meaningful progress, plan or blocker changes, distinguishing verified
completion from implementation and plans. Necessary facts remain recoverable
from repository or explicit shared task references, not only private AG lifetime.
Pi's read-only widget and `/nmg state` sub-command use the existing snapshot/preparation
path, without semantic search or a second store. The widget is a labelled preview;
the command returns complete admitted text. Owner/read failures and obsolete
responses cannot present stale progress as current. Neither user presentation nor
state maintenance commits disclosure or collaboration acceptance. See the
[daily-use decision](../../../decisions/implemented/2026-10-12-working-state-daily-use.md).

AG update is working-memory management, not graph copying. It identifies
candidate nodes, updates task-local runtime state, allocates one total budget,
and then freezes only the visible subset. The model can request progressive
expansion, but the harness enforces both the total AG budget and the immutable
projection/provenance boundary.

The projection budget and the **construction-process budget** are separate.
Bounding the final AG does not prevent an Agent from repeatedly issuing searches
that rediscover the same candidates. The Pi adapter therefore also bounds each
user turn to three explicit searches and five total recall tool calls, permits at
most two searches without an intervening exact-evidence progression, and stops
after two consecutive searches add no candidate IDs. A new user turn resets this
ephemeral guard. These are deterministic harness limits outside QPP and the
differentiable controller; learned allocation may choose a smaller AG but cannot
relax them.
