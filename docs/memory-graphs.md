# Memory Graphs: STG / LTG / AG

**Status:** consolidated design note

Implementation note: isolated STG is wired through the core, daemon, CLI, and
Pi adapter. It is stored per `projectDir + sessionId`; Pi propagates its native
session identity through automatic recall and all three tools.
**Updated:** 2026-08-01
**Related:** [design.md](design.md) §1/§5/§6/§7.1, [tiered-disclosure-design.md](tiered-disclosure-design.md), [edge-activation-design.md](edge-activation-design.md)

This document is the standalone reference for NMG's three-graph model:
the Short-Term Graph (STG), the Long-Term Graph (LTG), and the Active Graph
(AG). It reorganizes the material that lives across design.md §1, §5, §6,
§7.1, and §8, adds the theoretical lineage (which classical and modern memory
theories the model corresponds to), and records the current implementation
state.

## 1. The three graphs

| Graph | Ownership | Content | Lifetime |
| --- | --- | --- | --- |
| **STG** | private to one Agent session | new, provisional, task-local, or not-yet-consolidated semantic information | session; expiry is a policy decision |
| **LTG** | the only shared graph | durable atomic memories and consolidated semantic structure | persistent |
| **AG** | private, per-Agent/per-session | budget-constrained runtime projection from that session's STG and the shared LTG, with optional temporary cross-graph relations | one query/task; released after |

AG is **not** a third authoritative or shared memory graph. It is the private
virtual memory space presented to one model session. Agents never write a
shared AG or STG: collaboration occurs only through admitted LTG memories and
their provenance.

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

STG + LTG + current query/task state
       |
       | budgeted selection and temporary relation construction
       v
Active Graph (virtual, ephemeral)
  - selected nodes, relations, and bounded local record/evidence content
  - temporary cross-STG/LTG edges and query-local reasoning nodes
  - per-projection token/node/edge/depth/latency budget ledger
```

Residence (STG vs LTG) describes persistence; AG describes current
visibility; activation describes current use; stability determines whether
provisional structure should be consolidated. **Residence, activation, and
consolidation are different decisions** (design.md first principle 7).

## 2. Theoretical lineage

The three-graph model is not invented ad hoc: it maps onto classical and
modern memory theories with a long evidence base.

### 2.1 Atkinson–Shiffrin multi-store model (1968)

The three-stage sensory / short-term / long-term store (Atkinson & Shiffrin,
1968) is the structural ancestor:

| NMG | Atkinson–Shiffrin | Notes |
| --- | --- | --- |
| AG | working memory (~20 s, 7±2 chunks) | current task context, limited capacity, attention-gated |
| STG | short-term store | temporary; enters LTM only through consolidation/rehearsal |
| LTG | long-term store | near-unlimited capacity; semantic/episodic/procedural subdivisions |

The A-S point that information enters STM only when attended and reaches LTM
only through consolidation is exactly NMG's governed write path
(section 5 below).

### 2.2 Complementary Learning Systems (McClelland, McNaughton & O'Reilly, 1995)

The deepest mechanism-level correspondence. CLS (Psychological Review 102,
419–457; PMID 7624455) explains *why* two learning systems are needed:

| NMG | CLS | Mechanism |
| --- | --- | --- |
| STG | hippocampus | fast encoding, sparse, temporary, interference-prone |
| LTG | neocortex | slow integration, overlapping, persistent, robust to interference |
| STG→LTG promotion | systems consolidation | hippocampal replay drives cortical integration |

Consequences for NMG design:

- STG→LTG promotion requiring stability thresholds is not arbitrary: CLS
  shows the fast system must not immediately train the slow system, or
  new learning catastrophically interferes with old (catastrophic
  interference is the classic failure of single-learning-rate systems).
- "Repeated co-activation → consolidation" maps to replay-driven cortical
  integration.
- The reason atomic facts may enter LTG immediately (governed promotion)
  while relations must wait matches CLS's distinction between
  instance-level and regularity-level learning.

### 2.3 ACT-R / SOAR cognitive architectures

The AG concept corresponds to the bounded buffers of ACT-R (goal buffer)
and SOAR (working memory) — Laird's 2022 comparison (arXiv:2201.09305)
confirms the common structure: working memory buffers hold the current
retrieval, declarative memory holds facts/experiences, procedural memory
holds skills. NMG's AG is the query-conditioned projection of declarative
memory into a bounded buffer.

### 2.4 Modern agent memory systems (engineering validation)

MemGPT/Letta independently arrived at the same split: core memory (always in
context) ≈ AG, archival memory (vector search) ≈ LTG, recall memory
(conversation history) ≈ evidence store. Mem0/Zep add extraction and graph
construction but remain extract-store-retrieve pipelines without the
provenance/verification layer that is NMG's differentiator.

### 2.5 Boundary notes

- AG is not exactly A-S short-term memory: AG is a *projection from* the
  long-term store conditioned on the query, not a raw capture buffer. The
  closer cognitive analogue is the focus of attention within working
  memory (Cowan's focused-attention view, capacity ≈ 4 chunks) — noted as
  a pointer, not verified in this pass.
- CLS's fast system is prone to forgetting; NMG's STG is a *semantic*
  provisional store, not raw traces. NMG's immutable HistoryRecord layer is
  closer to CLS's episodic traces; STG/LTG are its semantic
  interpretations (design.md §5).

## 3. STG: provisional memory

New semantic candidates first enter STG unless a governed rule can safely
promote the atomic memory immediately:

```text
HistoryRecord
  -> governed extraction
  -> STG semantic inbox
       |- confirmed durable atom -> preserve ID and promote to LTG
       |- high-confidence match  -> attach to an existing STG/LTG node
       |- explicit new concept   -> create provisional STG node
       `- ambiguous              -> remain globally searchable and unassigned
```

- **Immediate promotion path** (atomic content only, no speculative
  structure): confirmed user facts, preferences, constraints, replaceable
  states, explicit remember requests, tool-verified facts.
- **Delayed path** (structure): relations inferred from co-occurrence,
  reasoning, or one task stay in STG as observations or candidates until
  consolidation criteria are met.
- STG records and isolated/provisional nodes participate in global FTS,
  exact, recency, and optional vector search. Graph traversal is a candidate
  expansion mechanism, never the only retrieval entry point.
- STG may be persisted in SQLite for crash recovery and cross-turn
  continuity; **expiry is a policy decision, not an implication that
  short-term data must live only in RAM**.
- A single successful action remains an event or provisional STG strategy
  (design.md §5b); repeated outcome-linked episodes may consolidate.

### Isolation

"Global" means all retrieval modes inside the owning session, not
visibility across sessions. A multi-Agent runtime must carry a
non-forgeable `runtime_id` and `session_id` through search and exact access;
every STG row, temporary edge, AG trace, and feedback event must be filtered
by that identity. A separate `semantic_task_id` deduplicates repeated
evidence across Agents; it must not be used as the isolation identity.
**Current state:** physical session-specific SQLite stores provide isolation.
A session never scans another session's semantic rows; tests cover two
sessions inside one project through both daemon and Pi adapter. Authenticating
a claimed session ID remains a harness security concern, not a memory-row
filter.

### STG vs index Delta

The semantic STG is distinct from the index `Inbox/Delta`. STG tracks memory
lifecycle and provisional meaning; index Delta tracks records whose derived
leaf/vector index has not yet been compacted. A long-term memory may be in
index Delta, and a short-term memory may already have a compacted index.
The two dimensions are orthogonal (design.md §10).

## 4. LTG: durable memory

- Holds durable atomic fact | state | event | preference | constraint,
  consolidated strategy | derived concept | typed relation.
- The semantic graph is not required to be connected; components may
  represent unrelated projects, preferences, people, or topics.
- **Connections in three classes:**
  1. **Provenance links** — immediate and mandatory; every memory reaches
     its exact source.
  2. **Deterministic identity links** — immediate when known (explicit
     scope, matching `stateKey + scope`, supported supersession).
  3. **Inferred semantic links** — delayed (`related_to`, causal,
     dependency, merge, split proposals require accumulated evidence or
     explicit confirmation).
- General semantic relations may cycle; derivation and supersession
  dependencies must remain acyclic. Each query may materialize a bounded,
  visited-set-protected local expansion DAG even when the persistent graph
  contains cycles.
- An isolated node may later be merged as an alias, refined under a parent,
  linked to another concept, or remain isolated. Adding an edge does not
  imply merging node identity (see edge-activation-design.md §4.4 for the
  merge-as-compression view).

## 5. AG: the query-scoped projection

```text
AG_t = Project_B(STG, LTG, q_t, task_t)
```

`B` is a hard multidimensional budget over injected tokens, nodes, edges,
records/evidence excerpts, local tier/depth, graph expansion, and latency.
The projection may contain:

- resident critical LTG constraints;
- newly active STG observations and task state;
- retrieved LTG nodes and bounded local content;
- selected persistent relations;
- temporary STG-to-LTG, LTG-to-LTG, or query-local relations used only for
  the current task.

AG construction is **query planning, not graph copying**: identify candidate
nodes first, then allocate local-content and relation budgets according to
expected usefulness. The model can request progressive expansion, but the
harness enforces the total budget and provenance boundary.

AG contains references and query-local annotations, not authoritative
copies. When AG is released, temporary nodes and edges disappear; only
explicitly recorded usage outcomes, stability observations, and accepted
writes survive.

The Pi adapter may keep a small **session injection window** beside these
query-scoped projections. It records only the stable memory ID, a content
hash, the greatest disclosure depth already rendered, and the turn number.
Within 12 turns, unchanged content already disclosed deeply enough is folded
to an `already_in_context` reference. A deeper request, changed evidence,
expiry from the window, or another session renders it again. The window is
bounded to 128 references, lives only in adapter memory, and is cleared at
session shutdown. It is context-cache metadata, not a third graph and not an
authoritative usage outcome.

### AG lifecycle: memory-resident, trace-persistent

AG itself is **pure memory, released with the session**. What persists is
not a copy of AG but its **usage trace**: which nodes/edges/records were
rendered, expanded, fetched via `nmg_get`, and actually used in the task.

The trace is not bookkeeping — it is the input to persistence decisions.
Active content is a *candidate signal* for persistence, not persistence
itself:

```text
STG + LTG ──project──▶ AG (memory-resident, released with session)
                            │ render / expand / nmg_get / adopt
                            ▼
                       usage trace (persistent)
                            │ dedupe by session/task/source lineage
                            │ + outcome attribution (design.md §5c)
                            ▼
                 persistence decision: promote LTG / demote / keep
                            │
                            └────────── updates LTG ──▶ next projection
```

Rules:

- **Activity alone never promotes.** Repeated retrieval does not increase
  stability (design.md §7.3); the trace is deduplicated per
  session/task/source lineage and gated by outcome attribution, exactly the
  credit discipline of §5c. AG active + cross-task reuse + positive outcome
  → LTG promotion candidate.
- **Inactivity is a demotion signal.** Content AG never selects across
  queries is a candidate for L4/L5, feeding the same retention lifecycle as
  `access_count` + `importance` (semantic activity signal, not a
  replacement).
- **The closure is CLS replay.** Re-activating selected traces to inform
  consolidation mirrors hippocampal replay selecting active traces for
  cortical integration (Complementary Learning Systems, §2.2). This is the
  mechanism-level reason the trace must persist even though AG does not.

#### Resident critical constraints: theoretical candidates

"Resident critical LTG constraints" enter every AG projection. Two existing
theories give this a name (candidate status; not yet adopted as design):

- **Intention superiority effect** (Goschke & Kuhl 1993; Marsh et al. 1999,
  PMID 10226441): intentions to perform an activity are stored in a
  *heightened state of activation*, and once fulfilled are *inhibited*
  relative to neutral material. Resident constraints are exactly unfinished
  intentions: persistently high activation until satisfied, suppressed after.
  This justifies both the "always resident" property and the post-satisfaction
  demotion path.
- **MemGPT core memory** (engineering): the always-in-context core block the
  agent self-edits — the closest engineered precedent for a small resident
  set carved out of the archive.

Open question (kept): how the resident set is maintained — explicit `pinned`
/ `safety_constraint` markers (existing mechanism) is the current proposal,
and whether resident content counts against the token budget (proposal:
counts, but allocated first, before discretionary content).

#### Filter usage: a cross-cutting trace field

Every trace records which retrieval filters were effective and what they
cost — one record, many consumers (not a filter-counter dedicated to index
decisions):

```ts
// RetrievalTraceInput.filterUsage
{
  dimensions: string[];      // e.g. ["scope.project", "node", "sourceActor", "maxTier:1"]
  candidatesBefore: number;  // rows scanned by SQL
  candidatesAfter: number;   // rows surviving post-filter, before sort
  selectivity: number;       // 1 − after/before
}
```

Consumers (each reads the same persisted field):

| Consumer | Question answered |
| --- | --- |
| Index decision | does a dimension get used enough and reduce candidates enough to justify an index? (`usage rate × selectivity × latency share`) |
| Budget projection (controller) | filtered queries have smaller candidate pools — budget dimensions can tighten |
| QPP calibration | filtered queries carry different top1/variance semantics; thresholds may differ |
| Router learning | filter context is a routing signal: within one scope, node ranking should be stable |
| Retention | a scope never filtered for is a candidate for cold demotion |
| Agent feedback | "slow because unscoped" → suggest `--scope` to narrow |

`selectivity` is measured after SQL but before sort, so it reflects what a
future pushdown would actually save (see the index-decision sketch in
docs/improvement-areas.md).

### AG lifecycle and the tiered disclosure design

The tiered gate ([tiered-disclosure-design.md](tiered-disclosure-design.md))
is the time dimension of AG construction: AG opens tiers sequentially and
exposes `tiersOpened` to the model; `nmg_get` is the explicit deep unlock.
The activation rules ([edge-activation-design.md](edge-activation-design.md))
are the within-AG mechanics: node activation is state, edge activation is a
derived function of it, and budgets apply after (not before) the bounded
propagation.

## 6. Promotion and demotion

- Promotion preserves the same stable record/node identity and provenance
  rather than copying content into a second graph. Demotion or expiry
  changes normal visibility but never rewrites the underlying
  `HistoryRecord`.
- **Promotion threshold grows with scope breadth and influence strength**
  (design.md §5a): session/task < project/workspace < user <
  team/organization; interaction hint < reasoning context < scoped
  constraint. Wider or more behaviour-changing memories require more
  independent evidence, stronger provenance, and an explicit
  correction/rollback path.
- A local subgraph is eligible for LTG materialization only when it
  satisfies minimum independent evidence, usefulness, scope consistency,
  provenance coverage, conflict, and stability thresholds:

```text
consolidate(G') iff
  stability(G')       >= high_threshold
  independent_tasks   >= min_tasks
  evidence_coverage   >= min_coverage
  observed_utility    >= min_utility
  unresolved_conflict <= max_conflict
```

- Consolidation uses **hysteresis**: demotion or reopening requires a lower
  threshold than promotion, preventing promote/demote oscillation. The
  operation is versioned and auditable, preserves evidence, and must be
  reversible by rebuilding the semantic projection from history.
- Atomic-memory promotion and structural consolidation remain separate.
  A clear fact, preference, constraint, state, or explicit remember request
  may enter LTG immediately; new relations, derived concepts, aggregated
  strategies, and node merges/splits require the stronger stability
  process.

## 7. Information-theoretic interpretation

The three-graph model reads as a codec (design.md §8; not a literal
implementation claim):

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

STG retains recent or provisional symbols before structural coding is
stable; LTG stores the consolidated codebook; AG decodes only the bounded
projection needed by the current task. Node headers are short lossy codes,
leaf headers add discriminating bits, typed relations provide side
information, and raw history prevents irreversible loss. A structural
change is justified only when it reduces expected retrieval distortion
enough to pay for its added complexity and maintenance (rate-distortion
objective, design.md §8).

## 8. Implementation state

Implemented (design.md §13):

- explicit STG/LTG residence on memories and nodes;
- governed immediate atomic LTG writes;
- ID-preserving promotion/demotion, STG expiry, append-only history;
- a first-class AG returned by `searchContext`, with persistent and
  query-local projection traits;
- Pi propagation of AG IDs from `nmg_search` to `nmg_get`;
- automatic turn-end maintenance in the Pi harness: STG expiry, due-node
  batch rebalance;
- LTG-only L4 Dormant/Unindexed and L5 Quarantine lifecycle states.
- session-private STG stores keyed by project and harness session identity;
- deterministic tiered sequential disclosure in CLI/Pi, with a shared
  deep-evidence budget and AG ledger (calibrated SPRT evaluation remains open);
- query-local typed edge activation with bounded propagation, fan dilution,
  regulatory-channel separation, trace visibility, and feedback-driven
  prediction-error strength updates.

Not yet implemented:

- promotion of the implemented Lab AG budget projection into the default Lite
  policy (the controller and QPP shadow traces already exist);
- calibrated SPRT evaluation for tier opening;
- learned temporal edge direction, contrastive unlearning, and automatic
  compression merge (see
  [edge-activation-design.md](edge-activation-design.md)).

## 9. Open questions

1. What STG retention, expiry, and demotion policy preserves useful
   provisional information without turning STG into a second unbounded
   archive?
2. How should an AG allocate token, node, edge, evidence, graph-hop, and
   tier budgets across a query — fixed defaults first, learned projection
   only after a measured gain?
3. Can a consolidated LTG relation be demoted or reopened when later
   evidence contradicts it, and what hysteresis parameters prevent
   oscillation?
4. Is CLS's replay analogy actionable (e.g., scheduled STG re-integration
   passes), or only a justification for the promotion thresholds?
