# AG: session runtime graph and projection revisions

[中文](session-runtime-graph-and-projection-revisions.zh-CN.md) · [Terms used](session-runtime-graph-and-projection-revisions.terms.yaml)

**Authority:** [Memory graphs](../memory-graphs.md).

## AG: session runtime graph and projection revisions

Use this reference to distinguish session working memory, frozen retrieval
projections and persistent evidence. The update model is:

```text
candidates_t = Project(STG, LTG, q_t, TaskBelief_t)
AG_(t+1) = Update_B(AG_t, candidates_t, observations_t, TaskBelief_t)
Projection_t = Freeze(VisibleSubset(AG_(t+1)))
```

`B` is the target hard multidimensional budget over injected tokens, nodes,
edges, records/evidence, temporary observations, frames, reasoning steps,
local tier/depth, expansion and latency. A small final projection does not
justify an unbounded construction process. The
[runtime blueprint](../session-active-graph-runtime-design.md) separates existing
bounds from the still-open combined semantic/observation budget.

AG may hold resident critical LTG constraints, newly active STG observations and
task state, retrieved LTG references/bounded content, selected persistent
relations, temporary STG/LTG/query-local relations, tool observations, unresolved
working state, activation metadata and hypothetical reasoning. One active task
frame and a bounded cooling set partition that work.

Update is working-memory management, not copying an authoritative graph: identify
candidates, update the proper frame, allocate budget and freeze one immutable
revision. The model may request expansion; the harness enforces budgets and
provenance. `ProjectionRevision` is the design name. The concrete runtime exposes
`SessionActiveGraphProjection`; the legacy `ActiveGraph` retrieval object is not
the mutable session container. `agId`, `taskFrameId` and `projectionId` are
separate runtime identities. The design's coordination `boardChannelId` is
selected through `taskId` in board APIs, not through an AG frame.

Pi also bounds per-turn construction: at most three searches and five total
search/get calls, exact-evidence progression after two searches, and stopping
after two consecutive searches add no candidate IDs. Counters reset on a new
user turn and remain hard limits outside learned/QPP allocation.

### Maintained working state

One replaceable provisional `working_state` lives in each frame's existing items.
Use the normal [state-space entry](../state-spaces.md), `nmg_state` with `space=ag`:
explicitly enable the session writer lease before replace/clear. Daily state is
not a model-facing Lab operation. Internal legacy lease/RPC compatibility remains;
[the state-entry decision](../../decisions/implemented/2026-10-12-state-space-entry.md)
owns that migration.

Dedicated replace/clear preserves exact content; ordinary `observe` cannot write
this kind. Blank, stale, secret, oversized or capacity-rejected writes preserve
the old value. State consumes the shared resident cap and is protected from
ordinary-item eviction; clear, frame/session eviction or release removes it.
Disable/lease expiry removes write permission, not text. Captured bindings fence
late writes, not authenticate identity or certify facts/acceptance.

Adapters use an explicit session working frame while enabled, not query hashes
or board channels as semantic task identity. Host/provider exposure confirmation,
semantic switch/restoration, multidimensional AG construction budgets and matched benefit
remain separate. [The state decision](../../decisions/implemented/2026-10-08-ag-working-state.md)
owns mutation semantics; [carriage](../../decisions/implemented/2026-10-08-ag-working-state-input.md)
owns Pi's per-user-turn input path. Clearing/releasing live AG is not deletion of
previously persisted host messages or evidence traces.

### Disclosure and attribution

AG holds references/runtime annotations, not authoritative copies. Turns and
compaction may change it; release destroys the live graph. Explicitly admitted
writes, recorded outcomes and persistent traces have separate lifetimes.

The daemon-owned disclosure ledger stores memory ID, content hash, greatest
rendered depth and turn. With daemon defaults, unchanged content already rendered
deeply enough folds to `already_in_context` within twelve turns. Deeper requests,
changed evidence, window expiry or another session render it again. The default
cap is 128 references; the ledger clears when compaction removes context and disappears at session
shutdown. It is context-cache metadata, not a verified usage outcome. Pi, DSH,
WorkBuddy and MCP share that ledger with host-specific rendering; ledger failure
reveals the requested evidence rather than silently hiding it.

Persistent traces carry their owning harness `sessionId`. Public trace reads,
disclosure, diagnostics and verified feedback must carry the matching caller
identity; cross-session access is rejected before learning/stability updates.
Trusted library lookup is not authentication. Protocol v9 distinguishes session
`agId` from immutable `projectionId`; public `activeGraphId` names that projection
and resolves to one or more persisted retrieval traces.

An identity-bound `nmg_get` records observable exact expansion. Automatic recall
and answer overlap are diagnostic exposure, not causal-use evidence. Admitted
user/tool/task/benchmark outcomes follow the claim-outcome contract, not an
inference from retrieval, silence or task success alone. User/tool excerpts and
task lineage remain independently attributable; benchmark signals are not
model-invented votes. Pi's `session_before_compact` clears disclosure so removed
evidence can render again.

### Shared Task Board (cross-Agent coordination, not a memory graph)

[The Task Board owner](session-runtime-graph-and-projection-revisions/shared-task-board.md)
defines shared coordination, private projection and collaboration authority. It
is not another memory graph or an alternate way to publish private AG content.

### AG lifecycle: mutable in memory, revision trace persistent

The live AG is mutable and session-resident. Immutable projection observations
persist separately: selection, rendering, expansion, exact fetch, diagnostic
answer matching and independently supported/contradicted outcomes are different
stages. An API/answer overlap does not prove causal use. Traces can inform
persistence decisions under admission rules; active content is only a candidate
signal, not persistence itself.

```text
STG + LTG ──update──▶ session AG (mutable, memory-resident)
                            │ freeze visible subset
                            ▼
                    ProjectionRevision
                            │ render / expand / nmg_get / verify
                            ▼
                    observation trace (persistent)
                            │ dedupe by session/task/source lineage
                            │ + outcome attribution
                            ▼
                 persistence decision: promote LTG / demote / keep
                            │
                            └────────── updates LTG ──▶ next projection
```

- Activity alone never promotes or raises stability. Deduplicate by
  session/task/source lineage and require outcome attribution. Activation plus
  independent cross-task reuse and a positive outcome is a promotion candidate,
  not automatic admission.
- Inactivity can nominate material for L4/L5 retention review alongside
  `access_count` and `importance`; it is a signal, not an independent deletion
  authorization.
- CLS replay is a mechanism-level analogy for using selected traces in
  consolidation, not proof that automatic hippocampal-style replay is deployed.
  [Promotion rules](../memory-graphs.md#promotion-and-demotion) still apply.

#### Resident critical constraints: theoretical candidates

A target resident set would enter each projection. These are candidate rationales,
not adopted default selection policies:

- The intention-superiority effect (Goschke & Kuhl 1993; Marsh et al. 1999,
  PMID 10226441) motivates activation for unfinished intentions and inhibition
  after fulfillment. It suggests residency and post-satisfaction demotion; it
  does not prove NMG has calibrated either.
- MemGPT's self-edited always-in-context core block is an engineering precedent
  for a small resident set, not an NMG dependency.

The open proposal uses explicit `pinned` / `safety_constraint` markers and counts
resident content against budget, allocating it before discretionary content.
How the set is maintained remains unresolved.

#### Filter usage: a cross-cutting trace field

Instrumented retrieval paths may record optional `RetrievalTraceInput.filterUsage`;
`src/core/types.ts` owns the type. Illustrative numbers, not an observed run:

```json
{
  "dimensions": ["scope.project"],
  "candidatesBefore": 10,
  "candidatesAfter": 4,
  "selectivity": 0.6
}
```

`candidatesBefore` counts returned SQL candidates before post-filtering;
`candidatesAfter` counts survivors before the final result limit. Sorting does
not change that cardinality. `selectivity` is `1 - after/before`, or zero when
there are no candidates. These are not SQLite's internal rows-scanned count,
measured latency or guaranteed pushdown savings. Absent/legacy telemetry is not
a measured zero. `src/core/store/retrieval.ts` owns the measurement boundary.

One record can support several consumers; the table describes intended uses,
not proof that every consumer is integrated:

| Consumer | Question |
| --- | --- |
| Index decision | Does use × selectivity × latency share justify an index? |
| Budget projection | Can smaller filtered pools tighten an admitted budget? |
| QPP calibration | Do scope-specific score distributions need different thresholds? |
| Router learning | Which scope/filter context is a routing signal? |
| Retention | Does missing demand nominate a scope for review, without authorizing deletion? |
| Agent feedback | Would an explicit scope narrow this query? |

The index-decision sketch in [improvement areas](../improvement-areas.md) owns that
proposal. Potential consumption is not current default policy or an index mandate.

### Shared information-output boundary

AG and Task Board share source-bound typed views and pure output preparation,
not storage, graph identity or collaboration authority. Preparation keeps the
body/required labels together, reports omissions and cannot commit a disclosure
ledger. Matching fragments yield reader-local acknowledgement candidates; another
session cannot confirm private AG content. View fingerprints neither replace
immutable retrieval projections nor attest truth.

The [shared-output foundation](../../decisions/implemented/2026-10-07-shared-information-output.md)
owns the library/text boundary. Maintained state, Pi carriage and grouped context
output budgeting are implemented slices; [state spaces](../state-spaces.md) owns
current input composition. Final exposure/authorization confirmation and matched
cost/quality evidence remain open. Output preparation neither confirms final
provider input nor completes the multidimensional AG construction budget.

### Projection lifecycle and the tiered disclosure design

[Tiered disclosure](../tiered-disclosure-design.md) is the time dimension of
projection construction: tiers open sequentially, expose `tiersOpened`, and
`nmg_get` explicitly unlocks deep evidence. [Edge activation](../edge-activation-design.md)
owns within-AG mechanics: node activation is state, edge activation derives from
it, and budgets apply after bounded propagation. Neither mechanism makes
activation a durable truth signal.
