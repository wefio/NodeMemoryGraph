# Active Graph, activation, stability, and consolidation

[简体中文](active-graph-activation-and-consolidation.zh-CN.md) · [Terms used](active-graph-activation-and-consolidation.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Active Graph, activation, stability, and consolidation

> AG construction rules moved to [memory-graphs.md](../memory-graphs.md) and [Core data model](core-data-model.md#core-data-model-1);
> activation rules are designed in [edge-activation-design.md](../edge-activation-design.md);
> the tiered disclosure gate is designed in [tiered-disclosure-design.md](../tiered-disclosure-design.md).
> This section keeps the normative activation/stability model.

### Session AG update and projection revisions

Read the complete responsibility: [Session AG update and projection revisions](active-graph-activation-and-consolidation/session-ag-and-projection-revisions.md).

### HA activation, MGR reasoning, and typed edge layers

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

Activation is fast-changing and session/task-local. A highly active node or edge is
not thereby true, durable, or stable. Conversely, a stable LTG constraint may
remain inactive in an unrelated task. AG should separately record which nodes
and edges were selected, which exact evidence was disclosed, which records only
overlapped the answer, and which evidence was independently verified,
contradicted, or rejected. Only the final class can supervise persistence and
controller learning; selection, disclosure, and API-answer overlap remain
observations rather than utility claims.

Hierarchical Activation (HA) manages admission, cooling, reactivation,
redundancy-aware retention, and budget allocation across the session AG. Its
fast `h1` state belongs to the in-memory AG and must be isolated by session and
branch. Slower learned parameters, if validated, belong to versioned
controller/Lab state rather than the AG itself. Router runtime instances now
isolate `h1` by session and discard that fast state on session release; the
learned base parameters remain separate. Task-frame cooling is implemented
deterministically. HA-driven admission remains opt-in and intentionally
unconnected to default retrieval until natural evidence shows it improves
utility rather than merely changing rank.

The Memory-Graph Reasoner (MGR) may consume a bounded HA-selected subgraph and
emit temporary hypotheses, operator paths, or what-if relations. MGR output is
not a memory write: every derived artifact carries source references, starts as
`hypothetical`, consumes the same AG budget, and expires with its task frame
unless separately verified and admitted through `remember`. The opt-in Lab RPC
now requires a session-owned `projectionId`, rejects nodes outside that
projection, caps nodes, edges, steps and results by its AG budget, and marks
outputs non-persistent/hypothetical. Materializing those outputs as TTL-bound AG
items and HA rescoring them remain open.

AG maintains three typed edge layers:

1. semantic edges referenced from STG/LTG;
2. activation/attention edges produced by HA;
3. reasoning/operator edges produced by MGR.

These layers may inform one another during a bounded runtime iteration, but
activation or hypothetical reasoning must never silently increase semantic
confidence or LTG edge stability. The projection ledger preserves the layer and
origin of every exposed edge.

### Edge stability and structural consolidation

Read the complete responsibility: [Edge stability and structural consolidation](active-graph-activation-and-consolidation/edge-stability-and-structural-consolidation.md).

### Adaptive semantic granularity

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

### Node identity and reversible canonicalization

Read the complete responsibility: [Node identity and reversible canonicalization](active-graph-activation-and-consolidation/node-identity-and-reversible-canonicalization.md).

### Static temporal and logical memory chains

Relations answer which semantic nodes are associated. Some recall tasks also
need a bounded, ordered slice of exact memory records: a state history, event
sequence, explicit dependency path, or a branching/merging plan. NMG represents
that structure as an optional **memory chain** over existing `MemoryRecord` IDs.
A chain is not another truth store and does not copy evidence.

```text
MemoryChain
  type: temporal | logical
  topic
  optional ownerSessionId
  ordered member references
  optional directed order edges (DAG)
```

The two types have different write authority:

- A **temporal chain** orders records using explicit event time or another
  attributable sequence. Timestamp order may be derived mechanically; missing
  event time must not be invented.
- A **logical chain** stores only an explicit or naturally supervised order or
  dependency. Similarity, co-retrieval, message adjacency, or model speculation
  cannot create a causal edge.

A memory may join multiple chains. Each chain's directed `order` edges must
remain acyclic; branching and merging are allowed. Adding an edge joins its
endpoint memories idempotently. Removing a member removes incident pointers via
the database integrity rules but never deletes the underlying memory or evidence.
When a member is superseded, chain reads retain the historical member and expose
its active `successorId`, preserving both snapshot and live-reference semantics.

Chains obey physical memory residence. LTG chains are durable/shared. A chain in
a project STG is owned by one session: create/list/get/member/edge operations are
routed to that project's STG and reject a foreign owner. The chain itself does
not promote STG content or bypass the normal consolidation policy.

Retrieval uses chains only after an ordinary query has found a member. It appends
a bounded window of neighbouring members as recall supplements without globally
reranking the original hits. The caller can then request exact evidence using the
normal Active Graph budget. Chain expansion therefore improves ordered context;
it does not prove relevance, causality, correctness, or answer sufficiency.

Chains are part of the normal Agent disclosure path, not Pi-only or
benchmark-only metadata. A host-neutral integration projector under
`src/integration` owns chain names, response-local labels, edge compaction, and
the independent structure budget. Adapter search headers advertise how many
logical chains are represented, label which candidates share a chain, and
direct the Agent to exact `get`. Exact get hydrates every selected record's active
chain memberships and returns only those chain edges whose two endpoints are in
the selected evidence set. Pi and Claude consume the shared projection: each
emits every full statement once, assigns it a short stable label for that
response, and renders logical structure with label-only Mermaid-style edges.
The CLI compact-search projection exposes chain membership and total chain count;
its exact JSON response carries the canonical memberships and edges so a shell-
only Agent can render the same structure without a Pi dependency. Fan-in and
fan-out are grouped (`A & C --> B`
or `A --> B & C`) using the shorter exact representation. Structural disclosure
has an independent 2048-character budget and may be omitted without truncating
or removing exact evidence. OmniMemEval keeps an evaluation-format compatibility
renderer and does not define this product contract. Temporal ordering remains in
record timestamps and is not repeated as a second timeline block.

The stable daemon/CLI administration boundary supports chain create/list/get,
member add/remove, edge add/remove, structured edge reads, and deterministic
topological order. These operations are intentionally absent from the default Pi
model tool surface: a harness may add a higher-level workflow when its domain can
provide trustworthy chain supervision.
