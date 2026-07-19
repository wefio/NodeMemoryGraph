# NMG design baseline

**Status:** 0.5 / slim plugin boundary and adaptive semantic coding
**Updated:** 2026-07-19

## 1. Definition

Node Memory Graph (NMG) is a local-first long-term memory component for
long-running agents. It preserves immutable historical evidence, derives mutable
semantic memory from that evidence, and progressively discloses only the context
needed by the current task.

The primary integration target is the Pi agent harness. Pi owns the model loop,
session lifecycle, tools, and UI. NMG owns durable memory, provenance, retrieval,
and memory-maintenance policy. NMG is not an agent harness, a sandbox, or a cloud
platform.

NMG has two intentionally different surfaces:

- **NMG Lite** is the default product surface: a zero-configuration Pi plugin
  backed by SQLite and a small model-facing API.
- **NMG Lab** contains measured experiments such as graph routing, adaptive
  tiers, ANN, learned routing, and topology refinement. A Lab feature enters
  Lite only after an ablation demonstrates a benefit over a simpler baseline.

The repository may contain both surfaces, but experimental complexity must not
become an installation or prompt dependency for the default plugin.

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

## 3. Responsibility boundaries

| Component | Responsibilities |
|---|---|
| Base model | Identify candidate facts/preferences/constraints, summarize, reformulate queries, decide whether more evidence is needed, propose semantic relations or splits, and synthesize an answer. |
| Pi harness | Run the model/tool loop, expose session lifecycle events, preserve current-session state, and provide context/tool integration points. |
| NMG Pi plugin | Capture sessions, enforce memory policy, inject resident/cue context, expose the small memory API, and schedule background maintenance. |
| NMG core | Maintain stable IDs, provenance, time/scope/state invariants, retrieval budgets, semantic organization, and rebuildable indexes. |
| SQLite/index backend | Provide transactions, WAL/crash recovery, FTS, versioned records, dirty queues, content hashes, and physical index/cache persistence. |
| Optional learner | Learn query-to-node/leaf scores, edge usefulness, expansion depth, or stopping policy from labelled retrieval outcomes. It does not own persistent topology. |

Stronger models can improve extraction, summarization, query planning, conflict
interpretation, and topology proposals. They cannot naturally provide
cross-session persistence, transactions, stable provenance, deletion propagation,
index maintenance, or deterministic budget enforcement. Those remain system
responsibilities.

## 4. Product boundary: NMG Lite

The target default plugin should install as a normal Pi package and require only
Node.js, Pi, and SQLite. FTS search must work without an embedding server. A
semantic embedding provider may be enabled by configuration, but local Qwen,
vLLM, CUDA, USearch, PyTorch, Cloudflare, and Docker are not default
dependencies.

The target model-facing surface is three tools:

```text
nmg_search(query, filters, budget)
  -> compact result headers, IDs, dates, types, sources, and retrieval costs

nmg_get(ids)
  -> exact selected memories and bounded raw evidence

nmg_remember(statement, type?, scope?)
  -> explicit/hot-path durable write through the same governed write policy
```

Automatic extraction may use the same write path. Privacy deletion, reindexing,
graph editing, feedback inspection, and maintenance belong in CLI/UI/background
operations rather than ordinary model tools.

The current prototype exposes seven tools. `nmg_derive`, `nmg_link`,
`nmg_organize`, `nmg_feedback`, and `nmg_rebalance` are useful Lab APIs, but the
default plugin should hide them once equivalent background or administrative
paths exist.

## 5. Core data model

```text
HistoryRecord
  - immutable evidence during normal maintenance
  - stable session/message/tool source identity
  - exact content and timestamp
       |
       | evidence link (mandatory)
       v
MemoryRecord
  - fact | state | event | preference | constraint
  - strategy | conversation_evidence | derived
  - scope, actor, truth status, event/valid time, state identity
       |
       | zero or more semantic memberships
       v
MemoryNode
  - stable semantic address and compact header
  - bounded leaf/block hierarchy
  - typed relations to other nodes
```

A `MemoryRecord` is a durable retrievable statement. A `MemoryNode` is a stable
semantic address for a coherent group of records. Creating one permanent node
for every new memory would reproduce a flat store with extra graph overhead and
is not the target model.

## 6. Connectivity and provisional memory

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

New durable records first enter a searchable Inbox/Delta:

```text
HistoryRecord
  -> governed extraction
  -> Memory Inbox / Delta
       |- high-confidence match -> attach to existing node
       |- explicit new concept  -> create provisional/new node
       `- ambiguous             -> remain globally searchable and unassigned
```

Inbox records and isolated/provisional nodes must participate in global FTS,
exact, recency, and optional vector search. Graph traversal is a candidate
expansion mechanism, never the only retrieval entry point.

An isolated node may later be merged as an alias, refined under a parent,
linked to another independent concept, or remain isolated. Adding an edge does
not imply merging node identity.

General semantic relations may cycle. Derivation and supersession dependencies
must remain acyclic. Each query may materialize a bounded, visited-set-protected
local expansion DAG even when the persistent semantic graph contains cycles.

## 7. Adaptive semantic granularity

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

## 8. Information and communication interpretation

The information-theoretic model is a design and evaluation framework, not a
requirement to implement a literal codec:

```text
Historical stream       information source
Memory extraction       source encoder
Node/leaf headers       hierarchical codebook
SQLite/index            storage channel
Query/current context   decoder side information
Retriever               decoder
Raw evidence            lossless fallback and error check
```

Node headers are short lossy codes. Leaf headers add discriminating bits. Typed
relations provide side information. Raw history prevents irreversible loss.

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

Completed Pi turns are checkpointed automatically. Message persistence is
idempotent by stable `(session_id, source_message_id)`. A changed session archive
appends a new immutable evidence record rather than mutating an old one.

Session storage and semantic extraction are separate:

```text
Pi message/turn
  -> immediate HistoryRecord append
  -> extraction queue
  -> zero or more governed MemoryRecord writes
```

Clear, stable user-stated facts, preferences, constraints, and replaceable
states may become long-term memories automatically. Ambiguous, inferred,
sensitive, or current-task-only candidates require confirmation. Casual chatter,
credentials, secrets, and unverified model claims do not become verified
semantic memory. Assistant content may be retained as unverified conversation
evidence when it is useful to remember that it was said.

Replaceable state uses a stable semantic `stateKey` plus canonical scope. A new
active value supersedes the prior value without deleting historical evidence.

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

Maintenance has three scopes:

1. **Local:** rebuild only the affected block, leaf vector, or node header.
2. **Accumulated:** compact when record/token/dirty-ratio thresholds are reached
   or during an idle period.
3. **Neighbourhood:** batch nearby dirty nodes when they share records,
   embeddings, or likely topology work.

SQLite is authoritative and should own transactions, content hashes, version
markers, dirty queues, FTS, and crash recovery. NMG decides semantic grouping,
summary invalidation, and topology changes. A process-local contiguous
`Float32` matrix may cache active node/leaf embeddings; it is disposable and
rebuildable from versioned binary vectors in storage.

ANN is optional. It must not replace exact node/leaf scanning until exact-vs-ANN
recall audits show acceptable quality at a scale where exact scanning violates
the latency budget. Current near-duplicate tests do not justify enabling the
prototype USearch path by default.

## 11. Progressive retrieval

Execution-time memory exposure is separate from storage tiers:

1. **Resident layer:** a very small query-independent block of active critical
   constraints and stable profile information.
2. **Automatic recall layer:** bounded dynamic evidence for explicit historical
   or current-state questions.
3. **Agent-directed recall layer:** compact headers/cues that let the model call
   `nmg_search`, inspect costs, and fetch details with `nmg_get`.

Candidate generation should compose independent signals:

```text
Inbox/Delta + global FTS/exact + node/leaf semantic routing
  -> optional graph expansion
  -> scope/time/truth filtering
  -> type-aware reranking and diversity
  -> compact headers
  -> selected exact evidence
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

## 12. Learnable routing and differentiable query graphs

NMG does not require PyTorch. It requires only that a routing implementation can
be compared against deterministic baselines and, if learnable, receive useful
credit from retrieval outcomes.

The persistent semantic graph and a differentiable computation graph are
different objects:

```text
persistent NMG graph in SQLite
  -> retrieve a bounded local candidate subgraph
  -> materialize query/node/edge tensors
  -> score nodes, edges, STOP, and EXPAND
  -> select evidence through the discrete backend
```

An optional differentiable router may optimize a loss such as:

```text
L = route_loss
  + lambda * expected_tokens
  + mu     * expected_depth
  + gamma  * false_memory_cost
  + eta    * evidence_miss_cost
```

PyTorch, JAX, a small custom autodiff engine, or a closed-form linear update are
implementation choices. If only black-box task success is available, a
contextual bandit or other discrete online learner may be more appropriate than
automatic differentiation. A remote Pi model API is not differentiable; normal
backpropagation therefore needs evidence labels, useful-node feedback, or a
separate teacher signal.

Suggested interface boundary:

```ts
interface RouteModel {
  score(query: QueryFeatures, graph: LocalGraphFeatures): RouteDecision;
}

interface RouteTrainer {
  observe(trace: RetrievalTrace, outcome: RetrievalOutcome): void;
}
```

The zero-configuration default remains heuristic/hybrid routing. A learned
router becomes default only if it improves evidence recall or retrieval cost in
matched evaluation.

## 13. Current implementation versus target

Implemented and verified in the current prototype:

- local SQLite history, semantic memory, typed relations, evidence links, and
  session checkpoints;
- state supersession, event time, actor/truth status, scope, merge/split, and
  redirects;
- resident/automatic/cue execution layers;
- FTS5, hashing vectors, Qwen3 external embeddings, node/leaf indexing, and a
  rebuildable USearch experiment;
- L0-L3 local tiers, accumulated access statistics, and batch rebalancing;
- Pi RPC regression tests, initial LongMemEval development runs, and scale
  experiments.

Important gaps between the prototype and the target plugin:

- the repository is not yet packaged for one-command Pi installation;
- the current Pi extension exposes seven tools rather than the target three;
- the Qwen node/leaf hierarchy is benchmarked in core but is not yet the normal
  Pi extension retrieval path;
- semantic leaf maintenance is not yet a complete stable-ID incremental
  compactor;
- the ANN experiment has unacceptable recall on the near-duplicate workload;
- the automatic extraction and full-history baseline comparisons are not yet
  large enough to make a product-quality claim.

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

If Lite does not beat the flat hybrid control, its hierarchy has no demonstrated
product value. If Graph does not beat Lite, graph adaptation remains a Lab
feature. If a learned router does not beat deterministic routing, it remains
optional.

Track evidence Recall@K, stale-memory error, wrong-scope error, false-memory
injection, answer accuracy, unrelated-task regression, injected tokens, deepest
tier, index/maintenance cost, and end-to-end P50/P95 latency including query
embedding.

The current six-case Pi regression and seven-question LongMemEval development
sample prove integration mechanisms, not general capability improvement. Full
haystack and larger matched runs are required before claiming that NMG improves
agent performance.

## 15. Cloud and sandbox boundaries

Cloud sync is optional and never authoritative. A future backend may exchange
immutable operations and content-addressed encrypted objects rather than copying
a live SQLite file. Cloudflare coordination is not part of NMG Lite.

NMG stores and retrieves memory; it does not execute remembered commands. Pi
extensions run with the Pi process permissions. If untrusted execution becomes
necessary, it belongs behind a separate `ExecutionBackend`, with Docker as the
first local candidate. Sandbox lifecycle is not part of the memory model.

## 16. Revised implementation order

### P0: make the memory plugin small and real

1. Add a Pi package manifest and stable installable extension entry.
2. Reduce the default model-facing API to search, get, and remember.
3. Keep SQLite + FTS/exact retrieval as the zero-configuration path.
4. Wire the measured node/leaf semantic path behind an optional embedding
   provider with a reliable fallback.

### P1: incremental correctness and fair evaluation

1. Add Inbox/Delta retrieval and dirty-node local rebuild scheduling.
2. Introduce stable leaf identities, binary vector storage, and a disposable
   contiguous in-memory cache.
3. Complete matched no-memory, raw-session, flat-hybrid, Lite, and Graph
   LongMemEval runs.
4. Add temporal, aggregation, conflict, multi-hop, exact-detail, privacy, and
   memory-pollution cases.

### P2: adaptive semantic graph experiments

1. Record ambiguity, fallback, contradiction, and co-retrieval signals.
2. Propose delayed links and node refinements with evidence and hysteresis.
3. Compare adaptive topology with fixed nodes and flat retrieval.
4. Test a framework-independent learnable router only after useful labels exist.

### P3: optional platform capabilities

1. Explicit privacy deletion and dependency cleanup.
2. Optional encrypted cloud synchronization.
3. A sandbox adapter only if an execution use case appears.

## 17. Remaining design questions

- What measured ambiguity/coverage thresholds justify node creation or
  refinement?
- Which deterministic relation types are safe to establish immediately, and
  which always require confirmation?
- How should interval conflicts and partial scope overlap be represented?
- What feedback proves a retrieved memory was useful without reinforcing the
  router's own prior selections?
- Which rare safety/user constraints must remain pinned regardless of access
  frequency?
- What stable leaf identity permits local rebuilds without changing unrelated
  addresses?
- At what measured node/leaf count does exact contiguous vector scan stop
  meeting the end-to-end latency budget?
- What privacy/delete interface can remove raw evidence and every dependent
  summary, cache, and learned signal?

## 18. Concise technical definition

> NMG is an adaptive semantic coding system for agent memory. It encodes
> immutable historical evidence into mutable, variably granular semantic nodes
> and relations; uses the current query as decoder side information; retrieves
> evidence through budgeted progressive disclosure; and preserves exact history
> as a lossless fallback against semantic retrieval error.
