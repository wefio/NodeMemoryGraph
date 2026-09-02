# Memory Graphs: STG / LTG / AG

**Status:** consolidated design note

Implementation note: isolated STG is wired through the core, daemon, CLI, and
Pi adapter. One physical STG database is stored per `projectDir`; records and
derived retrieval paths are isolated by `sessionId` rows. Pi propagates its
native session identity through automatic recall and the memory tools.
**Updated:** 2026-08-29
**Related:** [design.md](design.md) §1/§5/§6/§7.1, [tiered-disclosure-design.md](tiered-disclosure-design.md), [edge-activation-design.md](edge-activation-design.md)

This document is the standalone reference for NMG's three-graph model:
the Short-Term Graph (STG), the Long-Term Graph (LTG), and the Active Graph
(AG). It reorganizes the material that lives across design.md §1, §5, §6,
§7.1, and §8, adds the theoretical lineage (which classical and modern memory
theories the model corresponds to), and records the current implementation
state.

## 1. The three graphs

| Graph   | Ownership                      | Content                                                                                                                         | Lifetime                             |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **STG** | private to one Agent session   | new, provisional, task-local, or not-yet-consolidated semantic information                                                      | session; expiry is a policy decision |
| **LTG** | the only shared graph          | durable atomic memories and consolidated semantic structure                                                                     | persistent                           |
| **AG**  | private to one Agent session   | mutable, budget-constrained runtime graph over STG/LTG references, task frames, tool observations, activation and temporary reasoning | session; memory-resident only        |

AG is **not** a third authoritative or shared memory graph. It is the private
working graph owned by one model session and must remain in memory. Agents never
write a shared AG or STG. Durable collaboration occurs through admitted LTG
memories; temporary coordination occurs through a separate Task Board whose
entries are projected into each caller's private AG. Immutable
`ProjectionRevision` snapshots record each concrete model-visible surface.

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

Residence (STG vs LTG) describes persistence; AG describes current
visibility; activation describes current use; stability determines whether
provisional structure should be consolidated. **Residence, activation, and
consolidation are different decisions** (design.md first principle 7).

## 2. Theoretical lineage

The three-graph model is not invented ad hoc: it maps onto classical and
modern memory theories with a long evidence base.

### 2.1 Atkinson–Shiffrin multi-store model (1968)

The three-stage sensory / short-term / long-term store (Atkinson & Shiffrin, 1968) is the structural ancestor:

| NMG | Atkinson–Shiffrin                  | Notes                                                              |
| --- | ---------------------------------- | ------------------------------------------------------------------ |
| AG  | working memory (~20 s, 7±2 chunks) | current task context, limited capacity, attention-gated            |
| STG | short-term store                   | temporary; enters LTM only through consolidation/rehearsal         |
| LTG | long-term store                    | near-unlimited capacity; semantic/episodic/procedural subdivisions |

The A-S point that information enters STM only when attended and reaches LTM
only through consolidation is exactly NMG's governed write path
(section 5 below).

### 2.2 Complementary Learning Systems (McClelland, McNaughton & O'Reilly, 1995)

The deepest mechanism-level correspondence. CLS (Psychological Review 102,
419–457; PMID 7624455) explains _why_ two learning systems are needed:

| NMG               | CLS                   | Mechanism                                                         |
| ----------------- | --------------------- | ----------------------------------------------------------------- |
| STG               | hippocampus           | fast encoding, sparse, temporary, interference-prone              |
| LTG               | neocortex             | slow integration, overlapping, persistent, robust to interference |
| STG→LTG promotion | systems consolidation | hippocampal replay drives cortical integration                    |

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

- AG is not exactly A-S short-term memory: AG is a _projection from_ the
  long-term store conditioned on the query, not a raw capture buffer. The
  closer cognitive analogue is the focus of attention within working
  memory (Cowan's focused-attention view, capacity ≈ 4 chunks) — noted as
  a pointer, not verified in this pass.
- CLS's fast system is prone to forgetting; NMG's STG is a _semantic_
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

## 5. AG: session runtime graph and projection revisions

```text
candidates_t = Project(STG, LTG, q_t, TaskBelief_t)
AG_(t+1) = Update_B(AG_t, candidates_t, observations_t, TaskBelief_t)
Projection_t = Freeze(VisibleSubset(AG_(t+1)))
```

`B` is one hard multidimensional budget over injected tokens, nodes, edges,
records/evidence excerpts, temporary observations, task frames, reasoning
steps, local tier/depth, graph expansion, and latency. AG may contain:

- resident critical LTG constraints;
- newly active STG observations and task state;
- retrieved LTG nodes and bounded local content;
- selected persistent relations;
- temporary STG-to-LTG, LTG-to-LTG, or query-local relations used only for
  the current task;
- bounded tool observations, unresolved working state, activation metadata,
  and hypothetical reasoning artifacts;
- one active task frame and a small bounded cooling set.

AG update is **working-memory management, not graph copying**: identify
candidates, update the appropriate task frame, allocate the total runtime
budget, then freeze one immutable model-visible revision. The model can request
progressive expansion, but the harness enforces both the total budget and the
projection provenance boundary.

The harness also enforces a separate per-turn construction-process budget. Pi
currently allows at most three searches and five total search/get calls, requires
exact-evidence progression after two searches, and stops after two consecutive
searches introduce no new candidate IDs. Thus a small final AG cannot be reached
through an unbounded tool loop. These counters are session-local, reset on a new
user turn, and remain hard limits outside learned/QPP budget allocation.

AG contains references and runtime annotations, not authoritative copies. It
may mutate across turns and compaction, but session release destroys it. Only
projection traces, explicitly recorded outcomes, stability observations, and
accepted writes survive.

The AG target owns a bounded **disclosure ledger**. It records only the stable
memory ID, a content hash, the greatest disclosure depth already rendered, and
the turn number.
Within 12 turns, unchanged content already disclosed deeply enough is folded
to an `already_in_context` reference. A deeper request, changed evidence,
expiry from the window, or another session renders it again. The window is
bounded to 128 references, cleared when compaction removes model context, and
destroyed at session shutdown. It is context-cache metadata inside AG, not an
authoritative usage outcome. Pi, DSH, WorkBuddy and MCP use the same daemon-owned
ledger while retaining host-specific rendering; a failed ledger call reveals
requested evidence rather than silently suppressing it.

Every persisted projection trace carries its owning harness `sessionId`. Trace reads,
disclosure, diagnostic attribution, and verified feedback must present the same identity;
cross-session access is rejected before any learning or stability signal is
updated. Protocol v9 distinguishes session `agId` from immutable
`projectionId`; the public `activeGraphId` argument now names that projection,
which resolves internally to one or more persisted retrieval traces.
Sending the projection identity with an explicit `nmg_get` makes exact evidence
expansion observable disclosure. Automatic recall and answer overlap remain diagnostic exposure,
not proof that the model used a memory. Only verified user/tool/benchmark
outcomes may train. Pi's `session_before_compact` event clears the daemon
disclosure ledger so evidence removed by compaction can be rendered again.

### Shared Task Board (cross-Agent coordination, not a memory graph)

One private AG cannot transmit state to another Agent. NMG therefore maintains
an independent, task-scoped coordination table in the daemon. `nmg_board` and
`nmg board put/read/resolve` operate on attributed, expiring entries; reads
return a task-local cursor so callers avoid reinjecting old entries. Pi places
read entries in the caller's bounded runtime AG projection.

The board is deliberately outside `memory_records`, FTS, embeddings, QPP, and
controller training. It may contain concise goals, questions, blockers,
results, handoffs, or decisions, but not secrets or hidden chain-of-thought.
Board content becomes durable semantic memory only through a separate,
attributable `remember` operation. Current local sharing trusts callers that
know the task ID; ACLs and multi-device transport remain future infrastructure.

**In-flight work registry.** An open attributed `goal` entry may represent one
coherent unit of work currently being attempted. It records only the goal, the
intended approach, and the owned scope. The initial writer does not need to
claim its own entry; a replacement Agent may claim it after interruption and
derive actual progress from Git and verification evidence. The entry is
resolved when the work completes or is deliberately abandoned. It is not a
progress log: phases, files, tool calls, completed-item lists, and periodic
checkpoints must not create additional entries by default. This keeps takeover
discoverable without imposing continuous bookkeeping. _Status:_ operating
convention over the implemented board lifecycle.

**Channel model — world channel + named channels.** `taskId` is a channel, not
a visibility hierarchy. There is one _world channel_ (the default when no
`taskId` is given) and independently _named channels_; any Agent can read or
write any channel it knows by name. The world channel acts as a lobby: reading
it surfaces the names and recency of active named channels (a directory), so an
Agent that does not know a channel name can still discover and join one. Naming
is public; joining is implicit (read/write by name); there is deliberately no
per-channel access control. _Status:_ implemented.

**Writer identity.** Entries are attributed to the writing Agent so readers can
tell which Agent posted each entry. `NMG_AGENT_ID` is the readable username;
fallbacks are the session id, then the pid. _Status:_ implemented.

**System identity and directed delivery.** Client adapters register their stable
agent name and optional `NMG_AGENT_CAPABILITIES` outside model context. Pi does
so at session start and on its wake loop; the MCP adapter registers on connect
and heartbeats on board use; the passive Kimi hook reports presence on each user
turn when a daemon already exists. `nmg_board discover` returns the online
roster, optionally filtered by capability, and `put` with `to=<agent name>`
wakes only that stable target while remaining read-visible to other clients.
Registration, discovery, and heartbeat never wake an LLM. _Status:_ implemented
for Pi, MCP-compatible clients, and the Kimi event hook.

**Claiming (who works an entry).** An open entry can be claimed by exactly one
Agent, so parallel Agents do not duplicate work on the same item. A claim is a
single atomic compare-and-set `UPDATE` (open + unclaimed, or a lapsed lease,
or the holder's own heartbeat) with a lease that expires; a losing CAS is
diagnosed against a fresh read so callers are never sent chasing a holder that
does not exist. Only the holder may release; resolving clears the claim; lease
expiry is lazy (no background sweeper). _Status:_ implemented (`claim`/`release`
actions, `claimedBy`/`claimExpiresAt` columns).

**Notification (who knows an entry exists).** Because an idle Agent never looks
at the board on its own, a claim would starve: entries would wait for someone
to notice. A wake loop polls the subscribed spaces (world channel plus active
named channels) and, when a new open entry appears that has not already been
surfaced, wakes the Agent with a broadcast-style `pi.sendUserMessage` ("your
subscribed channel has a new question") — never addressing a specific
recipient, so this is notification, not a DM or @. It is enabled and tuned via
`~/.nmg/board-wake.json` (hand-edited or toggled through the `/nmg` TUI menu:
`/nmg wake on|off|status|budget N|cooldown M|interval S`), no environment
variables. The loop is guarded by a daily budget and a cooldown
(notification-budget philosophy).

Delivery is a _flow constraint_, not a prompt rule. Every wake writes a
**delivery receipt** (`task_board_deliveries`, idempotent per session+entry,
cf. Pub/Sub ack semantics): once the loop wakes a session for an entry it does
not re-notify it. A session can opt out of a channel via the **suppression
registry** (`task_board_suppressions`, do-not-send, fed by `nmg_board
unsubscribe`/`subscribe`), which is checked before every delivery. So "already
notified", "read", "unsubscribed", and "resolved" entries never re-wake a
session — by mechanism, not by asking the Agent to remember.
_Status:_ implemented.

**Ownership and RAII (the two load-bearing principles).** Two classical
disciplines govern the board's state machinery. _Ownership (who holds the
key):_ the claim lease is an ownership capability — an atomic CAS gives a
single working Agent the entry, an expired lease returns it to the pool, only
the holder can release, and resolving clears the claim; a session's
suppression (suppression registry) and its delivery receipts (deliveries
table) are owned by that session. _RAII (who owns the lifetime):_ every board
resource closes deterministically — resolve closes an entry and, with it, its
delivery receipts (receipts are bound to the entry lifecycle and are cleared
on resolve/expiry, so the table cannot grow unbounded), a TTL/expiresAt
recycles entries, a lapsed lease auto-expires lazily, and the wake timer is
`unref()`'d so it never pins the process. Resolve is deliberately NOT
ownership-restricted: the board is open collaboration, so any Agent that can
answer a request may close it (the claim, by contrast, is the single-writer
key). _Status:_ implemented.

**Conversation closure (no infinite confirmations).** A request — a question,
handoff, or anything awaiting an answer — is resolved once it is answered, and
a resolved entry is closed: it must not be replied to (reopen only with new
substance). This bounds acknowledgement chains — a question is answered once
and then closed, so two Agents cannot ping-pong "confirmed" forever. _Status:_
convention, disclosed in the board result and the tool description.

**Memory pointers.** An entry may carry `memory=<id>` references to LTG records
instead of copying their content, using the same `memory=<id>` format that
automatic recall renders; a reader expands them with `nmg_get`. The board
therefore transmits _references_ to durable knowledge, never a second copy —
consistent with "LTG is the only shared graph" (§1). Pointers are progressive
disclosure: the board carries only the short id, and content is fetched on
demand via `nmg_get`, so reading the board never inflates context with the
referenced memory bodies. _Status:_ implemented by convention — content
accepts `memory=<id>` as plain text; there is no structured pointer type or
separate validation, kept intentionally minimal.

**AG projection.** On read, entries are projected into the _reading_ Agent's
private runtime AG, never into any shared graph. _Status:_ implemented.

**Design lineage (not validated standards).**

- the world channel is a _common ground_ surface (Clark): shared, continually
  aligned baseline facts for joint activity;
- memory pointers implement a _transactive memory_ pattern: the group knows
  where knowledge lives and points to it rather than duplicating it;
- the board as a whole is a bounded, expiring, group-visible coordination layer
  between private AGs and per-Agent LTG — engineering precedents include
  IRC-style channel discovery and recent "governed shared memory" proposals.
  Treat these as lineage, not consensus: definitions vary and most sources are
  preprints.

**Guardrail.** The board must stay temporary and non-authoritative: entries
expire (TTL), never enter LTG search, and become durable memory only through an
explicit attributable `remember`. It is not, and must not become, a shared
authoritative graph — that would break per-Agent memory ownership and the
immutable-content red line.

### AG lifecycle: mutable in memory, revision trace persistent

AG itself is **pure memory, mutable within and released with the session**. What
persists is not a copy of AG but immutable **projection observation traces**:
which nodes/edges/records were selected, rendered, expanded, fetched via
`nmg_get`, diagnostically matched to an answer, and independently verified or
rejected. These stages are separate; API-answer overlap is not proof of causal use.

The trace is not bookkeeping — it is the input to persistence decisions.
Active content is a _candidate signal_ for persistence, not persistence
itself:

```text
STG + LTG ──update──▶ session AG (mutable, memory-resident)
                            │ freeze visible subset
                            ▼
                    ProjectionRevision
                            │ render / expand / nmg_get / verify
                            ▼
                    observation trace (persistent)
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
  _heightened state of activation_, and once fulfilled are _inhibited_
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

| Consumer                       | Question answered                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Index decision                 | does a dimension get used enough and reduce candidates enough to justify an index? (`usage rate × selectivity × latency share`) |
| Budget projection (controller) | filtered queries have smaller candidate pools — budget dimensions can tighten                                                   |
| QPP calibration                | filtered queries carry different top1/variance semantics; thresholds may differ                                                 |
| Router learning                | filter context is a routing signal: within one scope, node ranking should be stable                                             |
| Retention                      | a scope never filtered for is a candidate for cold demotion                                                                     |
| Agent feedback                 | "slow because unscoped" → suggest `--scope` to narrow                                                                           |

`selectivity` is measured after SQL but before sort, so it reflects what a
future pushdown would actually save (see the index-decision sketch in
docs/design/improvement-areas.md).

### Projection lifecycle and the tiered disclosure design

The tiered gate ([tiered-disclosure-design.md](tiered-disclosure-design.md))
is the time dimension of projection construction: AG opens tiers sequentially
and exposes `tiersOpened` to the model; `nmg_get` is the explicit deep unlock.
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
- a first-class query-scoped `ActiveGraph` returned by `searchContext`, with
  persistent and query-local projection traits; this is the current
  implementation that the target design renames to `ProjectionRevision`;
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
- a shared Task Board with task isolation, immutable writer attribution,
  task-local cursors, TTL expiry, explicit resolution, lease-based claiming
  (claim/release, one Agent per entry, lazy lease expiry), an opt-in
  broadcast-style wake notification loop (configured via `~/.nmg/board-wake.json`
  or the `/nmg` TUI menu, daily budget +
  cooldown + per-entry dedup), private Pi AG projection, a world channel with
  a lobby directory of active named channels (an omitted `taskId` targets the
  world channel), and convention-based `memory=<id>` pointers readers expand
  via `nmg_get`;

Implemented but not promoted or naturally calibrated:

- promotion of the implemented Lab AG budget projection into the default Lite
  policy (the typed runtime boundary exists and defaults to shadow; it may be
  enabled explicitly while still in Lab, but no candidate has passed the natural
  matched-evidence gate for active/default use);
- calibrated SPRT evaluation for tier opening;
- learned temporal edge direction, contrastive unlearning, and automatic
  compression merge (see
  [edge-activation-design.md](edge-activation-design.md));
- Task Board ACLs and multi-device transport (still future infrastructure).

Designed but not implemented:

- one mutable session-owned AG shared by semantic retrieval, tool observations,
  task frames, HA activation, and bounded MGR artifacts;
- distinct `agId`, `taskFrameId`, `projectionId`, and `boardChannelId` identities;
- migration of Pi `SessionRuntimeAg`, the injection window, and daemon
  continuation maps into the shared runtime and immutable revision contract.

## 9. Open questions

1. How should the implemented STG retention, expiry, and demotion priors be
   calibrated so useful provisional information survives without turning STG
   into a second unbounded archive?
2. How should the session AG allocate one total token, node, edge, evidence,
   task-frame, reasoning, graph-hop, and tier budget across natural work?
3. What natural contradiction and reversal evidence is sufficient to calibrate
   the implemented LTG relation demotion/reopen hysteresis?
4. Is CLS's replay analogy actionable (e.g., scheduled STG re-integration
   passes), or only a justification for the promotion thresholds?
5. Which deterministic task-switch baseline is sufficient before HA learns
   task-frame activation, and how many cooling frames have positive marginal
   value?
