# Memory-Graph Reasoner — retained numerical Lab prototype

[中文](memory-graph-reasoner.zh-CN.md) · [Terms used](memory-graph-reasoner.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Memory-Graph Reasoner — retained numerical Lab prototype

`MemoryGraphReasoner` is retained as a gated numerical engine. It is not part of
NMG Lite and is not the [session reasoning scratchpad](session-reasoning-workspace-and-compaction-checkpoint.md).
The Lab service binds the supplied base graph to an owned session AG projection
and its declared budgets; that binding is not automatic HA-to-MGR orchestration.
The numerical library supports both the legacy global candidate experiment and explicit directed
topology. When any input node declares `outgoing`, the first step is a global
query seed and every later step is restricted to the preceding node's outgoing
neighbors; training rejects paths that violate those edges. This proves edge
adherence, not factual correctness or automatic logical inference.

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

| Parameter | Scope | Meaning |
| --- | --- | --- |
| `b_log` | per-node | Higher = more absorption from this memory |
| `a_log` | global | Higher = retain more past context across steps |
| `β_log` | per-node | Higher = output favours accumulated state over original query |

Nodes may declare `requires: string[]`. In `traverse`, each named fact contributes
`sigmoid(factVector · currentState)`; their product (soft-AND) multiplies the
absorption gate `g`. These are numerical similarities, not verified truth or a
hard admission check. A missing fact uses a zero vector and therefore contributes
`0.5`, not zero. Candidates are not filtered by this gate: even zero absorption
does not structurally exclude a node, because its retained/query-anchor state
still receives a relevance score. `trainPath` does not pass these preconditions
into its state updates; it checks declared path edges, not fact satisfaction.
See `traverse`, `#reasonStep` and `trainPath` in
`src/lab/memory-graph-reasoner.ts` for the implementation boundary.

### Relationship to HierarchicalActivation

| | HA | MGR |
| --- | --- | --- |
| Node role | passive data, scored | active operator, transforms |
| Scoring | 7-way similarity blend | single gate + local relevance |
| Graph structure | fixed candidate hierarchy | global seed, then optional directed neighbors |
| Parameters | 10 global scalar values: 7 score weights plus temperature, temporal alpha and reasoning beta | 2/node + 1 global for traversal; set membership adds a global sharpness parameter |
| Intended experiment, not validated superiority | batch ranking over pool | multi-step numerical path reasoning |

They remain separately gated engines but share the proposed session AG runtime:
HA selects and maintains the active working set; MGR optionally transforms a
bounded selected subgraph into temporary reasoning artifacts. Utility and
inference correctness still require their own evidence. The explicit Lab
projection binding exists, but does not establish this automatic combined path.

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

The example calls the numerical library, not the Lab wire API. `trainPath`
updates the local reasoner's parameters to maximize the supplied path's summed
local scores; it neither contrasts alternative paths nor certifies the greedy
route. `whatIf` uses `Map.set`: reuse of an existing ID replaces that node in the
local copy rather than adding another node.

### Experimental status

MGR is exposed as the session-scoped `memory_graph_reasoner` Lab capability on
the daemon, CLI, Pi, MCP, and DSH adapters. It produces deterministic traversal,
fuzzy-set search, and what-if summaries, including explicit edge-constrained
paths. Read-only refers to the Lab service's memory/storage effects, not to
purity of the library object or its training methods. The service exposes only
`traverse`, `logic_search` and `what_if`, creates a fresh reasoner per invocation,
and labels its outputs `persisted: false`. It checks the base graph's node IDs
and node/edge counts against the owned projection before hypothetical insertion;
this is not a claim that the augmented what-if graph is rechecked against the
same counts. Neither traversal nor a summary is a verified LLM-offloaded
inference engine. The service boundary is in `src/cli/service.ts`
(`#invokeMemoryGraphReasoner`) and `src/integration/lab-capabilities.ts`.

The following is an illustration, not a measured run. A changed greedy path or
score does not establish a causal effect or a task-scheduling critical path;
the LLM's last sentence is an interpretation, not a result certified by MGR.

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

Read the complete responsibility: [Differentiable set logic](memory-graph-reasoner/differentiable-set-logic.md).
