# Memory Graphs: STG / LTG / AG

[中文](memory-graphs.zh-CN.md) · [Terms used](memory-graphs.terms.yaml)

**Status:** current
**Updated:** 2026-10-16
**Related:** [Design baseline](design.md), [STG shared store](stg-shared-store-v2-2026-08-12.md), [Session AG runtime](session-active-graph-runtime-design.md), [Tiered disclosure](tiered-disclosure-design.md), [Edge activation](edge-activation-design.md)

Use this lifecycle reference to distinguish provisional memory, durable truth and
session working context. Implementation owners separate existing mechanisms from
targets; a consolidation proposal is not a shipped default.

## Read by task

| Question | Entry |
| --- | --- |
| What is private, durable or currently visible? | [The three graphs](#the-three-graphs) |
| Where does a new candidate belong? | [STG](#stg-provisional-memory) |
| Which structure may become durable? | [LTG](#ltg-durable-memory) and [promotion](#promotion-and-demotion) |
| What is the difference between AG and a retrieval result? | [AG and projection revisions](memory-graphs/session-runtime-graph-and-projection-revisions.md) |
| What is implemented or still deferred? | [Implementation state](#implementation-state) and its owning contracts |

## The three graphs

| Graph | Semantic ownership | Content | Lifetime |
| --- | --- | --- | --- |
| **STG** | Private provisional content for one Agent session | New, task-local or not-yet-consolidated information | Session; expiry is policy, not a requirement for RAM-only storage. |
| **LTG** | Shared authoritative semantic memory | Durable atoms and consolidated structure | Persistent. |
| **AG** | One Agent session; non-authoritative | Mutable, budget-constrained STG/LTG references, frames, observations, activation and temporary reasoning | Live graph is memory-resident and released with the session. |

AG is not a third shared or authoritative semantic store. Agents do not publish
private AG/STG content by merely activating or retrieving it. Durable sharing
requires admitted LTG writes; temporary coordination uses the separate Task Board,
whose views enter each caller's private AG. Frozen projection revisions identify
particular retrieval/disclosure surfaces; they are not the mutable AG itself.

The current STG storage implementation uses one SQLite file per `projectDir`,
`<project>/.nmg/stg.sqlite`. Provisional rows carry the owning `sessionId`;
`cached_from_ltg` rows with a null session are shared project hints, not another
shared truth source. This physical sharing does not make provisional memories
cross-session visible. [The shared-store owner](stg-shared-store-v2-2026-08-12.md)
and `src/core/stg.ts` / `src/cli/service.ts` own that boundary.

The following is the lifecycle model, not an inventory proving all integrations:

```text
HistoryRecord
  - immutable evidence during normal maintenance
  - stable session/message/tool source identity
  - exact content and timestamp
       | mandatory provenance
       v
Semantic memory store
  |- STG
  |    - provisional/task-local MemoryRecord and MemoryNode
  |    - observed/candidate relations and pending structure
  |    - persistent when crash recovery is required; short-term is a
  |      semantic lifecycle, not necessarily volatile RAM
  |
  `- LTG
       - durable atomic fact | state | event | preference | constraint
       - consolidated strategy | derived concept | typed relation
       - stable semantic addresses and bounded leaf/block hierarchies

STG + LTG + current query/task belief + tool observations
       |
       | budgeted selection, update, activation and temporary reasoning
       v
Session Active Graph (mutable, memory-resident, non-authoritative)
  - bounded task frames, selected references and local evidence content
  - temporary tool state, activation edges and reasoning artifacts
  - total token/node/edge/depth/reasoning/task/latency budget ledger
       |
       | freeze visible subset
       v
ProjectionRevision
  - immutable selection/disclosure/feedback boundary

Task Board (shared coordination, not a memory graph)
  - task-scoped attributed goals, blockers, results, handoffs, and decisions
  - cursor reads, TTL expiry, explicit resolution
  - never enters LTG search; each caller receives a private AG projection
```

STG/LTG residence selects provisional or durable semantic lifecycle, not RAM
versus disk. AG maintains the current working graph; a projection selects a
visible surface. Activation records current use; stability governs consolidation.
Residence, activation and consolidation are separate decisions.

## Theoretical lineage

[Theoretical lineage](memory-graphs/theoretical-lineage.md) owns the comparisons
with classical and modern memory theories. Analogies explain choices; they do
not prove an implementation or authorize promotion.

## STG: provisional memory

New candidates enter STG unless a governed rule admits a durable atom immediately:

```text
HistoryRecord
  -> governed extraction
  -> STG semantic inbox
       |- confirmed durable atom -> admit to LTG with provenance
       |- high-confidence match  -> attach to an existing STG/LTG node
       |- explicit new concept   -> create provisional STG node
       `- ambiguous              -> remain searchable and unassigned
```

- Confirmed user facts, preferences, constraints, replaceable states, explicit
  remember requests and tool-verified facts may use governed immediate atomic
  admission. This does not automatically admit speculative structure.
- Co-occurrence-, reasoning- or single-task-derived relations stay observations
  or candidates until structural consolidation criteria are met.
- Provisional records and isolated nodes remain eligible for FTS, exact, recency
  and optional vector retrieval. Traversal expands candidates; it is not the only
  entry point. Searchability remains subject to the session boundary below.
- Persistence in SQLite supports recovery and continuity. Expiry remains policy.
  One successful action is an event or provisional strategy, not evidence of a
  general strategy; consolidation needs independent outcome-linked episodes.

### Isolation

“Global” STG retrieval means all admitted retrieval modes within the owning
session, not access to another session's provisional rows. A multi-Agent harness must supply non-forgeable runtime/session identity
(`runtime_id`, `session_id` in the logical model). Search, exact access, every
provisional row, temporary edge, AG trace and feedback event must honor that
ownership. `semantic_task_id` deduplicates evidence; it is not an isolation key.

Current isolation is row-level in the project STG file, not session-specific
physical databases. The daemon applies the caller's session filter and admits
shared LTG-cache hints separately. Authentication of the claimed session remains
with the trusted harness/client boundary; filtering is not identity issuance or
database-kernel row-level security. Tests exercise separate sessions through the
daemon and adapters; they do not prove resistance to a malicious trusted caller.

### STG vs index Delta

STG tracks provisional meaning; index `Inbox/Delta` tracks records whose derived
leaf/vector index is not yet compacted. A durable memory can be in Delta, and a
short-term memory can already have a compacted index. Semantic lifecycle and
index maintenance are orthogonal.

## LTG: durable memory

LTG holds durable facts, states, events, preferences and constraints, together
with admitted strategies, concepts and typed relations. It need not be connected:
unrelated projects, people, preferences or topics may remain separate components.

Three link classes have different admission rules:

1. **Provenance:** immediate and mandatory; each memory reaches its exact source.
2. **Deterministic identity:** immediate when known, such as explicit scope,
   matching `stateKey + scope` or supported supersession.
3. **Inferred semantics:** delayed; `related_to`, causality, dependency and
   merge/split proposals need accumulated evidence or explicit confirmation.

General semantic relations may cycle; derivation and supersession dependencies
must remain acyclic. Bounded query expansion uses a visited set and may form a
local DAG even over a cyclic persistent graph. An isolated node may later become
an alias, be refined or linked, or remain isolated. Adding a relation does not
merge identity; [edge activation](edge-activation-design.md) owns that distinction.

## AG: session runtime graph and projection revisions

[The AG reference](memory-graphs/session-runtime-graph-and-projection-revisions.md)
owns budgets, projections, disclosure and trace limits. `agId`, `taskFrameId`,
`projectionId` and coordination-channel identity are distinct; `boardChannelId`
is the design name, while board APIs select it through `taskId`. Runtime core
exists; combined budgets, semantic switching and reasoning integration remain
partial.

## Promotion and demotion

Distinguish residence changes inside a store from cross-store consolidation.
Within-store `promoteMemory` / demotion preserves record identity and provenance.
The project STG and authoritative LTG are separate databases:
`consolidateStgMemoryToLtg` materializes or deduplicates an LTG record through
`remember`, retaining evidence and a `consolidated_from_stg` marker with
`attributes.sourceMemoryId`. It does not promise the same record/node ID in both
stores.
Cached LTG hints cannot be consolidated back into LTG. These are the current
`src/core/stg.ts` boundaries, not permission to copy provisional material freely.
Demotion/expiry does not rewrite the underlying historical evidence.

The consolidation design raises the promotion threshold with scope breadth and
influence: session/task < project/workspace < user < team/organization;
interaction hint < reasoning context < scoped constraint. Wider or more
behavior-changing material needs stronger independent evidence/provenance and an
explicit correction/rollback path.

A local structure is eligible only with sufficient independent evidence,
usefulness, consistent scope, provenance coverage and stability, and sufficiently
little unresolved conflict. The symbolic model is not a calibrated default:

```text
consolidate(G') iff
  stability(G')       >= high_threshold
  independent_tasks   >= min_tasks
  evidence_coverage   >= min_coverage
  observed_utility    >= min_utility
  unresolved_conflict <= max_conflict
```

Hysteresis separates promotion from lower demotion/reopen thresholds to avoid
oscillation. Operations are versioned, auditable and preserve evidence; semantic
projections must remain rebuildable for reversal. Atomic admission is separate:
a clear durable atom can enter LTG immediately, while new structure, aggregated
strategies and merges/splits require the stronger process.

## Information-theoretic interpretation

The codec analogy explains the design; it is not a literal implementation claim:

```text
Historical stream       information source
Memory extraction       source encoder into STG
LTG nodes/relations     consolidated semantic codebook
Node/leaf headers       progressive access codes
SQLite/index            storage channel
Query/current context   decoder side information
Active Graph builder    query-conditioned decoder
Raw evidence            lossless fallback and error check
```

STG retains provisional symbols before structural coding stabilizes; LTG is the
consolidated codebook; AG decodes a bounded working set for the task. Headers are
lossy access codes, relations supply side information, and raw history preserves
the fallback. Structural change must reduce expected retrieval distortion enough
to justify complexity/maintenance: a rate-distortion objective, not measured
quality improvement merely from this analogy.

## Implementation state

The owning contracts distinguish implementation from targets:

| Surface | Current boundary and owner |
| --- | --- |
| Residence, atomic writes, expiry and history | Explicit STG/LTG residence, governed atomic admission and append-only evidence belong to core store contracts; cross-store consolidation has the exception above. |
| Physical STG | [Shared-store v2](stg-shared-store-v2-2026-08-12.md): project file, session row filtering, LTG-cache hints and session cleanup; not private files per session. |
| Session graph and immutable projections | [Runtime blueprint](session-active-graph-runtime-design.md): existing session graph, four identities, frames, bounded items, freeze/provenance, release and host-neutral disclosure. Existing `ActiveGraph` retrieval objects represent projections, not the session container. |
| Working state | [State-space contract](state-spaces.md): `nmg_state` is the normal AG/board entry. Existing internal lease/RPC compatibility does not make daily state a model-facing Lab operation. |
| Tiered access and budgets | [Tiered disclosure](tiered-disclosure-design.md): deterministic sequential disclosure/deep evidence/ledger. Natural calibrated SPRT and promotion of a learned budget into Lite default remain separate evidence gates. |
| Edge mechanics | [Edge activation](edge-activation-design.md): typed bounded propagation, fan dilution, regulatory channels, traces and outcome-linked updates. Learned direction, unlearning and automatic compression need their own maturity/evidence interpretation. |
| Coordination | [Task Board](memory-graphs/session-runtime-graph-and-projection-revisions/shared-task-board.md): task isolation, attribution, cursors, TTL, resolution/leases, private projection and optional wakes/world discovery. ACLs/multi-device transport are not implied. |

LTG-only L4 Dormant/Unindexed and L5 Quarantine, Pi identity propagation and
turn-end expiry/rebalance do not establish whole-graph integration.
[Runtime acceptance gaps](session-active-graph-runtime-design.md#acceptance-criteria-from-the-decision)
include combined semantic/observation budgets, full switch/restoration coverage
and bounded reasoning integration. The Lab AG-budget boundary defaults to
`shadow`; explicit Lab enablement is not natural calibration or Lite promotion.

## Open questions

1. How should STG retention/expiry/demotion priors preserve useful provisional
   meaning without becoming an unbounded archive?
2. How should one total token/node/edge/evidence/frame/reasoning/hop/tier budget
   be allocated across natural work?
3. What independent natural contradiction/reversal evidence calibrates LTG
   relation demotion/reopen hysteresis?
4. Is scheduled STG replay actionable or only an analogy for thresholds?
5. Which deterministic switch baseline is enough before learned activation, and
   how many cooled frames provide positive marginal value?
