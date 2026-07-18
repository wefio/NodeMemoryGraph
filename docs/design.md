# NMG design baseline

**Status:** 0.2 / typed semantic-memory baseline  
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
| Node-local history | `MemoryRecord` references evidence and belongs to a local tier L0-L3. |
| Retrieval | Route to a small candidate set, read shallow tiers first, then expand under a budget. |
| Huffman idea | An optimization hypothesis: expected usefulness should affect depth. The MVP uses tiers rather than a literal Huffman tree. |
| Write policy | Clear stable user-stated facts, preferences, and constraints are automatic. Ambiguous or inferred candidates require confirmation; secrets and transient instructions are rejected. |
| Session evidence | Each completed Pi turn checkpoints its session transcript as cold evidence. Session archives do not automatically become semantic memories. |
| Cloud | Optional coordination/sync backend later; never the only copy. |
| Sandbox | Outside NMG core. Add an execution backend only when a real task requires untrusted execution. Docker is the first candidate. |
| Learning | PyTorch may later learn routing, stopping, or priority; storage topology remains an external discrete system. |

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

## Pi integration

The extension uses only public Pi extension surfaces:

1. `before_agent_start` performs graph-aware L0/L1 retrieval using the new prompt and appends a small, typed memory block to the system prompt.
2. The write policy directs Pi to call `nmg_remember` automatically for stable user-stated facts, preferences, constraints, and states. Explicit writes use the same path.
3. `nmg_remember` preserves memory type, scope, actor, truth status, event time, evidence role, and state identity. A matching `stateKey` and canonical scope supersede the prior active state automatically.
4. `nmg_search` performs budgeted retrieval, expands typed graph neighbors, hydrates evidence, and can include deeper tiers or historical states.
5. `nmg_derive` creates a conclusion from multiple source memories and inherits their evidence chains. `nmg_link` creates typed node relations.
6. The injected use policy distinguishes facts from unverified conversational evidence, uses only the newest active state, obeys constraints, adapts to preferences, preserves event time, and applies strategies as procedures rather than facts.
7. `agent_end` checkpoints the current transcript; `session_shutdown` provides a final graceful checkpoint. Changed transcripts append a new immutable snapshot instead of mutating the old record.
8. Retrieval records successful tool use for priority statistics; richer answer-level feedback remains future work.

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

The MVP does not claim semantic scalability yet. Its lexical retrieval exists to validate lifecycle and interfaces before embeddings are introduced.

## Experiments after the MVP

Run ablations in this order:

1. Flat lexical/vector retrieval versus node-routed retrieval.
2. Fixed local tiers versus no local tiers.
3. Frequency-only priority versus frequency + recency + importance + conflict protection.
4. Fixed tiers versus block-based Huffman-like depth allocation.
5. Rule-based routing versus a learned router.

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

## Remaining design questions

- What semantic granularity should create a `MemoryNode` rather than a `MemoryRecord`?
- How should acyclicity of derivation and supersession be enforced beyond the
  current application-level contract?
- How should conflicting scope and time intervals be represented?
- What feedback proves that a retrieved memory was useful?
- When does a node split, merge, or regenerate its summary from evidence?
- Which rare constraints must be pinned near the surface regardless of access frequency?
