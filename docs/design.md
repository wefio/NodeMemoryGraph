# NMG design baseline

**Status:** 0.4 / three-layer recall baseline  
**Updated:** 2026-07-18

## Definition

Node Memory Graph is an external memory architecture for long-running agents. It places mutable semantic nodes over traceable historical evidence. Each semantic node manages a local, bounded working set and progressively deeper memory tiers.

The primary integration target is Pi. Pi remains responsible for the model loop, tools, sessions, and UI; NMG is responsible for durable long-term memory.

## Decisions already made

| Area | Decision |
|---|---|
| Agent host | Pi extension; do not fork or modify Pi core. |
| Source of truth | Local SQLite database. Offline use must remain complete. |
| Historical evidence | Append-only during normal maintenance and referenced by stable IDs. Privacy deletion remains possible by an explicit future operation. |
| Semantic layer | Mutable `MemoryNode` objects connected by typed relations; general semantic relations may cycle, while derivation and supersession must remain acyclic. |
| Node lifecycle | Merge and split preserve records/evidence, mark source nodes inactive, and retain redirects. A split requires a complete, disjoint memory partition. |
| Node-local history | `MemoryRecord` references evidence and belongs to a local block tier L0-L3. |
| Retrieval | Hybrid lexical/vector/learned-route scoring, shallow tiers first, then graph expansion under a budget. |
| Execution layers | Query-independent resident constraints; automatic evidence retrieval for explicit recall; compressed cues plus `nmg_search` for agent-directed recall. These are separate from storage tiers L0-L3. |
| Vector index | Two-stage, rebuildable index: node headers route broadly; leaf/block headers preserve local distinctions. Individual records are vectorized only as a measured fallback for broad/high-entropy leaves. |
| Learned routing | Persisted online prototype router learns query-to-useful-node mappings from explicit feedback and contributes to hybrid ranking. |
| Huffman idea | Implemented as standard weighted Huffman depths mapped into bounded L0-L3 blocks. Access events accumulate before batch rebuilding. |
| Write policy | Clear stable user-stated facts, preferences, and constraints are automatic. Ambiguous or inferred candidates require confirmation; secrets and transient instructions are rejected. |
| Session evidence | Each completed Pi turn checkpoints its session transcript as cold evidence. Session archives do not automatically become semantic memories. |
| Cloud | Optional coordination/sync backend later; never the only copy. |
| Sandbox | Outside NMG core. Add an execution backend only when a real task requires untrusted execution. Docker is the first candidate. |
| Learning | The first learned router is an online local prototype model. PyTorch remains optional for a later, richer router; storage topology stays discrete. |

## Core model

```text
HistoryRecord (evidence, append-only during normal maintenance)
       ▲
       │ evidence links, including inherited/transitive evidence
MemoryRecord
  ├── type: fact | state | event | preference | constraint
  │         | strategy | conversation_evidence | derived
  ├── stateKey / eventTime / actor / truthStatus / scope
  ├── derivation links to source MemoryRecord objects
  └── local tier and priority statistics
       │
       ▼
MemoryNode (stable semantic address)
       └── typed relations to other MemoryNode objects
```

The graph and access hierarchy are separate structures:

- Graph edges express semantics such as `part_of`, `depends_on`, `contradicts`, or `supersedes`.
- Tiers express expected access cost inside one node.
- Stable IDs are addresses. Tier or future Huffman codes must never be permanent IDs.

## Two-stage semantic index

A `MemoryNode` summary is intentionally compressed and therefore cannot be the
only semantic index. NMG uses skill-like progressive disclosure:

```text
query
  -> node header vectors (topic/entity/project routing)
  -> leaf or block header vectors (event/scope/time/cause distinctions)
  -> node-local FTS5 and tier search
  -> exact MemoryRecord and immutable HistoryRecord evidence
```

A leaf header summarizes a bounded group of related records, not one raw message.
It must retain the discriminators required to choose the block: entities, scope,
time range, event/result, constraints, exceptions, and representative keywords.
It must not pretend to be evidence; its members remain the source of truth.

This makes the normal vector count proportional to nodes plus blocks rather than
all historical records. Record-level vectors and ANN remain an optional selective
fallback when a block is too broad for lexical search or measured recall degrades.
SQLite remains authoritative; USearch is a rebuildable ANN index, so a separate
vector database is not required for the local architecture.

## Node lifecycle

`mergeNodes` moves all records from at least two source nodes into one active
target, rewrites typed relations, marks the sources `merged`, and records a
transform plus redirects. Writing through an old merged name resolves to its
single active target.

`splitNode` requires at least two disjoint partitions that collectively assign
every source memory exactly once. It creates active targets, marks the source
`split`, records redirects, and links each target back to the old semantic
address. Writing through an old split name is rejected as ambiguous.

Neither operation deletes history, evidence links, memories, or old nodes.

## Pi integration

The extension uses only public Pi extension surfaces:

1. `before_agent_start` loads a small query-independent resident kernel of active,
   high-importance user/tool/system constraints.
2. A deterministic `MemoryGate` chooses `none`, `cue`, or `retrieve`. Ordinary
   prompts load no dynamic memory; planning/recommendation prompts receive a
   node-only directory; explicit historical/current-state questions receive a
   bounded evidence block automatically.
3. The write policy directs Pi to call `nmg_remember` automatically for stable user-stated facts, preferences, constraints, and states. Explicit writes use the same path.
4. `nmg_remember` preserves memory type, scope, actor, truth status, event time, evidence role, and state identity. A matching or repaired alias of `stateKey` plus canonical scope supersedes the prior active state automatically.
5. `nmg_search` performs budgeted hybrid retrieval, expands typed graph neighbors, hydrates evidence, and can include deeper tiers or historical states. Candidate generation overfetches before type-aware reranking and per-node diversity limits.
6. `nmg_derive` creates a conclusion from multiple source memories and inherits their evidence chains. `nmg_link` creates typed node relations.
7. The injected use policy distinguishes facts from unverified conversational evidence, uses only the newest active state, obeys constraints, adapts to preferences, preserves event time, and applies strategies as procedures rather than facts.
8. `agent_end` checkpoints the current transcript; `session_shutdown` provides a final graceful checkpoint. Changed transcripts append a new immutable snapshot instead of mutating the old record.
9. `nmg_organize` exposes guarded merge/split operations. `nmg_feedback` trains
   the persisted online router, while `nmg_rebalance` applies accumulated usage
   statistics in batches.
10. Retrieval records exposure as usage statistics; explicit useful-node feedback
    is kept separate so the router is not trained on every returned candidate.

Automatic extraction remains governed rather than universal: model-authored claims,
casual conversation, transient instructions, credentials, and secrets are not
semantic memories. The complete session is still retained separately as cold
evidence, so later extractors can be improved without losing provenance.

## Local and cloud placement

```text
Local (authoritative)                 Cloudflare (optional, later)
┌──────────────────────┐             ┌────────────────────────┐
│ SQLite graph/index   │  op-log --> │ Worker / Durable Object│
│ local object store   │ <---------  │ D1 headers / cursors   │
│ optional vector cache│  objects    │ encrypted R2 objects   │
└──────────────────────┘             └────────────────────────┘
```

Cloud sync should exchange immutable operations and content-addressed objects, not copy a live SQLite file. Conflicting semantic edits may coexist as graph branches until merged.

Cloudflare is not part of the MVP because local correctness, provenance, and retrieval quality must be measurable first.

## Sandbox boundary

NMG stores and retrieves memory; it does not execute remembered commands. Pi also does not provide a built-in permission sandbox. For now, NMG adds no execution capability.

If execution becomes necessary, introduce this boundary without changing the memory model:

```ts
interface ExecutionBackend {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
```

Candidate implementations, in order of expected need:

1. No backend (current default).
2. Docker backend for local Windows development through Docker Desktop.
3. Remote sandbox backend if stronger isolation or elastic capacity becomes necessary.

The model must request an execution intent and budget. It must not manipulate container or VM internals directly.

## MVP success criteria

The first milestone is complete when:

1. A confirmed memory survives Pi restart.
2. A later prompt can retrieve it automatically from L0/L1.
3. Explicit search can reach deeper tiers under a caller-supplied budget.
4. Every returned memory identifies its immutable evidence record.
5. Total history can grow without increasing the number of records injected into a normal turn.

The current implementation does not claim semantic scalability yet. Its default
hashing vectors remove external setup but are not a substitute for a trained
semantic embedding model. The database scan is bounded and suitable for the
prototype; an ANN backend remains a scale optimization.

## Experiments after the MVP

Run ablations in this order:

1. Hashing vectors versus a trained semantic embedding provider.
2. Hybrid retrieval with and without learned-route score.
3. Fixed tiers versus Huffman-derived block tiers.
4. Frequency-only weight versus frequency + recency + importance.
5. Online prototype routing versus a PyTorch reranker/router.

Track evidence Recall@K, stale-memory error rate, average injected records/tokens, deepest tier, and P50/P95 latency as history grows.

## Implemented semantic invariants

- `state` memories require a stable `stateKey` and supersede only a prior active
  state with the same key and canonical scope.
- `eventTime` records when an event happened; it is distinct from write and
  validity timestamps.
- `conversation_evidence` records who said something and its truth status; an
  assistant statement is not silently promoted to verified fact.
- A `derived` memory requires at least two source memories and remains
  traceable to their complete evidence chains.
- Typed node edges support graph expansion at query time. The returned context
  includes matching memories, related-node memories, relations, and raw
  evidence records under a caller-supplied budget.
- A memory statement is a retrieval summary. When available, Pi also returns a
  bounded exact-source excerpt so generation can recover details lost to
  summarization.

## Remaining design questions

- What semantic granularity should create a `MemoryNode` rather than a `MemoryRecord`?
- How should acyclicity of derivation and supersession be enforced beyond the
  current application-level contract?
- How should conflicting scope and time intervals be represented?
- What feedback proves that a retrieved memory was useful?
- When does a node split, merge, or regenerate its summary from evidence?
- Which rare constraints must be pinned near the surface regardless of access frequency?
- How should each semantic memory link to the exact raw source message rather
  than only a model-selected excerpt or a whole-session archive?
- Which semantic embedding model offers the best local quality/cost tradeoff?
- At what scale should the persisted vector table be replaced with ANN search?
- Should negative router feedback be explicit, inferred from skipped results, or
  learned only from task outcomes?
