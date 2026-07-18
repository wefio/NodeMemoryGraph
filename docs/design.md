# NMG design baseline

**Status:** 0.1 / MVP baseline  
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
| Semantic layer | Mutable `MemoryNode` objects connected by typed relations. |
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
HistoryRecord (evidence, append-only)
       ▲
       │ evidence_id
MemoryRecord (statement, scope, tier, priority statistics)
       │
       ▼
MemoryNode (semantic concept, state, project, preference, strategy...)
       │
       └── typed relations to other MemoryNode objects
```

The graph and access hierarchy are separate structures:

- Graph edges express semantics such as `part_of`, `depends_on`, `contradicts`, or `supersedes`.
- Tiers express expected access cost inside one node.
- Stable IDs are addresses. Tier or future Huffman codes must never be permanent IDs.

## Pi integration

The extension uses only public Pi extension surfaces:

1. `before_agent_start` searches L0/L1 using the new prompt and appends a small memory block to the system prompt for that run.
2. The injected write policy directs Pi to call `nmg_remember` automatically for stable user-stated facts, preferences, and constraints. Explicit writes use the same path.
3. `nmg_remember` preserves scope, validity, evidence role, and optional supersession metadata rather than deleting earlier evidence.
4. `nmg_search` performs budgeted retrieval and can include deeper tiers or historical states.
5. `agent_end` checkpoints the current transcript; `session_shutdown` provides a final graceful checkpoint.
6. Retrieval records successful tool use for priority statistics; richer answer-level feedback remains future work.

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

## Open design questions

- What semantic granularity should create a `MemoryNode` rather than a `MemoryRecord`?
- Which graph relations must remain acyclic, and which general semantic edges may form cycles?
- How should conflicting scope and time intervals be represented?
- What feedback proves that a retrieved memory was useful?
- When does a node split, merge, or regenerate its summary from evidence?
- Which rare constraints must be pinned near the surface regardless of access frequency?
