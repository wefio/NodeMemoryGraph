# NMG design baseline

**Status:** 0.9 / P3 runtime memory model implemented
**Updated:** 2026-08-13

## 1. Definition

Node Memory Graph (NMG) is a local-first long-term memory component for
long-running agents. It preserves immutable historical evidence, derives mutable
semantic memory from that evidence, and progressively discloses only the context
needed by the current task.

NMG separates physical memory residence from runtime exposure:

- the **Short-Term Graph (STG)** is private to one Agent session and holds new,
  provisional, task-local, or not-yet-consolidated semantic information;
- the **Long-Term Graph (LTG)** is the only shared graph and holds durable atomic
  memories and consolidated semantic structure;
- the **Active Graph (AG)** is a private, per-Agent/per-session,
  budget-constrained runtime projection selected from that session's STG and
  the shared LTG, with optional temporary cross-graph relations.

AG is not a third authoritative or shared memory graph. It is the private
virtual memory space presented to one model session. Agents never write a
shared AG or STG: durable collaboration occurs through admitted LTG memories;
temporary coordination occurs through the separate Task Board and is projected
into each caller's private AG.

> **Standalone reference:** the STG/LTG/AG model, its theoretical lineage
> (Atkinson–Shiffrin 1968, Complementary Learning Systems 1995, ACT-R/SOAR,
> MemGPT/Letta), provisional-memory rules, promotion/demotion thresholds, and
> implementation state are consolidated in
> [memory-graphs.md](memory-graphs.md). design.md keeps the normative model;
> details moved to the standalone document.

The primary integration target is the Pi agent harness. Pi owns the model loop,
session lifecycle, tools, and UI. NMG owns durable memory, provenance, retrieval,
and memory-maintenance policy. NMG is not an agent harness, a sandbox, or a cloud
platform.

NMG has two intentionally different surfaces:

- **NMG Lite** is the default product surface: a zero-configuration Pi plugin
  backed by SQLite, a small model-facing API, and the framework-free
  differentiable computation substrate used by optional controllers.
- **NMG Lab** contains measured experiments such as graph routing, adaptive
  tiers, ANN, learned routing, and topology refinement. A Lab feature enters
  Lite only after an ablation demonstrates a benefit over a simpler baseline.

The repository may contain both surfaces, but experimental complexity must not
become an installation or prompt dependency for the default plugin.

The autodiff substrate belongs to Lite because product features may depend on
its numerical graph and it adds no Python, PyTorch, GPU, or model-service
dependency. This does **not** promote every consumer of that substrate:
learned routing, hierarchical activation, fork/merge experiments, and the
Memory-Graph Reasoner each retain an independent feature gate and evidence
requirement.

## 2. First principles

NMG follows these principles:

1. **History is the durable source; semantic memory is a rebuildable
   interpretation.** Normal maintenance never rewrites historical evidence.
2. **A memory system improves access to relevant prior state, not the base
   model's reasoning ceiling.** It may improve continuity, personalization,
   constraint compliance, and experience reuse, while bad memory can make the
   agent worse.
3. **Storage can grow without prompt growth.** Most turns should see no dynamic
   memory or only a compact directory.
4. **Progressive disclosure precedes aggressive prefetch.** The agent first sees
   what memory exists, then fetches exact evidence when useful.
5. **Missing a speculative relation is safer than persisting a false one.** Raw
   and provisional memories remain globally searchable while semantic structure
   develops.
6. **The simplest measured implementation wins.** A graph, ANN, adaptive tree,
   or learned router is optional until it improves quality or cost against a
   simpler control.
7. **Residence, activation, and consolidation are different decisions.** STG or
   LTG determines persistence; AG determines current visibility; activation
   describes current use; stability determines whether provisional structure
   should be consolidated.
8. **Facts may persist before structure stabilizes.** A confirmed fact,
   preference, constraint, or replaceable state can enter LTG directly with
   provenance. Inferred relations, derived concepts, and reusable strategies
   require stronger cross-task evidence before becoming LTG structure.

## 3. Responsibility boundaries

| Component            | Responsibilities                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base model           | Identify candidate facts/preferences/constraints, summarize, reformulate queries, decide whether more evidence is needed, propose semantic relations or splits, and synthesize an answer. |
| Agent harness        | Run the model/tool loop, expose session lifecycle events, preserve current-turn execution state, and provide context/tool integration points.                                             |
| Harness adapter      | Translate native messages and lifecycle events into NMG integration contracts, register tools, and inject returned context. It contains no retrieval or storage policy.                   |
| NMG integration      | Apply shared configuration, retain admitted source evidence, run hybrid retrieval, and expose an Agent-independent application boundary.                                                  |
| NMG core             | Maintain stable IDs, provenance, STG/LTG lifecycle, time/scope/state invariants, Active Graph budgets, semantic organization, consolidation signals, and rebuildable indexes.             |
| SQLite/index backend | Provide transactions, WAL/crash recovery, FTS, versioned records, dirty queues, content hashes, and physical index/cache persistence.                                                     |
| Optional learner     | Learn query-to-node/leaf scores, edge usefulness, expansion depth, or stopping policy from labelled retrieval outcomes. It does not own persistent topology.                              |

Stronger models can improve extraction, summarization, query planning, conflict
interpretation, and topology proposals. They cannot naturally provide
cross-session persistence, transactions, stable provenance, deletion propagation,
index maintenance, or deterministic budget enforcement. Those remain system
responsibilities.

## 4. Product boundary: NMG Lite

The target default plugin should install as a normal Pi package and require only
Node.js, Pi, and SQLite. FTS search must work without an embedding server. A
semantic embedding provider may be enabled by configuration, but local Qwen,
vLLM, CUDA, USearch, general-purpose ML frameworks, and Cloudflare are not
default dependencies.

The target model-facing surface is four tools, with the fourth deliberately
outside durable memory:

```text
nmg_search(query, filters, budget)
  -> compact result headers, IDs, dates, types, sources, and retrieval costs

nmg_get(ids)
  -> exact selected memories and bounded raw evidence

nmg_remember(statement, type?, scope?)
  -> explicit/hot-path durable write through the same governed write policy

nmg_board(action, taskId, ...)
  -> temporary cross-agent task coordination with TTL, cursors, and attribution
```

Automatic extraction may use the same write path. Privacy deletion, reindexing,
graph editing, feedback inspection, and maintenance belong in CLI/UI/background
operations rather than ordinary model tools. The one exception is an explicit,
session-owned calibration label submitted through `nmg_remember action=feedback`;
it records adapter-owned evaluation metadata and never mutates memory truth or
ranking. This action is currently a Pi shadow-controller integration, not an
NMG Core/RPC method.

The default Pi package exposes only these four tools. Graph editing,
rebalancing, consolidation, QPP, and experimental reasoning remain background,
CLI, benchmark, or administrative concerns. Explicit retrieval feedback is an
action on the existing remember boundary, not another tool or an automatic
inference from user silence.

### 4.1 Agent-independent CLI and resident service

The target integration boundary is an agent-independent `nmg` CLI rather than
direct access from a harness to NMG internals. Pi still requires a small
TypeScript extension, but that extension should translate Pi lifecycle events
and tools into a stable language-neutral protocol. It must not make the core
storage or processing implementation TypeScript-specific.

The CLI supports both one-shot administrative use and a resident mode:

```text
nmg remember ...
nmg search ... --compact-json  # agent-facing headers
nmg search ... --json          # full diagnostics
nmg get ... --active-graph-id <ID_FROM_SEARCH> --json
nmg status --json
nmg daemon start
nmg daemon status
nmg daemon stop
```

`activeGraphId` is not decorative continuation metadata. Agent-independent
clients must return it on exact `get` so the owning retrieval trace records
which candidates were **disclosed**. Search, injection, and exact loading are
observable exposure states, not evidence that an API model relied on a record.
Keeping them separate prevents candidate exposure from becoming
self-reinforcing positive feedback.

This is the portable observation boundary. `get(activeGraphId=...)` records
disclosure through the stable RPC. An adapter may additionally record
answer-to-memory overlap, but that is provider-dependent diagnostic telemetry,
not proof of causal use and not a training label. Only auditable user
confirmation, tool-verified outcomes, and official benchmark evidence may mark
records useful/contradicted and train routing or graph stability. Labels such as
task success, evidence sufficiency, expansion usefulness, and excessive noise
depend on native answer, correction, token, and tool lifecycle events, so they
remain harness-adapter telemetry. Silence or candidate exposure is never
converted into a positive label.

For Pi ergonomics, `nmg_remember(action="feedback")` may omit `activeGraphId`
only to target the latest retrieval owned by that same Pi session. A supplied ID
is still session-checked and remains necessary when reviewing an older graph.
This avoids fragile UUID transcription without allowing cross-session labels.

One-shot commands remain useful for people and diagnostics. Harnesses normally
connect to the resident HTTP JSON-RPC service so the bounded in-memory working set,
session/STG state, Active Graph continuations, node directory, and hot caches
survive across calls. The daemon speaks JSON-RPC 2.0 over HTTP on an
OS-assigned `127.0.0.1` port, using Node's built-in `http` and `fetch` and
requiring no third-party transport dependencies. SQLite opens lazily on first
durable work.

The CLI is a fallback and administrative surface for harnesses without a full
adapter; it is not a requirement that every internal mechanism gain a command.
Query-internal policies such as edge activation reuse `search` and its trace
output. A dedicated command is justified only when a person or incomplete
adapter needs to invoke, inspect, or recover that operation explicitly.

Resident instances use a PID lease scoped to the selected SQLite database.
The lease records the loopback endpoint and a random bearer token. Starting a
second daemon for the same database is rejected, stale leases are recovered,
and `Shutdown` performs the normal close path. PID termination is only a
fallback when the HTTP endpoint cannot be reached.

Protocol version `nmg.v6` exposes the typed lifecycle, memory, retrieval,
maintenance, STG-sync, and Task Board methods declared in `protocol.ts` over
JSON-RPC 2.0. HTTP is the only resident protocol;
NMG does not maintain a parallel NDJSON or platform-specific socket API.
The lease records the protocol version. Clients fail closed when a live daemon
uses an incompatible protocol and require an explicit `nmg daemon restart` at a
safe coordination point; they never replace a shared daemon automatically.
`nmg.v5` was deliberately incompatible with v4 because the ambiguous
`recordActiveGraphUse` RPC was replaced by diagnostic-only
`recordActiveGraphAttribution`; silently connecting to v4 would lose attribution
at Agent completion and would preserve the old, unsafe training semantics.
`nmg.v6` additionally preserves `natural|controlled|legacy` provenance on claim
outcome events. Connecting the current adapter to v5 would silently discard that
optional field and contaminate natural-maintenance audits, so clients again fail
closed until an explicitly coordinated restart.

### 4.2 Modular harness adapters

The TypeScript prototype is split by responsibility at the HTTP
client/server process boundary:

```text
Agent-specific adapter
  |- native message -> AgentHistorySnapshot
  |- native lifecycle -> recall/write/feedback calls
  |- native tool schema and result formatting
  `- prompt/context injection
                |
                v
Agent-independent integration modules
  |- config: environment and feature-mode parsing
  |- evidence: selective source-message retention
  `- search: lexical/hybrid retrieval with explicit degradation
                |
                v
NMG core + SQLite
```

An adapter must provide stable session and message IDs, normalized actors and
text, an optional source reference, and lifecycle hooks for pre-turn recall,
post-turn feedback, and shutdown. It must not parse SQLite rows, update graph
topology, implement QPP, or construct embedding indexes. Pi is the first
adapter, not part of the NMG data model.

The Pi adapter is now a thin HTTP lifecycle/tool adapter. It lazily starts the
daemon, reuses one connection (via the shared `http-client`) for automatic
recall and the four stable tools, and
stops the daemon only when that adapter invocation owns it. It does not open
SQLite, maintain indexes, or import graph/QPP implementations. No Rust/Python
implementation is planned unless profiling later identifies a component that
cannot meet its budget in TypeScript.

Other Agents can use the packaged `nmg-memory` Skill. Its entry document is a
small first-use card; detailed write, recall, and daemon operations live in
linked references and are loaded only when the Agent forgets an operation or
encounters a special case.

## 5. Core data model

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

A `MemoryRecord` is a retrievable semantic statement with provenance and an STG
or LTG lifecycle. A `MemoryNode` is a stable semantic address for a coherent
group of records. Creating one permanent node for every new memory would
reproduce a flat store with extra graph overhead and is not the target model.

An unresolved structure is represented on the record itself, not as a new
memory type. `resolution` is `resolved` by default and may be `open` or
`reopened`; open records carry `openedAt` and one or more
`relatedMemoryIds`. The related IDs are attributable anchors, not inferred graph
edges. Open records remain indexed and are excluded from both LTG heat-based
retention candidates and STG expiry. Explicit `resolve` returns them to normal
retention; explicit `reopen` restores archived records to the searchable index.
Every transition is appended to `memory_resolution_events`, preserving the
reason and anchors without rewriting source history.

Retrieval gives this state bounded reachability. When direct search retrieves an
anchor, at most two related open records are inserted near the end of the normal
first evidence window. They consume the same node, evidence, tier, and token
budgets as every other AG record and do not start a second retrieval cascade.
Pi renders them with `[open]`. The harness therefore guarantees reachability,
but the Agent decides whether the unresolved item matters and must explicitly
call `nmg_remember` with `action=resolve` or `action=reopen` to revise it.

One record can contain several atomic facts. Following the chat.completions
content-parts model, a record stays the single evidence unit (embeddings, FTS,
provenance, and lifecycle all operate at record granularity) while carrying a
`claims` array (`claims_json`) of atomic `MemoryClaim` items — each with its
own text, polarity, predicate key, confidence, and extraction provenance. The
record-level polarity/predicate/confidence columns are a derived rollup cache
(first non-neutral claim), never the source of truth. Contradiction detection
joins claims, not records, so a contradiction inside one long message is as
visible as one across messages. At query time, `contradictionNotes()` renders
each detected pair as a note appended to the retrieved statement, so the
answer-stage reader sees the flag without any harness-side changes.

STG and LTG describe semantic residence, not separate truth systems. Promotion
should preserve the same stable record/node identity and provenance rather than
copying content into a second graph. Demotion or expiry changes normal
visibility but never rewrites the underlying `HistoryRecord`.

AG contains references and query-local annotations, not authoritative copies.
When AG is released, temporary nodes and edges disappear; only explicitly
recorded usage outcomes, stability observations, and accepted writes survive.

Harness-local execution observations follow the same rule. Recent tool errors,
test outcomes, and edited paths may be projected into AG through a bounded
session ring buffer so the model can use its immediate working state across
turns and context compaction. While Pi still retains the original tool results,
the buffer is not redundantly injected; compaction activates its bounded AG
projection. These observations are not `MemoryRecord`s and are never written to
SQLite merely because a tool ran, and disappear when the owning session ends.
Only an explicit, semantically judged `nmg_remember` call may turn an outcome
into STG/LTG memory. Pi remains responsible for conversational compaction; NMG
must not copy the doomed raw message span into durable storage as an automatic
"rescue" path.

### 5a. Influence permissions

Memory type answers **what a record describes**. Scope answers **where it may
apply**. Influence permission answers **how a recalled record is allowed to
change the Agent's result**. These dimensions are orthogonal: retrieval
relevance alone never grants authority.

The initial permission vocabulary is:

| Permission            | Permitted influence                                                                  | Forbidden influence                                                              |
| --------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `reasoning_context`   | Supply a scoped, confidence-weighted premise or source                               | Override newer state, stronger evidence, or explicit constraints                 |
| `presentation_style`  | Change language, tone, detail, ordering, or formatting                               | Change factual conclusions or tool decisions                                     |
| `interaction_hint`    | Suggest a non-binding interaction pattern inferred from repeated behaviour           | Become a hard requirement from one observation                                   |
| `task_continuation`   | Restore goals, progress, decisions, and open work within the matching task/workspace | Generalize temporary state into a user-wide preference                           |
| `scoped_constraint`   | Restrict an action inside its explicit scope while active                            | Apply outside that scope or survive a superseding constraint                     |
| `experience_advisory` | Offer evidence-backed experience for the Agent/user to interpret and adapt           | Silently become an executable procedure, system prompt, Skill, or mandatory plan |

Default mappings may be inferred from memory type, but the effective permission
must also respect source, scope, truth status, residence, recency, and
supersession. For example, an explicit expression preference normally receives
`presentation_style`; a repeated behavioural observation receives the weaker
`interaction_hint`; a project constraint receives `scoped_constraint`; and a
strategy candidate receives `experience_advisory`.

Permission is enforced at rendering and use, not merely documented in prose.
Until a structured field is implemented, adapters must render an explicit use
instruction with every selected record. A future schema migration may persist
the permission when tests show that type-derived defaults are insufficient.

The promotion threshold grows with both scope breadth and influence strength:

```text
session/task < project/workspace < user < team/organization
interaction hint < reasoning context < scoped constraint
```

Wider or more behaviour-changing memories require more independent evidence,
stronger provenance, and an explicit correction/rollback path.

### 5b. Transferable experience

NMG may consolidate repeated, outcome-linked episodes into **transferable
experience**, but it does not decide the final behavioural artifact. An
experience is descriptive evidence about what happened under which conditions,
not an instruction that must be executed.

The logical experience projection contains:

```text
summary
situation / preconditions
action or approach observed
outcome
possible explanation
applicability and scope
known limitations
counterexamples and failed variants
confidence and independent-task count
source memory, outcome, and HistoryRecord references
```

Formation requires multiple compatible episodes or an explicitly confirmed
experience, attributable outcomes, preserved counterexamples, and a stable
scope. A single successful action remains an event or provisional STG strategy.
Repeated failure lowers confidence or narrows applicability; it does not erase
the original episodes.

NMG exposes the experience information through normal retrieval or a neutral
structured export. It does **not** create or modify a `SKILL.md`, system prompt,
runbook, script, policy, or model weights. The current Agent and user may choose
to turn the same experience into any of those artifacts—or not use it at all.
Keeping the stable layer limited to semantics, conditions, outcomes, and
evidence allows experience to survive changes in Agent harnesses and artifact
formats.

Existing `strategy` memories are therefore interpreted as provisional or
consolidated experience candidates with `experience_advisory` permission, not
as executable procedures. The model may adapt them to the current task, but
must inspect applicability and contrary evidence before acting.

### 5c. Confidence as a posterior: the outcome feedback loop

Claim `confidence` today is a prior — the extractor's self-assessment at write
time. A memory system earns the word "experience" only when that number is
corrected by an outcome that can be attributed to a claim. Retrieval and
rendering alone do not supply that attribution. The external harness can capture
user confirmation, tool validation, and benchmark evidence after inference;
model upgrades improve the prior but cannot replace this auditable loop.

Mechanism (minimal, deterministic):

1. **Observation logging.** Retrieval, disclosure, and heuristic answer overlap
   are separate events. They support latency, coverage, and interaction analysis
   but do not create usefulness votes.
2. **Verified outcome attribution.** A claim receives a vote only when the
   caller identifies both the claim and an auditable outcome source: explicit
   user confirmation/correction, a validating tool result, or official
   benchmark evidence. Broad task success is not sprayed across every rendered
   claim. Outcomes are provenance-bearing events, never silent in-place edits.
3. **Posterior update.** Claim confidence becomes
   `posterior = f(extraction prior, accumulated outcome votes)` — a Beta-style
   running update keeps the storage to two counters per claim and stays
   auditable. The raw prior is preserved so re-weighting rules can change
   without re-extraction.
4. **Retrieval weighting.** Rank fusion consumes the posterior, not the
   prior: repeatedly useful memories surface more easily; memories that
   correlate with failures sink toward archival review rather than being
   deleted (history stays immutable).
5. **Credit discipline.** Correlation is not causation. API-model answer overlap,
   counterfactual response differences, tool-call presence, and uncorrected
   completion remain diagnostics because model/provider drift makes them poor
   portable labels. Verified votes from the same task are deduplicated, and a
   posterior is trusted only after enough independent observations.

This loop also answers, at claim granularity, part of the open routing
question in section 17: the usefulness signal lives on the claim, not on the
router's selection, so reinforcing a good memory does not require reinforcing
the path that found it.

### 5d. Optional interaction profile, not a hidden user model

NMG does not currently maintain a learned user model. A future adapter may keep
a small, explicit **interaction profile** when repeated cross-task behaviour
shows a stable preference for recall depth or interaction style—for example,
the user repeatedly requests more results, stops after shallow evidence, or
corrects overly aggressive recall. Such black-box behavioural measurement is
about the user's observable choices, not an API model's hidden cognition.

The profile may tune user-scoped defaults such as evidence budget, automatic
recall aggressiveness, or whether to recommend another search. It must use
decay, a minimum number of independent tasks, inspectable features, and reset/
export controls. A single interaction remains telemetry. The profile may never
change fact truth, claim confidence, graph stability, node merging, or global
controller weights; those continue to require verified evidence. Until this
need is demonstrated, the event log is sufficient and no new subsystem is
implemented.

## 6. STG/LTG connectivity and provisional memory

The semantic graph is not required to be connected. Its connected components
may represent unrelated projects, preferences, people, or historical topics.

Connections are established in three classes:

1. **Provenance links are immediate and mandatory.** Every semantic memory must
   reach its exact source message, session, or tool result.
2. **Deterministic identity links are immediate when known.** Examples include
   an explicit project scope, a matching `stateKey + scope`, and a supported
   supersession relation.
3. **Inferred semantic links are delayed.** `related_to`, causal, dependency,
   merge, and split proposals require accumulated evidence or explicit
   confirmation.

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

Confirmed user facts, preferences, constraints, replaceable states, explicit
remember requests, and tool-verified facts may take the immediate promotion
path. Their atomic content can be durable without committing speculative graph
structure. Relations inferred from co-occurrence, reasoning, or one task remain
in STG as observations or candidates until consolidation criteria are met.

In the implemented path, ordinary `remember` deliberately creates no semantic
edge. A search records co-retrieved node pairs as candidate observations; the Pi
adapter records answer overlap at `agent_end` only as a diagnostic attribution.
Only a pair backed by verified useful evidence across the configured minimum
number of independent tasks and clearing the stability threshold may be
consolidated as `related_to`. Explicit `remember(action="relate")` creates a reviewable
topology proposal rather than bypassing this gate. `is_a` is created by a
reviewed split, while `derived_from` records the provenance of an explicitly
derived memory. Consequently, a young or unrelated store may correctly contain
isolated nodes, but ordinary Pi use must still accumulate candidate observations
and later verified outcomes.

Implicit answer attribution is deliberately conservative and language-aware,
but remains diagnostic:
Latin text uses distinctive whole words, while contiguous Han text uses character
bigrams. It helps audit whether retrieved text surfaced and select which
retrieval to ask the user about. Neither it nor exact `get` reads can raise edge
stability. Historical co-retrieval observations are not backfilled as useful:
only future user-, tool-, or benchmark-verified outcomes may do so.

> The provisional-memory rules, isolation requirements, STG-vs-Delta
> distinction, and promotion/demotion thresholds are consolidated in
> [memory-graphs.md](memory-graphs.md) §3–§6.

STG records and isolated/provisional nodes must participate in global FTS,
exact, recency, and optional vector search. Graph traversal is a candidate
expansion mechanism, never the only retrieval entry point. STG entries may be
persisted in SQLite for crash recovery and cross-turn continuity; expiry is a
policy decision, not an implication that short-term data must live only in RAM.

“Global” here means all retrieval modes inside the owning session, not visibility
across sessions. A multi-Agent runtime must carry a non-forgeable `runtime_id`
and `session_id` through search and exact access, and every STG row, temporary
edge, AG trace, and feedback event must be filtered by that identity. A separate
`semantic_task_id` deduplicates repeated evidence across Agents; it must not be
used as the isolation identity. The current implementation uses one physical STG
store per project and row-level Pi `sessionId` isolation. The owner filter applies
to direct retrieval, open-memory attachments, graph expansion, exact reads, and
returned relations; shared cache rows (`session_id IS NULL`) remain explicitly
visible. AG traces persist the same owner and reject cross-session reads and
feedback. A separate non-forgeable `runtime_id` remains a future harness boundary
because Pi does not currently provide one to this adapter.

The semantic STG is distinct from the existing index `Inbox/Delta`. STG tracks
memory lifecycle and provisional meaning. Index Delta tracks records whose
derived leaf/vector index has not yet been compacted. A long-term memory may be
in index Delta, and a short-term memory may already have a compacted index.

An isolated node may later be merged as an alias, refined under a parent,
linked to another independent concept, or remain isolated. Adding an edge does
not imply merging node identity.

General semantic relations may cycle. Derivation and supersession dependencies
must remain acyclic. Each query may materialize a bounded, visited-set-protected
local expansion DAG even when the persistent semantic graph contains cycles.

## 7. Active Graph, activation, stability, and consolidation

> AG construction rules moved to [memory-graphs.md](memory-graphs.md) §5;
> activation rules are designed in [edge-activation-design.md](edge-activation-design.md);
> the tiered disclosure gate is designed in [tiered-disclosure-design.md](tiered-disclosure-design.md).
> This section keeps the normative activation/stability model.

### 7.1 Active Graph construction

For query `q_t` and current task state `task_t`, NMG constructs:

```text
AG_t = Project_B(STG, LTG, q_t, task_t)
```

`B` is a hard multidimensional budget over injected tokens, nodes, edges,
records/evidence excerpts, local tier/depth, graph expansion, and latency. The
projection may contain:

- resident critical LTG constraints;
- newly active STG observations and task state;
- retrieved LTG nodes and bounded local content;
- selected persistent relations;
- temporary STG-to-LTG, LTG-to-LTG, or query-local relations used only for the
  current task.
- bounded harness-local tool observations that remain virtual and session-owned.

AG can act as one Agent's **private working blackboard**, but cannot itself
communicate across Agents. Cross-Agent coordination uses the independent
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

**Implementation status:** the shared Task Board is implemented in SQLite and
exposed by daemon RPC, CLI (`nmg board put/read/resolve`), and one trailing Pi
tool (`nmg_board`). It records `agentId` and source session, supports task
isolation, cursor reads, TTL deletion, and explicit resolution. Pi reads are
added to the caller's bounded `SessionRuntimeAg`. Membership/ACLs and remote
multi-device transport are not implemented; local callers sharing the daemon
must agree on a task ID and should set stable `NMG_AGENT_ID` values.

AG construction is query planning, not graph copying. It should first identify
candidate nodes, then allocate local-content and relation budgets according to
expected usefulness. The model can request progressive expansion, but the
harness enforces the total budget and provenance boundary.

The projection budget and the **construction-process budget** are separate.
Bounding the final AG does not prevent an Agent from repeatedly issuing searches
that rediscover the same candidates. The Pi adapter therefore also bounds each
user turn to three explicit searches and five total recall tool calls, permits at
most two searches without an intervening exact-evidence progression, and stops
after two consecutive searches add no candidate IDs. A new user turn resets this
ephemeral guard. These are deterministic harness limits outside QPP and the
differentiable controller; learned allocation may choose a smaller AG but cannot
relax them.

### 7.2 Node and edge activation

Node activation manages current working memory. A target scoring family is:

```text
A_v(t) = w_q * query_relevance
       + w_t * task_relevance
       + w_r * recency
       + w_i * importance
       + w_p * learned_prior
       - w_c * retrieval_cost
```

Edge activation records the current cognitive/retrieval path:

```text
A_e(t) = f(A_source, A_target, relation_type, q_t, task_t, path_cost)
```

Activation is fast-changing and query-local. A highly active node or edge is
not thereby true, durable, or stable. Conversely, a stable LTG constraint may
remain inactive in an unrelated task. AG should separately record which nodes
and edges were selected, which exact evidence was disclosed, which records only
overlapped the answer, and which evidence was independently verified,
contradicted, or rejected. Only the final class can supervise persistence and
controller learning; selection, disclosure, and API-answer overlap remain
observations rather than utility claims.

### 7.3 Edge stability and structural consolidation

Edge stability changes more slowly than activation and estimates whether a
relation has repeatedly helped across independent contexts:

```text
S_e(t+1) = decay * S_e(t)
         + alpha * cross_task_usefulness
         + beta  * independent_recurrence
         + gamma * user_or_tool_verification
         - delta * contradiction_or_failure
```

Repeated retrieval alone must not increase stability. Otherwise an accidental
retrieval edge creates a feedback loop: it causes co-retrieval, which strengthens
the same edge, which causes more co-retrieval. Useful observations should be
deduplicated by session/task/source lineage and discounted when they are caused
only by the candidate edge being evaluated.

Temporary and inferred edges follow an explicit lifecycle:

```text
ephemeral -> observed -> candidate -> consolidated
                         |             |
                         `-> rejected  `-> LTG typed relation
```

A local subgraph is eligible for LTG materialization only when it satisfies
minimum independent evidence, usefulness, scope consistency, provenance
coverage, conflict, and stability thresholds:

```text
consolidate(G') iff
  stability(G')       >= high_threshold
  independent_tasks   >= min_tasks
  evidence_coverage   >= min_coverage
  observed_utility    >= min_utility
  unresolved_conflict <= max_conflict
```

Consolidation uses hysteresis: demotion or reopening requires a lower threshold
than promotion, preventing repeated promote/demote oscillation. The operation is
versioned and auditable, preserves evidence, and must be reversible by rebuilding
the semantic projection from history. Stable co-activation supports a relation;
it does not by itself prove a factual claim.

Atomic-memory promotion and structural consolidation remain separate. A clear
fact, preference, constraint, state, or explicit remember request may enter LTG
immediately. New relations, derived concepts, aggregated strategies, and node
merges/splits require the stronger stability process above.

Because Pi session STG and shared LTG are physically separate SQLite stores,
changing a row's `residence` flag is not cross-store consolidation. The runtime
therefore treats consolidation as an explicit materialization step:

```text
independently attributable claim outcomes
  -> per-claim posterior eligibility
  -> STG consolidation candidate (shadow by default)
  -> exact evidence + semantic record copied into LTG
  -> LTG remember/dedup transaction
```

Retrieval frequency, repeated rendering, and silence never qualify a memory.
Every atomic claim must pass minimum independent-vote, posterior-mean, and
conservative-lower-bound gates. The copied LTG record carries a
`consolidated_from_stg` marker pointing to its source memory; LTG's exact
same-scope deduplication makes retry after interruption idempotent. Automatic
actuation is deliberately disabled by default and requires
`NMG_STG_AUTO_CONSOLIDATE=1`; candidate reporting remains available in shadow
so natural-use precision and reversibility can be measured first.

Claim outcomes enter through an explicit, attributable boundary rather than
ordinary retrieval feedback. Pi exposes `nmg_remember action=claim_outcome`,
and the agent-neutral CLI exposes `nmg claim outcome`; both require a semantic
task ID, `supported|contradicted`, source class, and stable source lineage. An
optional session-owned Active Graph restricts votes to records actually exposed
by that retrieval. Retrieval, exact `get`, answer reuse, silence, and generic
task success never create positive claim votes. This wiring makes posterior
collection possible in ordinary use without weakening the promotion gate.
When Pi admits a user/tool outcome, it validates an exact current-session excerpt
and stores that excerpt as a deduplicated `HistoryRecord`; the outcome event keeps
its `evidenceId`. Removing or compacting the Pi transcript therefore does not
leave a posterior vote backed only by a dangling message ID. Task and benchmark
votes may retain lineage without copying arbitrary generated text.

Physical separation also means a new STG state cannot transactionally mark an
older consolidated LTG state superseded. The runtime STG/LTG projection
therefore reconciles active records with the same canonical `stateKey + scope`
and exposes only the newest event/valid/creation-time version; LTG wins an exact
tie. Time filters are applied before reconciliation, preserving the older state
for historical queries. This deterministic current-state invariant is separate
from posterior consolidation retraction: a single authoritative update must not
wait for several contradictory outcome votes before stale state disappears.

The atomic lifecycle also has an explicit reverse path. Promotion uses the
strict vote/mean/conservative-bound gate; an already materialized copy remains
active while it satisfies lower retained-mean and retained-lower-bound
thresholds. Once it falls below that hysteresis gate, NMG logically withdraws
only the active LTG row whose `consolidated_from_stg.sourceMemoryId` matches the
STG source. Manual or pre-existing LTG duplicates carry no such ownership marker
and cannot be retracted by STG feedback. Requalification creates a new LTG
version rather than reviving the withdrawn interpretation. The current cold
start thresholds and the LoCoMo official-evidence coverage/reversal audit are
recorded in `consolidation-evaluation-2026-08-09.md`; automatic actuation remains
off because that dataset has no authoritative false-promotion labels.

Identity maintenance uses an even stricter boundary. Repeated `same_as`
judgments accumulate observations and provenance on one pending proposal. A
read-only automation assessment requires a pending identity proposal, at least
five observations, mean confidence of at least 0.98, at least four active
evidence memories represented on both nodes, identical evidence scope, and no
pending `distinct_from` or `contradicts` proposal. Identity evidence must come
from user or tool sources, and the two nodes must share at least one source-actor
class; Assistant/system-authored identity guesses and disjoint provenance classes
cannot drive an automatic merge. The scope must expose exactly
one non-empty identity value, and its normalized canonical name must not already
belong to an active node. Passing this assessment is only eligibility by default:
automatic actuation is fail-closed unless `NMG_TOPOLOGY_AUTO_MERGE=1` is set.
When explicitly enabled, semantic maintenance actuates at most one eligible
`same_as` proposal per pass by default (configurable with
`NMG_TOPOLOGY_AUTO_MERGE_LIMIT`, hard-capped at four), records the transform ID
and any actuation error on the proposal, and uses the existing reversible merge
journal. Uncertain split and merge proposals remain pending for explicit review.

The first natural-conversation gate audit is recorded in
`topology-gate-evaluation-2026-08-09.md`. On LoCoMo speaker identities, 20/20
injected same-person early/late candidates passed, 10/10 injected cross-person
candidates were rejected by scope, all 20 eligible candidates lost eligibility
after a competing `distinct_from` proposal, and assessment caused zero topology
mutations. This validates the gate and its reversible proposal state, not
automatic candidate generation, alias resolution, or end-to-end false-merge
cost. The opt-in actuator and physical rollback now have deterministic coverage;
natural false-merge and reversal evidence remain prerequisites for enabling it
by default.

The matched product probe in `matched-evaluation-2026-08-09.md` also found no
answer-quality advantage for graph adaptation over NMG Lite (both 5/7) while
Graph performed additional retrieval work. This small result is a product gate,
not a universal benchmark claim: graph adaptation remains Lab-only and
unattended topology mutation stays disabled unless a larger matched evaluation
shows a reproducible benefit.

#### 7.3.1 Edge strength is not one scalar

NMG must not use one “thickness” value for truth, habitual access, and current
attention. Existing theories support three orthogonal quantities:

1. **Confidence** is an evidence-backed belief that the typed relation is valid
   in its time and scope. Supporting and contradicting independent source
   lineages update a Beta posterior `(confidence_alpha, confidence_beta)`.
   Factual edges use a conservative posterior lower bound as a gate.
2. **Usefulness/stability** estimates whether traversing the edge has repeatedly
   helped across independent semantic tasks. A separate Beta posterior records
   useful versus expanded-but-unused outcomes; an ACT-R-style recency/frequency
   base level may summarize repeated successful observations.
3. **Activation** is private to one AG and decays rapidly:

   ```text
   activation_e(t) =
     previous * exp(-lambda * delta_t)
     + eta * activation_source * activation_target
     + zeta * successful_current_path
   ```

   Outgoing activation is normalized and budget-clipped, following the
   stabilization lesson of Oja/BCM rather than unbounded Hebbian growth.

Co-activation or co-retrieval may create only a candidate associative
`related_to` edge. It cannot establish `causes`, `depends_on`, `constraint`,
supersession, or another strong directed relation without explicit evidence.
Every persistent confidence update must retain W3C PROV-style source/activity
provenance and deduplicate copied or repeatedly quoted evidence by source
lineage.

The runtime may combine these values without overwriting them:

```text
route_score =
  type_match
  * query_relevance
  * usefulness_lower_bound
  * factual_confidence_gate
  * (1 + mu * private_AG_activation)
```

Rare pinned or safety-critical constraints are exempt from access-frequency
demotion. In a UI, route score may temporarily control rendered line width, but
the storage model preserves confidence, usefulness/stability, and activation as
separate axes.

The model draws on
[ACT-R base-level and spreading activation](https://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/39jra_cds_2000_a.pdf),
[Collins–Loftus spreading activation](https://doi.org/10.1037/0033-295X.82.6.407),
[Oja-style normalized Hebbian learning](https://users.ics.aalto.fi/oja/papers.html),
[temporal tie decay](https://arxiv.org/abs/1906.09394),
[uncertain knowledge-graph confidence](https://doi.org/10.1609/aaai.v33i01.33013363),
and [W3C PROV-O](https://www.w3.org/TR/prov-o/). These are design sources, not
evidence that the proposed combination already improves NMG retrieval.

### 7.4 Adaptive semantic granularity

A node represents an observational equivalence class under current evidence:
records stay together while the system lacks reliable information to distinguish
their use. New evidence, scope, time, relations, or query behaviour can provide
the discriminating information needed to refine the class.

Two different operations must remain distinct:

- **Leaf/block split:** the node meaning is still coherent, but its evidence is
  too large or diverse for efficient local retrieval.
- **Node refinement:** one header no longer describes materially different
  entities, scopes, states, or query behaviours, so stable child/new nodes are
  warranted.

Candidate refinement signals include:

- high assignment or route entropy;
- several stable scope/entity clusters;
- a high contradiction or stale-state rate;
- repeated fallback from a node header to broad record scans;
- queries consistently using only one subset of the node;
- poor summary coverage of member evidence;
- stable co-retrieval or relational evidence between previously separate nodes.

Size alone is not a split condition. Topology changes use hysteresis: they
require a minimum evidence count, a gain threshold, and a cooldown period so
one unusual query cannot repeatedly split and merge the graph.

Merge/split operations preserve records and evidence, mark old nodes inactive,
and retain redirects. A split requires a complete, disjoint memory partition.

### 7.5 Node identity and reversible canonicalization

Node similarity is only a blocking signal that proposes pairs for comparison.
It does not authorize a merge. NMG distinguishes:

```text
SAME_ENTITY    same real-world object
EXACT_MATCH    concepts broadly interchangeable for retrieval
CLOSE_MATCH    concepts interchangeable only in some contexts
BROADER        source concept contains the target
NARROWER       source concept is contained by the target
RELATED        associated but independently meaningful
DIFFERENT      explicit non-identity evidence
```

This follows the distinction between strict identity and the weaker
`exactMatch`, `closeMatch`, `broader/narrower`, and `related` relations in
[OWL identity](https://www.w3.org/TR/owl2-rdf-based-semantics/) and
[SKOS](https://www.w3.org/TR/skos-reference). In particular, `CLOSE_MATCH` is
not transitive and must not create an equivalence closure.

Identity resolution uses three decisions rather than a forced binary merge,
following [Fellegi–Sunter record linkage](https://doi.org/10.1080/01621459.1969.10501049):

```text
log_odds_same =
  prior_log_odds
  + sum(feature_log_likelihood_ratio)

high confidence -> SAME_ENTITY candidate
middle interval -> possible link / human or Agent review
strong mismatch -> DIFFERENT
```

Names, embeddings, shared evidence, aliases, time, scope, stable external IDs,
and defining attributes are comparison features. Node-kind incompatibility,
different stable IDs, disjoint scope, event-time differences, incompatible
validity intervals, or explicit non-identity are hard vetoes. Correlated
features must be grouped or calibrated rather than counted as independent
evidence.

For concepts, merge is also a model-selection decision. An
[MDL](https://arxiv.org/abs/math/0406077) gain is positive only when one shared
description plus exceptions is shorter than two separate descriptions:

```text
delta_MDL =
  [L(separate_model) + L(data | separate)]
  - [L(merged_model) + L(data | merged)]
```

If a merged description needs many scope qualifiers, conflicts, or exceptions,
NMG keeps the nodes separate or creates a common broader parent. This mirrors
[COBWEB incremental concept formation](https://axon.cs.byu.edu/~martinez/classes/678/Papers/Fisher_Cobweb.pdf),
which compares adding, creating, merging, and splitting categories instead of
assuming merge is the only operation.

The safe lifecycle is:

```text
candidate pair
  -> classify identity/match/hierarchy relation
  -> shadow canonical view
  -> compare retrieval utility, conflicts, and MDL
  -> accept or reject
  -> reversible canonical view
```

Acceptance never physically deletes source nodes or evidence. The current
explicit (or deliberately enabled, strongly gated automatic) `mergeNodes`
actuator does move memory ownership to a target node and
rewrites its local relation neighbourhood, so each new merge also writes an
exact rollback journal: source/target node snapshots, original memory
assignments, and the complete pre/post relation sets. `node rollback` restores
that state in one immediate transaction only if every moved memory, involved
node status, and relation still matches the recorded post-merge state. It
refuses to overwrite later edits. A newly created merge target remains as an
inactive tombstone after rollback so stable IDs and audit history are not
reused; a pre-existing target is restored exactly. Merge transforms created
before journaling cannot be rolled back automatically. A later split reassigns
only evidence with known provenance; ambiguous members remain under the
old/common parent rather than being guessed into a child.

Node kinds require different defaults:

- entities may become `SAME_ENTITY` under strong identity evidence;
- concepts normally use exact/close/hierarchical relations;
- states with different time or scope use `SUPERSEDES` or coexistence, not merge;
- repeated events remain distinct events and may share an event/problem cluster.

Because false merges are more destructive than missed merges, automated
identity uses a high asymmetric-loss threshold. The default action for uncertain
pairs is a typed link, not a merge.

The BPID hard-negative audit (`topology-bpid-evaluation-2026-08-09.md`) shows
why that threshold cannot be supplied by raw field similarity: even a `0.98`
multi-field blocking score selected 19 false matches among 241 candidates while
recalling only 222 of 4,333 true matches. Candidate generation and identity
acceptance are therefore separate stages. A cheap blocker may bound semantic
review, but its score is not accepted as calibrated merge confidence.

The optional Namesakes adapter (`topology-namesakes-evaluation.md`) makes that
separation explicit for ambiguous names. It uses labelled `Same`/`Other`
mentions to report alias-like positive recall and exact-name negative rejection
over a full threshold curve. It is a streaming, read-only Lab evaluation; it
does not submit proposals or export a benchmark threshold into Core. The
official Entities split was run in full (4,148 rows; 23,996 scored mentions).
The local hashing baseline cannot separate aliases from namesakes: at threshold
0.5 it gives 0.942 recall, 0.716 precision, and rejects only 0.026 of exact-name
negatives; at 0.7 rejection rises to 0.684 while recall collapses to 0.304. It is
therefore acceptable only as a broad candidate generator, never as merge
confidence or an automatic topology actuator.

A fixed ten-entity paired Agent probe additionally compared clean `Same`
evidence with the identical evidence plus one high-scoring record taken from a
separately resolved foreign entity page. Across five stochastic repeats and 50
paired observations, DeepSeek V4 Flash exact attribution was 84% clean versus
88% contaminated; five pairs became wrong, seven became correct, the exact
McNemar p-value was 0.774, and no foreign record was accepted. The corrected
probe therefore finds no stable downstream attribution effect on this small
sample. Natural correction/recovery cost, larger-pair behavior, and end-to-end
answer damage remain unmeasured. Automatic identity mutation remains off.

The implemented `remember` boundary enforces that distinction. After saving a
memory, an Agent may classify one bounded candidate as `same_entity`, `related`,
`refines`, `conflict`, or `distinct`. NMG validates that both evidence memories
belong to the same physical LTG or session-owned STG store, conservatively
rejects identity/refinement/conflict claims with incompatible scope, and rejects
conflicts whose explicit validity intervals do not overlap. It then stores a
provenance-bearing **pending topology proposal**. `same_entity` creates a
regulatory `same_as` proposal; it does not call `mergeNodes`, redirect an ID, or
change either node's status. Proposal review and physical identity merge remain
separate maintenance operations. The daemon exposes one typed topology-proposal
administration RPC, and the CLI provides `topology proposals`, `assess`, `review`,
and `actuate`. Assessment is read-only; review records an explicit decision; and
actuation still accepts only an eligible accepted automatic merge proposal.
These operations remain outside the Pi model-facing tool surface.

## 8. Information and communication interpretation

The information-theoretic model is a design and evaluation framework, not a
requirement to implement a literal codec:

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

STG retains recent or provisional symbols before structural coding is stable.
LTG stores durable atomic memories and consolidated relations. The Active Graph
decodes only the bounded projection needed by the current task. Node headers are
short lossy codes, leaf headers add discriminating bits, typed relations provide
side information, and raw history prevents irreversible loss.

This interpretation supplies vocabulary and measurable objectives; it does not
claim that the implementation is a literal communications channel or that
semantic errors are independent bit flips. The distinction between implemented
mathematics and structural analogy is maintained in
[`math-physics-foundations.md`](./math-physics-foundations.md).

The topology can be evaluated with a minimum-description/rate-distortion
objective:

```text
J = structure_cost
  + lambda * semantic_distortion
  + mu     * retrieval_cost
  + nu     * maintenance_cost
```

Semantic distortion is not bit error rate. Relevant observable errors include:

- wrong node or block routing;
- missing supporting evidence;
- wrong scope;
- stale state selection;
- summary/evidence inconsistency;
- false relation expansion.

Hybrid signals act as error-correcting redundancy: FTS/exact terms, embeddings,
time/scope fields, graph paths, and raw evidence can correct one another's
failures. A structural change is justified only when it reduces expected
retrieval distortion enough to pay for its added complexity and maintenance.

## 9. Session capture and write path

Completed Pi turns are not copied automatically. Pi remains the owner of its
complete session history. During an accepted `nmg_remember`, the adapter may
resolve the LLM-selected evidence against the active Pi branch and retain only
that exact excerpt with stable `(session_id, source_message_id)` provenance.
NMG therefore stores governed evidence rather than a cumulative transcript
snapshot. A future `HistoryProvider` boundary may resolve other harness
references or provide managed copies for harnesses without durable history.

Session storage and semantic extraction are separate:

```text
Pi message/turn
  -> turn-local pending evidence
  -> governed extraction/admission
  -> zero or more retained HistoryRecord excerpts
  -> zero or more governed MemoryRecord writes into STG
  -> optional immediate atomic promotion into LTG
  -> later evidence-backed structural consolidation
```

NMG uses selective historical admission rather than duplicating every Pi
message. A message body becomes durable NMG history when it supports an accepted
memory, records an explicit user retention request, preserves a decision or
unresolved obligation, captures a conflict/exception, or contains an
irreproducible result. Otherwise Pi remains the temporary transcript owner and
NMG keeps no second body copy.

Admission has three current outcomes:

```text
reference  source/message identity only; body remains in the harness
excerpt    exact bounded source excerpt plus provenance
discard    no NMG history row
```

The same stable Pi write tool also exposes explicit logical withdrawal:
`nmg_remember action=forget` requires an exact memory ID and is intended only
for an explicit user request. NMG marks the record deleted, removes it from
normal retrieval and derived indexes, and retains a tombstone for audit. The
CLI equivalent is `nmg memory delete MEMORY_ID`. Neither interface claims to be
physical privacy erasure; full provenance and aggregate-signal erasure is a
separate lifecycle operation.

User-owned data is exportable without opening SQLite directly. `nmg memory
export --json` emits a versioned `nmg.memory-export.v1` bundle containing each
MemoryRecord, its MemoryNode, and all retained HistoryRecord evidence/provenance.
The default actor filter is `user`; `--all-actors` and `--include-deleted`
broaden the export explicitly so routine Agent/tool material and tombstones are
not included accidentally.

The default Pi path treats a successful governed `nmg_remember` write as the
positive admission signal. The adapter resolves its exact `evidence` against
the most recent bounded window of the current Pi branch, preserves the original
case from the matched source, and binds the HistoryRecord by stable source
message ID. The projection contract is versioned as `pi.branch.v1`; an
incompatible Pi message shape fails closed to the self-contained evidence path
rather than binding false provenance. Evidence longer than the deterministic excerpt bound is not copied
through this path and should instead use an explicit external artifact
reference. If the source cannot be resolved, the supplied evidence remains a
self-contained explicit fallback. This keeps selected evidence after Pi deletes
a session without paying to preserve ordinary conversation.

Clear, stable user-stated facts, preferences, constraints, and replaceable
states may become atomic LTG memories automatically. They do not need to wait for
a stable local subgraph. Ambiguous, inferred, sensitive, or current-task-only
candidates remain in STG, require confirmation, or expire according to policy.
Inferred relations and derived concepts require repeated independent evidence
before structural consolidation. Casual chatter, credentials, secrets, and
unverified model claims do not become verified semantic memory. Assistant
content may be retained as unverified conversation evidence when it is useful to
remember that it was said.

### 9.1 `remember` as the semantic maintenance boundary

Attribution is fail-closed at the harness boundary. The Pi adapter defaults an
unspecified `sourceActor` to `assistant`; a record attributed to `user`, `tool`,
or `system` must bind an exact excerpt from that actor in the current session,
or carry explicit external provenance. This prevents an Agent inference from
silently acquiring user authority before Core admission and consolidation.

`remember` is the deliberate LLM intervention point between semantic judgment
and deterministic storage. The two sides have different responsibilities:

| LLM / Agent                                                                                                                                                                                                   | NMG core                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extract a self-contained statement; assign type, actor, time, scope, and importance; decide whether a returned candidate is the same meaning, a genuinely replaced old value, a related concept, or distinct. | Enforce admission policy, stable IDs, exact deduplication, scope/state invariants, provenance, transactions, index deltas, version history, and reversible graph changes. |

The common path remains one call. NMG writes the governed atom and returns only
a bounded set of ambiguous near-duplicate or supersession candidates. When a
candidate requires semantic judgment, the Agent may submit a second phase
through the same `nmg_remember` tool. The first implemented resolution is
`supersede`: the Agent identifies the new and stale record; NMG verifies that
both records exist in the same LTG or session-owned STG store and have identical
scope before applying the versioned replacement. Similarity alone never
authorizes replacement.

Exact duplicates and stable `stateKey + scope` replacement remain deterministic
and need no LLM round trip. Physical node merge, split, deletion, and arbitrary
SQL mutation are not part of model-facing `remember`; they require stronger
validation and remain reversible maintenance operations. This preserves a
small tool surface while allowing model capability to improve semantic
organization without moving database invariants into prompts.

Tool output and logs are ephemeral by default. NMG does not duplicate their
result bodies during session capture. A model or user may explicitly promote a
bounded exact excerpt, an irreproducible result, or a requested full artifact
through the governed memory/evidence path; that retained evidence keeps its tool
source identity. Successful routine output, build logs, and reproducible command
output remain in the harness history and follow its retention policy. Secrets
and credentials are never promoted automatically.

Raw-event identity and content storage are separate concerns. Repeated events
may retain distinct timestamps and provenance while sharing one
content-addressed body in a future object layer. Exact hash/identity
deduplication is safe for evidence; embedding-based semantic deduplication is
reserved for mutable memory organization and must not erase distinct historical
events.

Replaceable state uses a stable semantic `stateKey` plus canonical scope. A new
active value supersedes the prior value without deleting historical evidence.
Reuse the key only when the new value makes the old one no longer current; two
values that can remain true together (for example a personal best and a target)
are separate properties and require separate keys.

> **预留接口（未实现，用户明确不需要）** — `RememberInput.judgeDuplicates`
> (`DuplicateJudge`, `src/core/types.ts`) 允许 NMG 自身接入独立模型，在
> `remember` 内联裁决 near-duplicate 的 merge/supersede，而非依赖调用方
> Agent 的二阶段判断。当前为零实现（daemon RPC 与扩展均不传该字段，仓库内
> 无 judge-provider）；裁决仍走上文“Agent 二阶段 supersede”路径。如需接通：
> `NMG_JUDGE_*` 配置 + daemon 侧 judge-provider + judge 不可用时降级回算法
> 候选。决策记录：LTG memory `54599c45`。

## 10. Incremental storage and index maintenance

Writing a memory must not trigger a full vector/index rebuild.

```text
new MemoryRecord
  -> persist transactionally
  -> add to searchable Delta
  -> mark affected leaf/node dirty
  -> query Base + Delta immediately
  -> compact/rebuild affected regions later
```

`STG/LTG` and `Base/Delta` are orthogonal dimensions. STG/LTG describe semantic
lifecycle and consolidation status. Base/Delta describe physical index
maintenance. An LTG fact can be in Delta immediately after insertion, and an STG
candidate can already be compacted into Base without becoming long-term memory.

Maintenance has three scopes:

1. **Local:** rebuild only the affected block, leaf vector, or node header.
2. **Accumulated:** compact when record/token/dirty-ratio thresholds are reached
   or during an idle period.
3. **Neighbourhood:** batch nearby dirty nodes when they share records,
   embeddings, or likely topology work.

The resident service implements the accumulated scope as an amortized queue.
Writes increment durable per-node `memory_index_delta` rows and exact memory
use increments `pending_access_count`; a small process-local counter avoids a
database due-check after every call. On the first signal after daemon startup,
and thereafter only when a threshold is crossed, an event-loop maintenance
slice examines at most a bounded number of nodes. It rebalances tiers for due
access changes, compacts due leaf blocks, acknowledges their Delta rows, and
records `maintenance.batch` latency plus rows touched. Defaults are centralized
in `src/integration/config.ts` and may be overridden with
`NMG_MAINTENANCE_WRITE_THRESHOLD`, `NMG_MAINTENANCE_ACCESS_THRESHOLD`, and
`NMG_MAINTENANCE_NODE_LIMIT`. A separately bounded semantic phase runs on the
first daemon backlog check and then every configured number of productive local
batches (`NMG_MAINTENANCE_SEMANTIC_EVERY`). It expires a limited number of STG
records, reconciles a limited number of independently observed relation pairs,
and generates—but never automatically accepts—a limited number of topology
proposals. Failed slices leave durable counters intact for a later retry and
never turn a successful `remember` into a failed write.

The due check is deliberately a dual trigger. A single hot node is selected as
soon as its own write or access counter reaches the corresponding threshold. If
many sparse nodes keep every local counter below the threshold but their global
pending total reaches it, the same bounded slice selects the largest then oldest
non-empty node backlogs. The resident service schedules another bounded slice
while a full `nodeLimit` batch was consumed, so pressure falls below the global
threshold without an unbounded synchronous pass. A below-threshold tail remains
deferred; it is bounded rather than permanently growing. This preserves local
Huffman-style rebalancing while preventing small-node graphs from starving Base
compaction.

Topology proposal acceptance remains an explicit semantic review. Edge
stability can justify reversible relation consolidation or demotion, but it
cannot establish node identity and therefore cannot authorize a node merge.

SQLite is authoritative and should own transactions, content hashes, version
markers, dirty queues, FTS, and crash recovery. NMG decides semantic grouping,
summary invalidation, and topology changes. A process-local contiguous
`Float32` matrix may cache active record, node, or leaf embeddings; it is
disposable and rebuildable from versioned binary vectors in storage.

ANN is optional. It must not replace exact vector scanning until exact-vs-ANN
recall audits show acceptable quality at a scale where exact scanning violates
the latency budget. Current near-duplicate tests and the LoCoMo record-vector
run do not justify enabling the prototype USearch path or a separate vector
database by default.

Long-lived storage adds two lifecycle states after the indexed cold tier:

```text
L0 Hot -> L1 Warm -> L2 Cool -> L3 Cold
        -> L4 Dormant/Unindexed
        -> L5 Quarantine
        -> physically deleted
```

L4 retains authoritative content and minimal lookup metadata but removes the
record from normal FTS, vector/ANN, automatic recall, recommendations, and
Active Graph construction. It remains addressable by stable ID and explicit
archive search. Embeddings and other rebuildable caches may be discarded.
Explicit reuse does not have to promote a record immediately: repeated use, an
active project, or a user restore request can return it to an indexed tier and
rebuild the necessary indexes.

L5 is a deletion-candidate zone, not an ordinary memory tier. A record enters it
only after a further retention interval and a dependency/protection review. It
is invisible to retrieval during a configurable recovery window, after which
its content and dependent indexes may be physically purged. Eligibility must
combine age, time-decayed use, importance, lifecycle state, and dependency
coverage; access count alone is insufficient. Pinned memories, current states,
critical constraints, conflicts/exceptions, user-protected records, active
references, and sole evidence for a surviving conclusion are not automatically
eligible.

Normal retention cleanup follows `indexed -> dormant -> quarantine -> purge`.
An explicit privacy deletion may bypass the recovery window and must propagate
through evidence links, summaries, FTS/vector/ANN entries, caches, and learned
signals. In the initial implementation these states may remain rows in one
SQLite database; physical cold partitions are an optional future optimization.
History is immutable while retained, not guaranteed to be retained forever.

The current store implements these states as
`memory_records.storage_state = indexed | dormant | quarantine`, independently
of retrieval `tier = 0..3`. `setMemoryStorageState` performs explicit
transitions: entering L4/L5 removes FTS, record embeddings, pending index
deltas, leaf membership, and in-memory vector-cache entries; restoring to
`indexed` rebuilds FTS immediately and queues rebuildable semantic indexes.
Stable-ID `getContext` remains available for L4/L5 recovery. The conservative
`retentionCandidates` API is dry-run only and protects STG records, preferences,
states, constraints, contradictions/exceptions, marked records, high-value or
frequently used records, and evidence with surviving derivations. Automatic
purge is deliberately not implemented.

Physical privacy erasure is a separate, explicit operation with a stronger
contract than logical withdrawal. Its implementation must run as one reviewed
job and produce an erasure receipt containing only non-sensitive identifiers
and counts. The required propagation order is:

1. compute the unsupported derived-memory closure and freeze concurrent writes;
2. remove memory/evidence links, deleting a HistoryRecord body only when no
   surviving memory, relation, or audit obligation references it;
3. remove vectors, FTS rows, leaf membership, ANN/cache entries, dirty deltas,
   claim events/posteriors, and proposals based on erased evidence;
4. delete retrieval traces that referenced the target rather than merely
   editing result arrays, because their query text may repeat the private fact;
5. invalidate and rebuild summaries, relation evidence, aliases, and empty nodes
   whose material depended on erased content;
6. reset non-subtractable learned node/edge/controller aggregates for affected
   identities and invoke adapter-specific erasure hooks for shadow logs/caches;
7. physically delete target and unsupported derived rows, then use SQLite
   secure-delete/VACUUM or encrypted-key destruction for the deployment threat
   model.

Until that full job and adapter-hook contract exist, `forget`/`memory delete`
must describe themselves as logical withdrawal. The logical path is tested to
remove normal retrieval, FTS, record embeddings, leaf membership, index deltas,
claim state, evidence links, unsupported derivations, in-process vector-cache
entries, Active Graph references, and pending evidence-dependent proposals.

## 11. Progressive retrieval

Progressive retrieval constructs and expands the Active Graph; it is separate
from both storage tiers and the STG/LTG lifecycle:

1. **Resident layer:** a very small query-independent seed of critical
   constraints and stable profile information placed into every relevant AG.
2. **Automatic recall layer:** bounded dynamic selection from STG and LTG based
   on the current query, task, scope, time, and available budget. A harness-side
   memory gate first chooses `retrieve`, `cue`, or `none`; `none` must not search
   or inject dynamic long-term memory. Ordinary code inspection, tests,
   calculations, formatting, and other self-contained turns therefore remain
   memory-free. The gate may retain bounded task anchors so a terse continuation
   can recall the immediately preceding task without treating every substantive
   prompt as a history query.
3. **Agent-directed recall layer:** compact headers/cues that let the model call
   `nmg_search`, inspect costs, and expand the AG with exact details through
   `nmg_get`.

The third layer is additionally bounded as a tool process, not just as returned
information. Repeated candidate sets count as no progress, an exact `get` only
unlocks further search when it loads previously unseen evidence, and hard
per-turn search/tool ceilings terminate loops even when QPP keeps recommending
expansion. Progressive disclosure therefore governs both content volume and the
number of disclosure actions.

Candidate generation should compose independent signals:

```text
Inbox/Delta + global FTS/exact + fine-grained record semantics
  -> optional node/leaf semantic routing at measured large scale
  -> optional graph expansion
  -> scope/time/truth filtering
  -> type-aware reranking and diversity
  -> bounded Active Graph projection
  -> compact headers and selected exact evidence
```

Search modes are ordered by purpose:

- semantic/vector search for meaning;
- FTS5 for lexical retrieval;
- exact literal/phrase and structured filters for paths, versions, IDs, dates,
  scopes, and error codes;
- regular expression only as an advanced/debug fallback over a bounded candidate
  set or raw session subset.

Arbitrary model-generated regex is not a relevance ranker and must not scan the
entire store by default. Exact literal search is the first precision feature to
add because it covers most code-agent identifiers without regex escaping or
catastrophic-backtracking risk.

### 11.1 QPP actuation and progressive disclosure

QPP is an optional control plane over the same Active Graph retrieval path, not
a separate store or retrieval engine. Its three actions are independently
configurable because they have different costs and failure modes:

1. **QPP1** predicts how broad the first candidate pool should be. It can
   observe without acting or allocate a bounded initial Fibonacci tier.
2. **QPP2** operates only inside the candidate pool. It may continue
   progressive inspection and decide which headers are individually visible
   versus folded.
3. **Search recommendation** converts insufficient automatic recall into an
   advisory signal for the model. It never invokes a tool by itself.

NMG's responsibility ends at producing auditable scores and measuring each
module's quality and cost. Whether to activate a module, and which modules to
compose, is operator policy rather than a learned NMG decision. The project
does not need to optimise or endorse a combinatorial configuration.

QPP2 performs progressive disclosure rather than deletion. Let the controller
produce listwise necessity scores `s_i`; convert them to relative odds and
normalised local mass:

```text
o_i = clamp(s_i) / (1 - clamp(s_i))
p_i = o_i / sum_j(o_j)
```

The visible directory is the smallest score-ranked set whose cumulative local
mass reaches a configured retention target. Retrieval Top-1 is the only fixed
safety anchor. A flat distribution therefore remains wide, while a steep
distribution folds more candidates. Folded candidates remain in the Active
Graph and retrieval trace and must stay explicitly unfoldable.

The mass is a query-local relative allocation, not a calibrated absolute
probability that a record is necessary. QPP2 therefore remains opt-in until
matched tests show that the model can use the folded directory without losing
answer evidence. Concrete Pi settings, defaults, compatibility variables, and
operator instructions belong in the README rather than this architecture
contract.

## 12. Learnable routing and minimal differentiable query graphs

NMG contains a zero-dependency, CPU-optimised UOp autodiff engine built entirely
on Float32Array. It follows tinygrad's separation of concerns: Tensor is a
graph-building frontend over the UOp DAG, evaluation is lazy, and gradient
construction is separate from graph execution. NMG deliberately omits
scheduler, kernel lowering, code generation, JIT, and device runtime because
the controller workload (~280 KFLOPs/query) does not justify them.

This engine is Lite infrastructure, not a claim that STG, LTG, or AG are
themselves differentiable. Those graphs are semantic and runtime data
structures. A controller may build an ephemeral differentiable projection from
their numeric features, optimise its parameters, then hand the result back to
ordinary budgeted graph selection.

The Pi adapter has a lazy controller bridge. `NMG_CONTROLLER_SHADOW=1` enables
telemetry without actuation; QPP1/QPP2 `active` are the explicit operator gates
that permit a trained controller to allocate a bounded Active Graph budget or
fold low learned-probability candidates. A zero-step controller is inert, and
all active outputs remain inside hard minimum/normal/expanded envelopes.

The bridge records baseline and learned node order in a bounded log under
`NMG_DATA_DIR`. Exact records fetched from a session-owned Active Graph are
logged as disclosure; the conservative answer-to-memory matcher used by
automatic recall is logged as diagnostic attribution. Neither trains the
controller. Evidence ranking and budget heads train only from verified
user/tool/official-benchmark evidence joined offline. Injection, rank position,
mere exposure, answer overlap, and silence are never positive labels. Explicit
`nmg_remember action=feedback`
labels remain a separate source for task success, evidence sufficiency,
expansion utility, noise, and no-memory-needed judgments; cross-session graph
IDs fail closed. Missing explicit feedback remains unknown. Thus shadow mode
cannot change retrieval, while active QPP modes are an explicit experimental
product choice rather than an automatic calibration promotion.

All ordinary clients resolve the shadow log and database through one data-path
contract: explicit `NMG_DATA_DIR` wins, otherwise the user-level `~/.nmg` store
is used. Controlled/headless evaluations pass a project-local `.nmg` fallback or
set `NMG_DATA_DIR` explicitly. The Pi extension, daemon client, CLI service,
shadow exporter, and non-Pi adapter share this resolver. **Implemented and
covered by path-contract tests.** This distinction prevents ordinary long-term
memory from fragmenting by working directory while keeping benchmark state
isolated.

Because answer-quality labels only become observable after an Agent turn, the
Pi bridge keeps completed retrievals whose evidence was actually disclosed and
whose explicit task labels are missing in session-local state. Diagnostic answer
overlap does not participate in this choice. On the next distinct user turn the
bridge exposes at most one one-shot
review reminder containing the AG ID and stable query task ID. Internal Pi tool
loops with the same user prompt cannot consume the reminder. The Agent may
submit `evidenceSufficient`, `expansionUseful`, `excessiveNoise`, and
`noMemoryNeeded` through the existing remember feedback action. Missing review
remains unknown; completion, silence, exposure, or lack of a correction is not
itself a label.

Reminder exposure is logged as a non-training `tool_flow/feedback_nudge_shown`
event. This separates "the Agent skipped an observable reminder" from "no
reminder was presented" without turning either case into a relevance label.
Query-derived task IDs establish lifecycle separation, not semantic diversity;
calibration must additionally require enough varied natural tasks and must not
count paraphrases of one decision as broad evidence.

The stable daemon already owns agent-neutral `search -> get(activeGraphId)`
disclosure tracking and diagnostic answer attribution. The richer feedback
action stays in the Pi adapter because only the
harness can observe answer completion, user correction, tool rounds, and model
usage. A future second adapter should implement the same versioned shadow-event
contract rather than adding a Lab-dependent feedback method to the stable daemon
protocol.

The same bounded log records harness-level progressive-disclosure interventions
as separate `tool_flow` events. In particular, a third explicit search made
without loading evidence is recorded as `search_suppressed`; it is not counted
as a retrieval, a task success, or a relevance label. This makes prompt/tool
loops measurable without contaminating controller training targets.

Retrieval events retain the existing AG query fingerprint, QPP components and
expansion stages, and per-selection scores. The offline controller-dataset
exporter joins retrieval/disclosure/attribution/outcome/feedback by graph,
accepts only separately labelled rows, and performs a chronological split over whole
`semanticTaskId` groups. Query fingerprints remain diagnostic identifiers and
are never promoted to semantic-task labels. Sparse logs produce explicit
blockers and cannot authorize a policy change.

Task grouping alone is not a sufficient leakage barrier. Query-derived task IDs
can differ for paraphrases that share the same evidence. Calibration therefore
derives a conservative **primary evidence target** only from verified claim
support, never from loading or answer overlap. The activation gate requires
enough distinct primary targets in training
without letting one multi-evidence task inflate the diversity count. Leakage is
checked more strictly against the complete verified-evidence sets: any memory used by
both training and validation rejects the split, even when it was not the primary
record in either row. The primary target is a diversity proxy, not a claim that
one record completely represents a semantic task; multi-evidence questions
retain their complete verified-evidence set in the replay row.

Every new retrieval event also stores the exact
`CONTROLLER_FEATURE_PROTOCOL_VERSION` feature snapshot and the contemporaneous
Active Graph hard-budget envelope. This is required for offline replay: labels,
QPP scores, and observed cost alone cannot reconstruct the controller input or
its normalized budget targets. Legacy rows without either snapshot are reported
and excluded.

`npm run eval:controller-calibrate` consumes only fully labelled chronological
train/validation rows. It trains a fresh candidate, evaluates baseline versus
residual learned node ranking plus the generic stop/expand head, reports
retrieval/controller/end-to-end/token/tool costs, and writes an auditable
candidate artifact with source-log fingerprint, feature version, effective
configuration, data window, metrics, and rollback-state fingerprint. The
artifact is never installed automatically and always reports
`eligibleForActivation: false`; activation remains a later matched gate.

That later gate is now explicit and has three independent parts. The retrieval
gate protects upstream candidate recall; the controller gate protects held-out
ranking/control quality and inference latency; and the product gate requires a
matched baseline/candidate comparison with enough paired cases. The product gate
fails closed when matched evidence is absent and requires non-degraded task
success and evidence sufficiency together with bounded mean tool rounds, tokens,
and end-to-end latency. These product costs are not added to the AG allocation
head: tool rounds include non-NMG tools, and observational task success does not
identify the causal effect of a memory action. Hard AG and harness limits remain
outside the differentiable graph.

Progressive disclosure also constrains tool sequence, not only returned text.
Within one Pi user turn, automatic recall is free, but after two explicit
searches without loading selected evidence the adapter folds another search
into a request to call `nmg_get` or use a current-source tool. A successful
exact get reopens search for a complementary hop. The guard is keyed by Pi
session plus user prompt because `before_agent_start` also fires during internal
tool loops; resetting on that lifecycle event alone would make the bound
ineffective. This is a harness cost/safety boundary, not a relevance judgment
and not a replacement for QPP.

### 12.1 UOp op catalogue

```text
┌───────────────┬──────────────────────────────────────┬──────────────────┐
│ Op            │ Forward                               │ Shape            │
├───────────────┼──────────────────────────────────────┼──────────────────┤
│ Add           │ a[i] + b[i]                           │ element-wise     │
│ SumN          │ Σⱼ srcⱼ[i]  (N inputs, one pass)      │ element-wise     │
│ Multiply      │ a[i] * b[i]                           │ element-wise     │
│ Negate        │ -src[i]                               │ element-wise     │
│ Broadcast     │ fill shape with scalar src[0]         │ any              │
│ Matmul        │ left @ right  (ikj cache-friendly)    │ [Lr, Rc]         │
│ Transpose     │ result[col·rows+row]=src[row·cols+col]│ [cols, rows]     │
│ Sum           │ Σ src[i] → scalar                     │ [d1,d2] → [1,1]  │
│ Exp           │ exp(src[i])                           │ element-wise     │
│ Log           │ log(clip(src[i], 1e-7))               │ element-wise     │
│ Reciprocal    │ 1 / clip(src[i], 1e-7)                │ element-wise     │
│ Sigmoid       │ 1 / (1 + exp(-src[i]))                │ element-wise     │
│ Softmax       │ exp(x-max) / Σexp(x-max)              │ element-wise     │
│ SoftmaxGrad   │ prob[i]·(grad[i] - Σprob·grad)        │ element-wise     │
│ L2Normalize   │ src[i] / ||src||                      │ element-wise     │
│ L2NormGrad    │ (grad[i]-output[i]·dot)·invNorm       │ element-wise     │
│ Index         │ src[idx] → scalar                     │ [n,...] → [1,1]  │
│ Scatter       │ src[0] → result[idx]                  │ [1,1] → [n,...]  │
│ Constant      │ stored Float32Array, no gradient       │ any              │
│ Parameter     │ stored Float32Array, requires gradient  │ any              │
└───────────────┴──────────────────────────────────────┴──────────────────┘
```

### 12.2 Performance optimisations

Element-wise ops use raw `for` loops. Matmul uses ikj loop order for cache
locality. `Negate` is compile-time folded from `multiply(x, Constant(-1))`.
`SumN` fuses chain-add sequences into a single N-input op. `Tensor.fromBuffer()`
enables zero-copy constant construction. Controller auto-batches inputs into
`[F,B]` matrices at threshold B≥8.

### 12.3 Architecture

The persistent semantic graphs, the Active Graph, and the differentiable
computation graph are distinct objects:

```text
persistent STG + LTG in SQLite
  → construct bounded Active Graph
  → HierarchicalActivation.propagate(query, candidates, neighborhood, graphState)
     ├─ g₁: query → candidates cross-attention (learnable temperature)
     ├─ g₂: g₁ → neighborhood cross-attention
     ├─ g₃: L2Normalize(g₁+g₂+h₁+h₂+h₃)  spatial fusion
     ├─ h₁: EMA of g₁ across propagate() calls  (short-term temporal)
     ├─ h₂: mean of medium-term stable vectors   (from graphState)
     ├─ h₃: mean of long-term stable vectors     (from graphState)
     └─ 7-weight blended scoring → nodeScores
  → DifferentiableController(node/edge/control/budget scores)
  → discrete Top-K selection → Active Graph expansion
```

The computation graph is ephemeral — created per propagate/train call and
discarded. SQLite, the semantic graph, provenance, consolidation, and discrete
Top-K selection remain ordinary deterministic system components.

Variable semantic granularity remains an experimental question. Hierarchy-only,
record-vector, and independently ranked union retrieval are retained as
diagnostic modes, but none is a mandatory NMG representation until a matched,
fingerprinted, repeated benchmark demonstrates a quality/cost advantage.

## 12bis. Memory-Graph Reasoner — retained numerical Lab prototype

`MemoryGraphReasoner` is retained unchanged as a numerical experiment. It is
not part of NMG Lite and is not the session reasoning scratchpad described
below. The current implementation repeatedly scores all unvisited nodes; it
does not yet constrain the next step to outgoing semantic edges. Consequently,
its path must not be described as knowledge-graph traversal or used as evidence
that NMG can perform logical inference.

### Concept

Instead of treating memory nodes as passive data scored by a fixed function,
each node is a **micro-operator** that transforms the query state during graph
traversal. The traversal path itself is the computation graph—gradients flow
through every visited node back to per-node parameters.

```text
q₀ ──→ [node A] ──→ q₁ ──→ [node B] ──→ q₂ ──→ [node C] ──→ q₃ → path loss
```

### Node operator

The state update has three named degrees of freedom, inspired by Kimi Delta
Attention (FlashKDA, MoonshotAI):

```text
g = σ(v^T @ q + b_log)       absorption — how much of THIS node to take in
A = σ(a_log)                  decay — global forgetting rate (0=wipe, 1=keep)
β = σ(β_log)                  retention — old state vs new state blend

q_tmp = A·q_old + g·v         decay old context, absorb new memory
q'    = β·q_tmp + (1−β)·query  output blend with original query anchor
r     = q'^T @ v              local relevance score
```

| Parameter | Scope    | Meaning                                                       |
| --------- | -------- | ------------------------------------------------------------- |
| `b_log`   | per-node | Higher = more absorption from this memory                     |
| `a_log`   | global   | Higher = retain more past context across steps                |
| `β_log`   | per-node | Higher = output favours accumulated state over original query |

Nodes may declare `requires: string[]` — fact node IDs that must be active
for the gate to open. Precondition score is the product of fact activations
(soft-AND). Inactive facts close the gate, structurally excluding the node
from the traversal path.

### Relationship to HierarchicalActivation

|                 | HA                        | MGR                            |
| --------------- | ------------------------- | ------------------------------ |
| Node role       | passive data, scored      | active operator, transforms    |
| Scoring         | 7-way similarity blend    | single gate + local relevance  |
| Graph structure | fixed candidate hierarchy | global unvisited candidate set |
| Parameters      | 9 global                  | 2/node + 1 global              |
| Best for        | batch ranking over pool   | multi-step path reasoning      |

They remain separate Lab experiments. MGR currently refines a query through a
sequence of selected node operators; graph-constrained traversal is future
work that requires its own correctness benchmark.

### API

```ts
const mgr = new MemoryGraphReasoner(64);

// Greedy traversal
const result = mgr.traverse(queryVector, graph, maxSteps);

// What-if simulation: inject hypothetical node, compare traversals
const impact = mgr.whatIf(queryVec, graph, hypotheticalNode, maxSteps);
const summary = mgr.impactSummary(impact, "task-x"); // compact LLM-ready text

// Train on labelled operator sequences
mgr.trainPath({ queryVector, pathNodeIds, graph }, learningRate);

// State round-trip
const json = mgr.toJSON();
const clone = MemoryGraphReasoner.fromJSON(json);
```

### Experimental status

MGR can produce deterministic traversal and what-if summaries for experiments,
but it is not currently integrated into Pi and is not a verified
LLM-offloaded reasoning engine. Correctness and graph-edge adherence must be
demonstrated before such an integration is considered.

```text
LLM context                    MGR (external)
───────────                    ─────────────
User: "What if we add task X?"
                               ┌────────────────────────┐
LLM → MGR.whatIf(              │ baseline: A→B→C→D      │
  query, graph,                │ with X:   A→B→C→X      │
  hypoNode=X, steps=4          │ D: exited, score +0.24 │
)                              └────────────────────────┘
         ← impactSummary()
         ← "X enters at step 4, D exits, path +0.24"

LLM: "Adding X pushes D off the
      critical path."
```

### Differentiable set logic

Beyond chained traversal, MGR provides fuzzy set logic over the same node
vectors, implemented entirely inside the autodiff DAG (`LogicExpr`,
`logicSearch`, `trainLogic`). An atom maps every node to a membership
`σ(τ·cos(v, q))` — a soft set — and combinators are t-norm operators:
AND = product (intersection), OR = probabilistic sum (union), NOT = complement.
The only parameter is a global sharpness `τ`, trained contrastively.

A July 2026 qualitative probe (`evals/omnimemeval/mgr-logic-probe.ts`) ran the
operators on real LoCoMo multi-hop failures with BGE record embeddings:

- **Conjunctive questions are the sweet spot.** For "Which city have both
  Jean and John visited?", a single-vector query missed the second hop
  entirely, while `and(cities Gina visited, cities Jon visited)` recovered
  "trip last week to Rome" at rank 3 and kept the bridge turn (which mentions
  both Paris and Rome) at rank 1.
- **NOT is dangerous with broad atoms.** `and(promotion, NOT business talk)`
  collapsed all memberships to ≈0.02 and returned noise: near neighbours of
  the negated concept get suppressed along with the target. NOT atoms must be
  narrow, or the operator needs a learned damping exponent.
- **AND over-constrains coverage questions.** "How did Gina promote her
  store?" needs several dissimilar evidence turns, each matching only one
  atom; the product t-norm punished exactly those turns. Constraint questions
  want AND; coverage questions want OR or plain ranking with diversity.

One incidental finding: the pure-vector baseline in the probe outperformed the
production bridge on one question, reinforcing that bridge-level reranking
(actor policy, FTS interplay) can lose evidence that raw record vectors keep.

A second round of probes on the coverage failure ("How did Gina promote her
clothes store?") isolated the remaining bottleneck with hard numbers:

- **Metadata filtering is necessary but not sufficient.** Restricting
  candidates to Gina's turns (`source_actor`) removed the other speaker's
  noise, yet 3 of 4 gold turns still missed top-20.
- **The embedding's relevant band is too narrow.** Gold turns sit at cosine
  0.58--0.66 against the question, while the top-20 cut is ≈0.619 and the
  corpus median is 0.542 — a ~0.14 corridor where signal and filler mix.
  Aspect-decomposed sub-queries scored gold higher (up to 0.76), but the
  union of aspects is equally crowded. This is bge-small-en's discrimination
  ceiling, not an operator failure: coverage misses at this level need a
  stronger embedder or a larger budget (the K=40 ablation already showed the
  budget trade-off).
- **Fixed τ saturates real embedding distributions.** With the default
  τ = 8, on-topic memberships all collapse to ≈1.0 and OR/AND rankings
  degenerate into tie noise; τ ≈ 1 restores ordering. Membership sharpness
  must be calibrated per embedding space (or learned via `trainLogic`)
  before set logic composes meaningfully on real vectors.

Two derived operators complete the set: `nand(...)` = NOT(AND), functionally
complete but an anti-selector on its own (irrelevant nodes rank highest, so it
is only a building block or a differentiable conflict penalty — e.g. training
superseded states not to co-activate); and `xor(a, b)` = OR·NAND, which ranks
evidence belonging to exactly one side above ambiguous both-sides statements.

A follow-up BEAM probe (`evals/omnimemeval/mgr-xor-probe.ts`, conversation 1
contradiction_resolution questions) produced an important negative result:
**XOR fails on real embeddings because embeddings do not encode negation.**
"Never wrote Flask routes" and "implemented Flask routes" occupy the same
region of vector space, so every on-topic message is a both-sides member and
XOR suppresses exactly the contradictory evidence it was meant to surface
(top ranks filled with off-topic noise). `and(never, did)` degenerates into
plain topic retrieval — which does find the gold messages, but so does the
unmodified question vector (rank 3--4). Conclusion: contradiction detection
is not a retrieval-side set-logic problem with vanilla embeddings; it needs
polarity-aware signals (e.g. NMG's `truth_status`/conflict metadata or
reader-side detection). XOR remains valid only when the two atoms occupy
distinct vector regions.

A third probe tested the vector-native rescue for negation: a polarity axis
estimated as the mean difference of generic "never did X" vs "did X" sentence
pairs. The axis failed to transfer — gold contradictory messages landed
mid-pack (ranks 167/188 and 127/188), and its direction was essentially
orthogonal to the gold pair's own difference vector (cos 0.042). Sentence
differences in this embedding space are dominated by topic, not polarity:
**bge-small-en has no linearly recoverable negation direction.** An axis
fitted to minimal polarity pairs per domain might do better, but that is a
fragile per-domain artifact; the metadata/reader route remains the accepted
one.

A minimal-pair k-NN test (`evals/omnimemeval/negation-knn-probe.py`, ten
affirmative/negative sentence twins) confirmed this is not model-specific.
For every embedding model tested, a negated sentence's top-1 neighbour is its
own affirmative twin, not another negation:

| Model                | twin-as-top1 | cos(neg, twin) | cos(neg, best other neg) |
| -------------------- | -----------: | -------------: | -----------------------: |
| bge-small-en-v1.5    |         9/10 |          0.823 |                    0.671 |
| Qwen3-Embedding-0.6B |        10/10 |          0.861 |                    0.556 |
| gemini-embedding-001 |        10/10 |          0.881 |                    0.654 |

Negation is encoded as topic noise, not as a logical flip, across small,
mid-size, and production API embedders alike. Logical polarity must therefore
be extracted at write time, while the text is still text, and stored as
record metadata (e.g. `polarity` + `predicate_key`); it cannot be recovered
from stored vectors at retrieval time.

A write-time extraction prototype validated that route end to end
(`evals/omnimemeval/polarity-extract.py`, `beam-polarity.py`,
`polarity-pairs.py`). `memory_records` gained three nullable columns —
`confidence` (REAL), `polarity` (`affirmative`/`negative`), `predicate_key`
(canonical snake_case predicate) — filled by a cheap pipeline: regex negation
cue filter, then a fixed weak LLM (deepseek-chat, temp 0) extracts polarity +
predicate key + confidence, for cue-hit records plus their top-3 embedding
neighbours. Findings:

- **The BEAM contradiction pair is detected as a deterministic join.** On
  BEAM 100K conversation 1 (188 messages), msg-24 "I'm trying to implement
  the basic homepage route with Flask" extracted as
  `affirmative / user_implemented_homepage_route_with_flask` and msg-58
  "I've never written any Flask routes..." as `negative /
user_written_flask_routes`. After key canonicalisation (below) both land on
  one `predicate_key` with opposite polarities, so contradiction detection
  becomes `SELECT ... WHERE a.predicate_key = b.predicate_key AND a.polarity
<> b.polarity` — zero embedding math at query time.
- **LLM predicate keys are not canonical across paraphrases.** A single-pass
  extractor produced `user_implemented_homepage_route_with_flask` vs
  `user_written_flask_routes` for the same fact and the join missed. A second
  pass clustering keys by embedding (bge-small, cosine ≥ 0.85, union-find)
  merged 181 raw keys into 96 clusters and recovered the pair. Canonical
  keys need either this merge pass or vocabulary-constrained extraction.
- **Key clustering over-merges at high threshold.** One union-find chain
  collapsed ~90 `assistant_provided_*` keys into a single cluster (all
  assistant turns look alike as keys). Precision on contradiction pairs
  survived because over-merge hit same-polarity keys, but the merge needs
  polarity-aware guarding (never merge across polarities) before it is safe.
- **LoCoMo user_1 has essentially no factual negations.** 88 cue hits, 0 true
  negatives — all matches were idioms ("can't wait", "won't quit") or
  questions. The prompt must treat those as affirmative, and LoCoMo is the
  wrong corpus for contradiction evaluation; BEAM is the designed-for one.
- **Cost is compatible with the weak-model discipline**: ~180--370
  deepseek-chat calls per conversation at temperature 0, no reader-grade
  model involved, and the regex pre-filter skips ~76% of records.

A second iteration turned the prototype into a layered worker
(`evals/omnimemeval/polarity-worker.py`, validated by
`polarity-validate.py` against per-message DeepSeek labels on BEAM conv 1,
188 messages ingested via `beam-ingest.mjs`). A spaCy rule layer (negation
via dependency `neg` on the ROOT verb, SVO backbone for the key, idioms and
"don't need/have" necessity-negations deferred) resolves 27% of records at
zero cost with 100% polarity agreement; the rest go to the LLM in batches of
15 (10 calls total vs 188 one-by-one) with the current key vocabulary in the
prompt, reaching 99.3% agreement. An `extract_method` column records which
layer filled each row. Two rule-layer lessons: in multi-clause sentences the
predicate must come from the clause that carries the negation (msg-58's ROOT
is "starting" but the fact is "never written"), and negations of
necessity/ability are guidance, not factual denials.

The canonicalisation blocker was then closed
(`docs/design/predicate-key-canonicalization.md`,
`evals/omnimemeval/polarity-canonicalize.py`): a strict key grammar on both
layers (strip aspectual/modal wrappers, bare head-noun objects), LLM
arbitration of embedding-similar key pairs (synonym merges like
`implement_route == write_route`), a `neutral` polarity for non-claims, and
a temporal join filter (earlier affirmation vs later negation, ordered by
`rowid`). The known BEAM pair now ranks first of 4 join candidates. The
surprise negative result: deepseek-chat's per-pair contradiction verdicts
are prompt-unstable (the same gold pair judged true and false under trivial
rephrasings), so weak-model verification is advisory only — precision must
come from upstream keying, not a downstream veto.

Record granularity was the remaining ceiling: BEAM conv 1's second official
contradiction lives inside one 4.7K-char message, invisible to a one-polarity-
per-record model. Moving extraction to claims (721 claims from 188 records)
made both official contradiction pairs detectable, and claim-level
arbitration confirmed 83 synonym merges. An answer-stage A/B probe
(`evals/omnimemeval/beam-answer-probe.py`) then showed why this matters for
scores: an unprimed weak reader given raw evidence picks one side and misses
the contradiction (Q1 answered confidently wrong), while the same evidence
plus a metadata-derived contradiction note produces the official
`ideal_answer` behaviour. The render path now attaches those deterministic
notes in both the OmniMemEval adapter and Pi's resident, automatic-recall, and
`nmg_get` contexts. Pi's `nmg_remember` schema also accepts atomic claims, while
the core derives record-level polarity, predicate, confidence, and extraction
method from the first non-neutral claim rather than trusting a second,
independently supplied rollup. Contradiction lookup rejects records whose
shared scope keys disagree.

The expression shape must therefore follow the question type, and choosing
the shape is itself an unrouted decision today. MGR set logic remains a Lab
primitive.

## 12ter. Session reasoning workspace and compaction checkpoint

Long sessions need a small, explicit scratchpad because ordinary context
compaction can preserve conclusions while losing the evidence path, rejected
hypotheses, and next action. NMG Lab therefore provides a
`ReasoningWorkspace`. It is not another persistent memory graph and it is not
raw hidden chain-of-thought. It is session-local, auditable state projected
through the Active Graph boundary.

The workspace records only concise typed items:

```text
goal | observation | hypothesis | evidence | conclusion
decision | open_question | next_action
```

and explicit relations:

```text
supports | contradicts | derived_from | tests
rejects | depends_on | next_step
```

Pi integration follows a narrow lifecycle:

```text
model or tool result
  -> nmg_reason add/update/link
  -> local .nmg/reasoning/<session>.json
  -> bounded ReasoningCheckpoint
  -> before_agent_start injection after normal Pi compaction
```

NMG does not replace Pi's compactor. `session_compact` only checkpoints the
workspace, while `before_agent_start` injects at most a fixed node and character
budget. Hypotheses retain their status and must not be treated as facts.
Rejected paths are kept when useful so the model does not repeat disproven
work.

Only supported, high-importance conclusions or decisions with traceable
evidence are eligible for later LTG consolidation. The current prototype merely
reports those candidates; it does not automatically promote scratch state into
long-term memory.

The tool is Lab-only (`NMG_ENABLE_LAB_TOOLS=1`). NMG Lite keeps three durable-memory
tools plus the independent task-board coordination tool, and the existing numerical MGR prototype remains available
for independent experiments. The Pi adapter now registers `nmg_reason` only
under that flag. Its typed mutations are written atomically to the session file;
`session_before_compact` records a durable one-shot marker, and the next
`before_agent_start` consumes one bounded checkpoint. Extension shutdown releases
only the in-process cache, so the same Pi session can resume after a process
restart. No reasoning-tool path calls the semantic-memory daemon.

An automatic input-capture and checkpoint-injection variant was implemented and
rejected in July 2026. In a matched DeepSeek V4 Flash development run (three
tasks, three repeats), the full-context baseline and automatic variant both
scored 100%, but mean latency increased from 7.0 s to 9.8 s. After normal Pi
compaction, the baseline scored 100% while automatic injection scored 77.8% and
increased mean latency from 11.9 s to 15.7 s. Explicit `nmg_reason` calls were
slower still; local tool execution accounted for only about 0.1--0.2 s, showing
that extra model rounds, not local graph operations, dominated the cost.

Therefore NMG does not automatically parse every user turn into the reasoning
workspace and does not inject that workspace on ordinary turns. The scratchpad
remains an explicit Lab capability for tasks that need an auditable reasoning
checkpoint. One-call correctness should instead come from the stable harness
layers: bounded resident context, gated long-term recall, provenance-aware
retrieval, and progressive evidence expansion only when the first retrieval is
insufficient.

## 13. Current implementation versus target

Implemented and verified in the current prototype:

- a normal Pi package manifest, stable extension entry, three durable-memory
  tools plus the independent `nmg_board` coordination tool, and optional Lab tools;
- progressive `nmg_search` headers followed by exact `nmg_get` evidence loading;
- a persistent Inbox/Delta path that survives restart, participates in hierarchy
  retrieval before compaction, and is acknowledged only after external leaf
  embeddings finish;
- dirty-node threshold scheduling and node-local leaf rebuilding with stable
  content-derived block IDs that preserve unchanged embedding cache entries;
- Float32 BLOB persistence with backward-compatible JSON migration and
  disposable contiguous vector caches that support geometric append/update;
- local SQLite selective history evidence, semantic memory, typed relations,
  evidence links, and source-message identities;
- state supersession, event time, actor/truth status, scope, merge/split, and
  redirects;
- resident/automatic/cue execution layers;
- a Lab-only, file-backed session reasoning workspace with bounded compaction
  checkpoints and explicit hypothesis/evidence status;
- a task-scoped shared coordination board with attributed entries, TTL, cursor
  reads, explicit resolution, CLI/RPC/Pi/MCP/Kimi-hook access, a system-layer
  online-agent registry, capability discovery and stable-name directed delivery,
  and no LTG/FTS indexing;
- a bounded `searchContext` result that approximates an early Active Graph by
  combining resident, automatic, and agent-directed recall;
- explicit STG/LTG residence on memories and nodes, governed immediate atomic
  LTG writes, ID-preserving promotion/demotion, STG expiry, and append-only
  lifecycle audit events;
- a first-class Active Graph returned by `searchContext`, with persistent and
  temporary edges plus a shared node/edge/evidence/token/hop/tier/latency budget
  and a per-dimension measured usage ledger;
- durable per-memory selection explanations, score components, estimated token
  cost, and relation expansion paths, all recoverable from one retrieval trace;
- Pi propagation of Active Graph IDs from `nmg_search` to `nmg_get`, so exact
  expansion acts as the current operational signal that a recalled memory was
  actually selected for use;
- query/task-deduplicated edge observations, separate selection/use/
  contradiction/rejection activation statistics, time-decayed edge stability,
  and protection against increasing stability from retrieval alone;
- auditable stability-driven relation consolidation and hysteretic demotion,
  with explicit relations protected from automatic demotion;
- automatic turn-end maintenance in the Pi harness: STG expiry, due-node batch
  rebalancing, and conservative stability-driven consolidation/demotion;
- accepted and rejected write-policy audit events, including durable write
  reason and source while deliberately excluding rejected statement/evidence
  content;
- FTS5, hashing evaluation vectors, model-neutral external embeddings with
  explicit query/document profiles, node/leaf indexing, and a
  rebuildable USearch experiment;
- L0-L3 local tiers, accumulated access statistics, and batch rebalancing;
- LTG-only L4 Dormant/Unindexed and L5 Quarantine lifecycle states, explicit
  restore, and conservative dry-run retention reports (without automatic
  physical purge);
- persisted ambiguity, fallback, contradiction, usefulness, and node-pair
  co-retrieval telemetry;
- delayed evidence-backed link/split proposals with observation thresholds,
  gain thresholds, cooldown hysteresis, persistent review state, and explicit
  accept/reject application;
- independently selectable QPP1 allocation, QPP2 progressive local folding,
  and model-facing search recommendations, with folded candidates preserved in
  the Active Graph rather than discarded;
- Pi RPC regression tests, initial LongMemEval development runs, and scale
  experiments.
- local quality automation for type checking, ESLint, Prettier verification,
  Node test execution, and C8 coverage, with a matching GitHub Actions workflow.

Important gaps between the prototype and the target plugin:

- the reasoning workspace has no learned automatic activation gate. This is now
  an explicit product boundary rather than an unimplemented default: the tool is
  absent unless Lab mode is enabled, the model decides whether to write it, and
  NMG injects it only once after Pi compaction;
- reasoning nodes distinguish type and status, but hypothesis writes are not
  yet required to cite evidence, and the system does not independently detect
  unsupported scratchpad claims;
- reasoning checkpoints are bounded, session-persistent, and resumable within
  the same Pi session, but scratchpad expiry, archive policy, cross-session task
  continuation, and explicit promotion into STG/LTG remain undesigned or manual;
- the workspace exposes consolidation candidates in core code, but Pi does not
  automatically review or promote them; this is intentional until provenance
  and false-promotion evaluation are stronger;
- `MemoryGraphReasoner` remains a numerical Lab prototype that scores the
  global unvisited candidate set rather than following graph edges;
- QPP1, QPP2, and search recommendation are independently wired at the Pi
  boundary. QPP1 `active` performs a non-persistent planning probe and applies a
  learned hard-bounded AG budget only after attributable controller training;
  QPP2 `active` enables Fibonacci expansion and may fold a learned low-mass tail
  without removing its IDs from the AG; an explicit caller limit disables that
  fold. Search recommendation remains a trailing, optional model nudge. Their
  utility and cost are not yet sufficiently characterised. QPP1 budget
  prediction correlated poorly
  with the oracle Fibonacci tier in the full LoCoMo audit; QPP2 scores are
  listwise rather than absolutely calibrated; and the cost/benefit of asking
  the model to search again has not been measured. Active behavior remains an
  explicit operator choice rather than a default selected by NMG;
- QPP2 folding is lossless at the store/Active-Graph layer but not necessarily
  lossless for the model: a needed candidate can remain folded unless the model
  explicitly unfolds the directory. A matched end-to-end test must measure
  answer quality, evidence use, extra tool calls, tokens, and latency. The
  activation gate now has typed inputs and fail-closed checks for those paired
  product measurements, but no current natural run supplies the two matched
  arms, so this is evaluation work rather than an authorization to activate;
- the claim-level posterior outcome loop in section 5c now has a shadow-mode
  storage and RPC path: immutable extraction confidence seeds a weak Beta prior,
  attributable supported/contradicted events are deduplicated by semantic task,
  and the store exposes posterior mean plus a conservative lower bound. It does
  not change extraction confidence or retrieval ranking. Automatic collection
  of trustworthy task outcomes and real-use calibration remain open;
- the ANN experiment has unacceptable recall on the near-duplicate workload;
- automatic extraction evaluation and the matched full-history sample are not
  yet large enough to make a product-quality claim;
- the four official benchmark adapters validate and use official-format parsing.
  One full matched BEAM 100K run now establishes a dataset-specific capability
  gain over empty retrieved context, but repeated runs and cross-suite evidence
  are still required for a general capability claim;
- the HaluMem operation-level adapter now measures extracted records,
  interference rejection, and update retrieval with the official judges. Its
  first natural slice exposed raw-message ingress pollution (0/1 interference
  rejection and 0.683 all-candidate weighted accuracy). On the same slice an
  Agent executing the current durable-write policy rejected the interference,
  produced 12 rather than 30 candidates, achieved 1.0 candidate accuracy and
  4/4 updates, but retained only 1/2 ordinary gold points. This supports keeping
  semantic admission in the harness while requiring recall audits. A second
  matched slice reduced 52 turns to 8 accurate candidates, retained 7/8
  ordinary gold points, and updated 1/1 target. Its benchmark interference
  aggregate also showed why gates must inspect attributable per-record outcomes:
  an official judge may accept a labelled interference inference even when the
  injected wording was never stored. A real STG posterior audit then admitted 17
  attributable candidates from sessions 5–6 and observed sessions 7–11, but
  found no later exact independent confirmation and therefore qualified zero. A
  second sessions 1–2 / observations 3–11 window also qualified zero. This shows
  both that HaluMem lacks product-like outcome labels and that some extracted
  records remain too compound; it does not authorize weakening the posterior
  gate or enabling unattended consolidation;
- accepted topology proposals are an offline/Lab maintenance operation, not an
  unattended production mutation policy;
- Pi/CLI logical withdrawal and a versioned user-memory export now exist;
  physical privacy erasure of every provenance copy and learned aggregate remains
  gated future work;
- automatic recall exposure is recorded as selection, and Pi performs a
  precision-favoured answer-to-evidence attribution at `agent_end`. Matching and
  empty overlap observations are diagnostic only: they neither train the shadow
  controller nor alter stability. Exact `get` records disclosure, not use.
  Stability and evidence-ranking supervision require explicit user outcomes,
  tool validation, or official benchmark evidence;
- stability currently consolidates a pairwise local subgraph as a typed
  `related_to` relation. Larger multi-edge motif consolidation remains an
  experiment rather than a P3 requirement.
- optional encrypted synchronization and multi-device conflict handling are
  design-only; Cloudflare is not a runtime dependency.

## 14. Evaluation and falsifiable claims

NMG must be evaluated with the same base model, prompts, histories, and budgets
under these controls:

1. no long-term memory;
2. raw session search with FTS/exact retrieval;
3. flat FTS + vector hybrid retrieval;
4. NMG Lite progressive disclosure;
5. NMG Graph with adaptive nodes, relations, and optional learned routing.

Core hypotheses:

- **Hierarchical coding:** node/leaf headers reduce tokens or latency without
  reducing evidence recall.
- **Adaptive granularity:** measured refinement reduces semantic routing errors.
- **Relational side information:** graph expansion improves temporal, scoped,
  conflict, or multi-hop questions enough to pay for its cost.
- **Learning:** a learned router improves recall/cost over cosine, lexical, and
  simple hybrid controls.
- **Active projection:** an explicit budgeted AG improves evidence coverage per
  token over ordinary Top-K context injection.
- **Consolidation:** stability-gated structural promotion improves future
  multi-hop retrieval without increasing false relations or stale-memory errors.

If Lite does not beat the flat hybrid control, its hierarchy has no demonstrated
product value. If Graph does not beat Lite, graph adaptation remains a Lab
feature. If a learned router does not beat deterministic routing, it remains
optional.

Current development evidence (updated 2026-07-30):

- 287 automated tests cover UOp autodiff, the differentiable controller,
  hierarchical activation, the retained memory-graph reasoner prototype,
  reasoning-workspace persistence and checkpoint injection, P3 lifecycle,
  budget enforcement, disclosure/verified-evidence separation, independent-task deduplication,
  reversible consolidation, write-policy audit, Active Graph traces, official
  benchmark adapters, and schema migration. Test files live in `tests/core/`,
  `tests/evals/`, and `tests/extensions/nmg/`.
- a clean DeepSeek V4 Flash Pi process wrote a unique LTG fact, a second process
  recovered it through `nmg_search -> activeGraphId -> nmg_get`, and the store
  recorded one selection and one exact disclosure; isolated test data was removed
  afterwards and `PRAGMA foreign_key_check` remained clean;
- strict three-arm LongMemEval development gate over one fixed question from
  each of seven categories, scored separately with the pinned official protocol:
  no-memory 1/7, deterministic NMG 2/7, and identical deterministic NMG with
  non-ranking shadow logging 3/7. No external embedding provider was enabled.
  Deterministic retrieval was sufficient in 2/7 cases and both answers were
  correct; all five retrieval misses were wrong. The shadow difference is model
  or judge variance because shadow decisions cannot affect ranking;
- historical pre-gate LongMemEval diagnostic, one fixed case from seven categories: no-memory 1/7,
  raw-session 1/7, flat hybrid 5/7, Lite 5/7, Graph 6/7;
- historical pre-gate LongMemEval diagnostic, two fixed cases from seven categories:
  no-memory 2/14, raw-session 4/14, flat hybrid 8/14, Lite 10/14, Graph 9/14;
- controlled 30-case topology ablation: flat 0%, fixed unlinked graph 0%,
  accepted evidence-backed link 100% recall by construction;
- controlled labelled routing: heuristic 0%, online router after three explicit
  useful-node labels 100% by construction;
- 10K near-duplicate hierarchy workload: node+leaf exact scan 100% accuracy at
  10.6 ms P50, leaf ANN 87.5% at 8.1 ms P50, full record scan 75% at 779 ms P50.
- full 1,540-question LoCoMo K=20 retrieval ablation with local
  `BAAI/bge-small-en-v1.5`: FTS5 exact-evidence recall 45.1%, node/leaf summaries
  18.0%, record vectors 52.9%, and node/leaf+record union 17.7%. Record vectors
  also kept mean latency and context size near the lexical baseline. This
  rejects compressed hierarchy as the sole evidence index and rejects the
  current union ranker; node/leaf routing remains a directory/scale
  optimization, not a substitute for detailed evidence candidates.
- full 20-conversation, 400-question BEAM 100K K=20 retrieval ablation:
  FTS5 exact labelled-evidence recall was 26.2% and BGE record vectors reached
  32.9% with slightly less returned text. Incremental add-time indexing kept
  32.8% recall while reducing mean first-query latency from 2,102 to 193 ms
  and total add-plus-search time from 73.0 to 68.9 seconds. Shared all-actor
  ranking and fixed actor quotas were rejected because they added context and
  latency without improving recall.
- full OmniMemEval BEAM 100K answer-and-judge run over the same 20 conversations
  and 400 questions: NMG with BGE record vectors, K=20, QPP2 off, and DeepSeek V4
  Flash as both reader and judge scored `0.6422 ± 0.3974`. Search latency was
  40.9 ms P50 and 185.1 ms P95; all 400 search, answer, and judge records
  completed without skipping. A matched empty-retrieval-context control using
  the same questions, prompt, reader, and judge scored `0.2724 ± 0.4086`; the
  paired gain was `+0.3698` (20,000-sample descriptive paired-bootstrap 95%
  interval `[+0.3205, +0.4183]`; 251 wins, 123 ties, 26 losses). Abstention
  regressed by `-0.3875`, so this is evidence of dataset-specific utility, not a
  blanket safety or generalization claim. Full parameters, per-dimension scores,
  accounting caveats, timing, and runner corrections are recorded in
  `beam-100k-evaluation-2026-08-13.md`.
- reasoning-workspace development benchmark, three tasks with three repeats per
  condition using DeepSeek V4 Flash: full-context baseline and workspace both
  achieved 100% exact task success, while mean latency rose from 5.79 s to
  15.15 s; after ordinary Pi compaction, baseline achieved 88.9% and workspace
  100%, while latency rose from 9.83 s to 23.41 s. One of nine compacted
  workspace trials persisted an unsupported hypothesis marker.
  The topology and router cases isolate whether the mechanisms can learn and
  apply a missing relation; they are not natural-distribution quality estimates.
  The scale result shows why leaf granularity matters and why the current ANN
  configuration must not replace exact local scan yet.

The 14-question paired outcomes are more important for product gating than the
controlled topology result: Lite uniquely won five versus flat's three, while
Graph uniquely won one versus Lite's two. The sample is still too small for a
capability claim, and it explicitly keeps graph expansion in Lab.

Track evidence Recall@K, stale-memory error, wrong-scope error, false-memory
injection, answer accuracy, unrelated-task regression, injected tokens, deepest
tier, index/maintenance cost, and end-to-end P50/P95 latency including query
embedding. For STG/LTG/AG experiments also track STG residence time, atomic
promotion latency, relation precision, false-consolidation rate, consolidated
subgraph reuse, AG node/edge/evidence counts, budget utilization, expansion
steps, and marginal evidence gain per added token.

### Offline text-space policy optimization

Training provenance is part of the gate, not a prose convention. Normal Pi
feedback is recorded as `collectionOrigin=natural`; the reproducible headless
probe is fixed to `controlled`, and pre-field legacy events remain `unknown`.
Only fully labelled natural outcomes may enter controller calibration or the
formal SkillOpt split. Controlled outcomes remain valid engineering smoke data.

NMG Lab may use SkillOpt to optimize a controller-only recall decision policy,
but never mutable memory contents. The current adapter seeds that artifact from
the `memory_policy` field in `nmg-prompts.yaml`, then evaluates a strict
machine-readable decision contract. That controller artifact is not the same as
the global natural-language policy used by the answering Agent. History,
evidence, facts, STG/LTG/AG state, node identity, and edge identity remain
immutable evaluation inputs.

The first adapter learns only the next progressive-recall decision (`answer`,
`expand`, or `stop`) and whether noise should be folded from explicit shadow
labels. It uses chronological whole-task train/validation/test splits. A
SkillOpt validation win creates a candidate only: matched Pi+NMG answer,
evidence, pollution, token, tool-call, and latency gates must also pass, after
which adoption also requires a dedicated controller invocation/policy boundary
that cannot leak protocol into the user answer. Adoption remains a reviewed edit
back into the YAML source of truth. Runtime NMG never loads `best_skill.md`
automatically. The first official run improved offline validation and test
scores, but the matched Pi gate regressed from canonical 6/6 to candidate 4/6
because `recall_action` JSON appeared in user answers; the candidate was rejected
and canonical YAML was unchanged. See
`skillopt-policy-optimization.md` for the protocol and current readiness.

A second, separate candidate artifact is the proposed
`memory_maintenance_policy`. It would translate already observed controller and
feedback signals into reviewed maintenance proposals, not mutate memory during
inference. Its attribution must distinguish:

- **content defect**: a statement is wrong, obsolete, or ambiguous;
- **scope defect**: a valid statement is attached too broadly or narrowly;
- **retrieval defect**: content is valid but selection or timing was wrong.

Only the first two categories may propose content/scope maintenance. Retrieval
defects remain selection-policy evidence. Candidate maintenance policies require
their own long-horizon outcome definition, held-out gate, and matched Pi+NMG
promotion test. Any accepted policy remains a reviewed YAML edit; individual
rewrite, supersede, split, or merge proposals must retain evidence and use the
existing journal where supported.

**Implementation status:** explicit feedback collection, natural/controlled
provenance, journaled node-merge rollback, the recall-policy SkillOpt adapter,
formal data gate, first official optimization, and matched rejection gate are
implemented. A dedicated controller runtime policy channel is not implemented;
the Lab candidate hook intentionally tests and rejects unsafe global-policy
replacement. The maintenance-policy artifact, three-way attribution,
long-horizon score, and proposal-to-store channel are not implemented. STG/LTG
context composition is implemented, but it is not a reversible persistent STG
merge.

The current Pi regression, seven-category invariant suite, controlled topology
ablation, and strict seven-question LongMemEval matched sample prove integration
and mechanism behaviour. The full matched BEAM 100K run additionally demonstrates
a substantial gain over empty retrieved context for one fixed dataset/model/judge
configuration. It does not yet prove cross-suite, cross-model, or repeated-run
general capability improvement. The LongMemEval sample did ingest every haystack
session for each selected question, but its zero-configuration FTS/hashing path
missed five of seven required evidence sets. Cross-suite matched external-
embedding runs and repeated model runs remain required for a broader claim.

The public evaluation portfolio is deliberately complementary rather than a
single composite leaderboard:

- LongMemEval remains the main development gate for extraction, multi-session
  reasoning, updates, temporal reasoning, and abstention;
- PersonaMem evaluates automatic fact/preference/constraint writes, evolving
  user profiles, scope, and current-state selection;
- LoCoMo evaluates temporal/causal relations, multi-hop evidence, and expansion
  from semantic nodes to leaf evidence;
- BEAM is the late-stage scale and cache-pressure test, beginning at 128K and
  500K before any 1M or 10M run.
- OmniMemEval is the preferred external user-memory evaluation harness because
  it unifies those suites (plus HaluMem) behind one `add`/`search` client
  contract. NMG maintains one thin OmniMemEval adapter. OmniMemEval measures the
  backend under forced search; the local matched Pi runner remains necessary to
  measure recall triggering and actual evidence use. Only duplicated
  public-dataset parsing, replay, and scoring should be retired after parity.
- OmniMemEval's AgentBench/OpenClaw agent-memory track is not adopted for Pi at
  this stage. Pi runtime behaviour remains covered by local extension and RPC
  tests, avoiding a second agent harness unless comparative evidence justifies
  it.

These suites must be reported separately. Matched arms share the same reader,
prompt, question IDs, source history, evidence-token budget, and judge. Answer
quality is reported together with evidence recall, injected tokens, backend
records read, graph/tier depth, end-to-end latency, and index/maintenance work.
The complete adapter contract and rollout order live in `evals/README.md`.

The 2026-08-11 strict LongMemEval matched regression used one fixed question
from each of seven categories. The separate protocol scorer gave no memory
`2/7`, deterministic NMG `4/7`, and NMG with non-ranking shadow telemetry
`4/7`; the generic diagnostic scorer gave `1/7`, `4/7`, and `4/7`. Both NMG
arms passed the same four categories and failed the same three, so the telemetry
path showed no answer-quality regression in this bounded gate. Exact official
evidence `recallAll` was `3/7` versus `2/7`, however, because the stochastic
Agent chose different search/get sequences despite identical ranking policy.
Consequently a one-repeat answer tie is a regression check, not proof of
retrieval or cost equivalence. Full parameters, latency, context, and token
accounting are recorded in `evals/longmemeval/README.md`.

The complete Namesakes topology audit also includes a read-only streaming
counterfactual. At hashing threshold 0.5, 94.74% of incoming non-anchor mentions
would emit a proposal and false proposals would co-locate 6,450 foreign records
across 2,307 of 3,975 entities. Threshold 0.7 still affects 1,479 entities and
3,003 foreign records while positive recall falls to 30.39%. This quantifies
online proposal prevalence and structural contamination, but not correction
events or downstream answer damage; automatic identity mutation remains off.

The first pinned OmniMemEval LongMemEval search-only smoke used the same seven
fixed questions as the Pi run. Forced NMG search initially made five cases
plausibly answerable. The failure trace showed two simple ranking faults:
unverified assistant replies competed with user facts, and English
question/function words inflated irrelevant lexical scores. An optional
source-actor filter plus stop-word-aware lexical terms recovered both temporal
records, preserved the update, preference, and assistant evidence, and changed
the count result from duplicate boot mentions to complementary boot and blazer
evidence. The count case remains 2/3 against the official evidence list.
Search stayed around 126–166 ms; ordinary contexts were 2.8–4.1k characters,
with one long assistant schedule at 7.5k.

Enabling hybrid FTS on the two deficient cases recovered no additional
required evidence, expanded context to 7.2–7.9k characters, and raised one
temporal search to 2.04 s, so that change was rejected. This supports targeted
source/provenance filtering and aggregation rather than broader candidate
expansion.

The first pinned OmniMemEval LoCoMo smoke exposed an upstream integration
detail: LoCoMo maintains a benchmark-local search dispatch table instead of
using the shared dispatcher. The idempotent adapter installer now patches both.
After that fix, the official ingestion and search stages completed all 272
sessions and 1,540 category 1--4 questions without failure. Ten-worker search
took 54 seconds; individual backend latency was 329 ms mean and 619 ms P95,
with 4.15k returned characters on average. Exact normalized evidence text was
present for at least one official evidence ID in 61.8% of questions and for all
IDs in 49.6%. These are search diagnostics, not answer-quality claims; the
official answer/scorer stages and a matched no-NMG baseline remain required.

A fresh-namespace LoCoMo budget ablation found 32.7%, 39.0%, 45.0%, and 46.6%
exact labelled-evidence recall at K=5, 10, 20, and 40 respectively. Mean context
grew from 1.0k to 2.1k, 4.2k, and 4.9k characters. K=20 is therefore retained
as the default knee point: K=40 adds only 1.6 recall points, while multi-hop and
open-domain recall remain low even at the larger budget. This rejects broader
default context expansion and points subsequent work toward evidence
composition and query-aware ranking.

The same smoke exposed a representation loss at the adapter boundary: NMG
stored each LoCoMo turn's event time, but the text returned to the reader
discarded it. Temporal evidence containing relative expressions was therefore
not sufficient to derive dated answers. The Omni bridge now includes event time
only for temporally signalled queries. In a fresh K=20 run, every one of the 450
retrieved labelled evidence turns in that subset had a date anchor; evidence
ranking was unchanged. The added cost was 691 characters for the 663 affected
questions and zero for the other 877. This is retained as lossless
query-dependent rendering, not a larger retrieval budget.

## 15. Cloud and execution boundaries

Cloud sync is optional and never authoritative. A future backend may exchange
immutable operations and content-addressed encrypted objects rather than copying
a live SQLite file. Cloudflare coordination is not part of NMG Lite.

NMG stores and retrieves memory; it does not execute remembered commands or
provide an `ExecutionBackend`. Pi can obtain execution isolation through its
own sandbox plugins, independently of NMG. NMG may preserve a sandboxed tool
result as provenance-bearing evidence, but sandbox selection, permissions,
lifecycle, and policy remain responsibilities of Pi and the selected plugin.

## 16. Revised implementation order

### P0: make the memory plugin small and real

1. Add a Pi package manifest and stable installable extension entry.
2. Reduce the default model-facing API to search, get, and remember.
3. Keep SQLite + FTS/exact retrieval as the zero-configuration path.
4. **Complete at benchmark and Pi boundaries:** wire optional fine-grained
   record embeddings behind the same SQLite store, synchronize only missing
   records at add/turn boundaries, and retain FTS/exact as the
   zero-configuration and not-yet-ready fallback. Node/leaf-only and the
   current union ranker are explicitly gated off after the LoCoMo ablation.
5. **Complete:** expose the application boundary through an
   agent-independent `nmg` CLI and cross-platform `nmg.v6`
   JSON-RPC-over-HTTP daemon. The Pi extension uses the same daemon through a
   persistent HTTP client and ownership-aware lifecycle.

### P1: incremental correctness and fair evaluation

1. **Complete:** Inbox/Delta retrieval and dirty-node local rebuild scheduling.
2. **Complete:** stable leaf identities, Float32 binary vector storage, and a
   disposable contiguous appendable in-memory cache.
3. **Complete at runner level:** the strict LongMemEval matched gate compares
   no-memory, deterministic NMG, and NMG with a non-ranking shadow controller
   using identical prompts and independent copies of one seed corpus. Larger
   repeated capability runs remain ongoing benchmark work.
4. **Complete:** deterministic temporal, aggregation, conflict, multi-hop,
   exact-detail, privacy, and memory-pollution cases.
5. **Complete at adapter level:** LongMemEval, PersonaMem, LoCoMo, and BEAM have
   official-format loaders, stratified validation, shared matched experiment
   arms, ignored local data/results, and fixture coverage. Larger repeated
   capability runs remain benchmark work rather than implementation work.

### P2: adaptive semantic graph experiments

1. **Complete:** record ambiguity, fallback, contradiction, usefulness, and
   co-retrieval signals.
2. **Complete:** propose delayed links and scoped refinements with evidence,
   thresholds, cooldown hysteresis, and explicit review.
3. **Complete as a controlled mechanism ablation:** compare adaptive topology
   with fixed nodes and flat retrieval over 30 deterministic cases.
4. **Complete as a controlled label test:** the framework-independent online
   router is updated only from explicit useful-node labels.

### P3: runtime memory model and consolidation

1. **Complete:** add explicit STG/LTG lifecycle state, provenance-preserving promotion,
   expiry, and demotion; keep immediate atomic LTG promotion for governed facts,
   preferences, constraints, and replaceable states.
2. **Complete:** introduce a first-class `ActiveGraph` runtime object with selected nodes,
   relations, local evidence, temporary cross-graph edges, and a unified budget
   ledger.
3. **Complete with conservative attribution:** record scored node and edge
   activation from retrieval traces and agent-directed exact-memory use, with
   durable selection reasons, expansion paths, and budget accounting; retrieval
   frequency alone does not establish usefulness.
4. **Complete:** estimate edge stability from independent tasks, evidence coverage, verified
   usefulness, contradiction, and time decay while preventing self-reinforcing
   retrieval loops.
5. **Complete for pairwise local subgraphs:** add auditable, reversible
   local-subgraph consolidation into LTG with minimum
   evidence, hysteresis, cooldown, and explicit evaluation gates. Pi runs this
   conservative maintenance policy automatically after completed turns.
6. **Autodiff complete as Lite infrastructure; controller separately gated:**
   implement a tinygrad-inspired UOp engine and a serializable multi-head
   controller for node, edge, STOP/EXPAND, and budget decisions. The numerical
   substrate ships with Lite; controller activation in the Pi retrieval path
   remains gated on a fixed feature contract and matched
   evidence-recall/cost evaluation.
7. **Mechanism complete, utility evaluation open:** independently selectable QPP1
   allocation, QPP2 progressive folding, and search recommendation are wired
   through the Pi adapter. QPP2 preserves folded candidates in the Active Graph.
   Calibration and matched answer-quality/cost evaluation are not complete;
   activation and composition remain user/operator policy.

### P4: selective reasoning workspace

1. **Complete as a Lab prototype:** typed session reasoning nodes and edges,
   atomic local persistence, bounded checkpoints, Pi compaction lifecycle
   integration, and a matched full/compacted development benchmark.
2. **Rejected after experiment:** automatic user-input capture and ordinary-turn
   checkpoint injection. It added latency and regressed compacted-task accuracy.
   Do not restore it without a new benchmark and a materially different design.
3. Require stronger provenance for evidence/conclusion nodes and prevent
   unsupported hypotheses from being promoted or presented as established
   facts.
4. Add update deduplication, stale-node retirement, task-completion archival,
   and explicit workspace reset/resume semantics.
5. Keep measuring the explicit workspace on tasks with real interruption or
   compaction risk; do not treat synthetic success as justification for default
   activation.
6. Only then define reviewed STG/LTG promotion of supported conclusions and
   decisions.

### P5: optional platform capabilities

1. Measure retention transitions from indexed cold storage through implemented
   L4 Dormant/Unindexed and L5 Quarantine states before considering automatic
   physical purge. The CLI exposes dry-run candidates and explicit
   archive/quarantine/restore operations through the resident service.
2. The CLI exposes semantic-memory deletion with dependent index cleanup while
   retaining immutable source history. Full privacy erasure/export, including
   raw history and learned-signal erasure, remains separate work.
3. Add optional encrypted cloud synchronization only after the local protocol
   and multi-device conflict semantics are specified.

### Immediate validation order

The next work should reduce uncertainty rather than add another subsystem:

1. Evaluate QPP1, QPP2, and search recommendation independently against the
   same fixed baseline. Report each module's score change, evidence recall,
   tool-call count, injected tokens, and end-to-end latency. Do not make
   exhaustive module combinations a project requirement.
2. Calibrate QPP1 against oracle evidence depth and QPP2 against evidence
   retention. Do not call a module useful merely because a larger pool raises
   raw recall.
3. Test whether the model follows one search recommendation when useful,
   ignores it when unnecessary, and stops after an unproductive search.
4. Implement the claim outcome posterior from section 5c only after the
   existing use/outcome events can be attributed to independent tasks without
   self-reinforcement.
5. Harden the plugin boundary: add an installable Pi package manifest, validate
   the Pi session-entry schema, document the single-writer concurrency model,
   and expose user-facing delete/export.
6. Leave activation and module composition to explicit user/operator policy.
7. Keep ANN, unattended topology mutation, cloud sync, and automatic reasoning
   workspace activation deferred until their measured prerequisite appears.

## 17. Remaining design questions

- Can a future deterministic gate identify the narrow tasks that benefit from
  an explicit reasoning workspace without injecting it into ordinary turns?
- Which reasoning-node kinds require direct evidence references, and how should
  unsupported hypotheses be labelled, expired, or excluded from checkpoints?
- When a task ends, should its workspace be deleted, archived as an event, or
  reviewed for selective STG/LTG promotion?
- How should a task resume across a new Pi session without treating every prior
  session scratchpad as globally active?
- What measured ambiguity/coverage thresholds justify node creation or
  refinement?
- Which deterministic relation types are safe to establish immediately, and
  which always require confirmation?
- How should interval conflicts and partial scope overlap be represented?
- What feedback proves a retrieved memory was useful without reinforcing the
  router's own prior selections?
- What STG retention, expiry, and demotion policy preserves useful provisional
  information without turning STG into a second unbounded archive?
- What counts as an independent task or source when estimating edge stability,
  and how should repeated evidence from the same session be discounted?
- Which stability threshold, evidence coverage, and hysteresis margin justify
  consolidating a local subgraph into LTG?
- How should an Active Graph allocate token, node, edge, evidence, graph-hop,
  local-tier, and latency budgets, and what marginal-gain rule should stop its
  expansion?
- How should QPP1 depth and QPP2 retained mass be calibrated from independent
  outcome evidence rather than benchmark labels or the controller's own prior
  selections?
- When a QPP recommendation is emitted, what bounded policy prevents repeated
  low-value searches while still allowing a genuinely multi-part query to
  continue?
- Can a consolidated LTG relation be demoted or reopened when later evidence
  changes its scope, and how is that transition audited?
- Which rare safety/user constraints must remain pinned regardless of access
  frequency?
- At what measured node/leaf count does exact contiguous vector scan stop
  meeting the end-to-end latency budget?
- What privacy/delete interface can remove raw evidence and every dependent
  summary, cache, and learned signal?

## 18. Concise technical definition

> NMG is an adaptive semantic coding system for agent memory. It encodes
> immutable historical evidence into mutable, variably granular semantic nodes
> and relations across a short-term graph and a long-term graph; constructs a
> budgeted Active Graph as the model's query-scoped virtual memory space;
> consolidates stable evidence-backed structure while allowing governed atomic
> memories to persist immediately; and preserves exact history as a lossless
> fallback against semantic retrieval error.

## 19. Companion engineering notes

This document defines the architectural contract. The supporting notes explore
implementation choices without making all of them core requirements:

- [`math-physics-foundations.md`](./math-physics-foundations.md) distinguishes
  implemented mathematics from useful analogy and proposes measurable models.
- [`structural-analogies.md`](./structural-analogies.md) relates NMG to LSM,
  event sourcing, content addressing, association learning, and graph methods.
- [`function-signatures-from-structures.md`](./function-signatures-from-structures.md)
  derives possible API boundaries from those structural analogies.
- [`sqlite-assessment.md`](./sqlite-assessment.md) records why SQLite remains the
  correct authoritative store for the current scale and plugin boundary.
- [`improvement-areas.md`](./improvement-areas.md) tracks unresolved engineering
  risks and should not be read as implemented design.
- [`ci-cd-and-quality.md`](./ci-cd-and-quality.md) describes the current local
  quality checks and CI automation.
