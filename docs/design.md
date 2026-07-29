# NMG design baseline

**Status:** 0.9 / P3 runtime memory model implemented
**Updated:** 2026-07-22

## 1. Definition

Node Memory Graph (NMG) is a local-first long-term memory component for
long-running agents. It preserves immutable historical evidence, derives mutable
semantic memory from that evidence, and progressively discloses only the context
needed by the current task.

NMG separates physical memory residence from runtime exposure:

- the **Short-Term Graph (STG)** holds new, provisional, task-local, or
  not-yet-consolidated semantic information;
- the **Long-Term Graph (LTG)** holds durable atomic memories and consolidated
  semantic structure;
- the **Active Graph (AG)** is a budget-constrained runtime projection selected
  from STG and LTG for the current task, with optional temporary cross-graph
  relations.

AG is not a third authoritative memory graph. It is the virtual memory space
presented to the model. STG and LTG are different logical/physical storage
classes behind that projection, while immutable history remains the evidence
source beneath both.

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
| Pi harness           | Run the model/tool loop, expose session lifecycle events, preserve current-turn execution state, and provide context/tool integration points.                                             |
| NMG Pi plugin        | Capture sessions, enforce memory policy, request an Active Graph projection, inject resident/cue/selected context, expose the small memory API, and schedule background maintenance.      |
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

The default Pi package now exposes these three tools. `nmg_derive`, `nmg_link`,
`nmg_organize`, `nmg_feedback`, and `nmg_rebalance` remain available only when
`NMG_ENABLE_LAB_TOOLS=1`; future versions should move equivalent maintenance to
background or administrative paths.

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

### 5a. Confidence as a posterior: the outcome feedback loop

Claim `confidence` today is a prior — the extractor's self-assessment at write
time. A memory system earns the word "experience" only when that number is
corrected by what happened when the memory was used. This loop is the one
capability no LLM can provide on its own: outcome information (did the task
succeed after this memory was retrieved and rendered?) is produced after and
outside the model's inference, so only the external store can capture it and
write it back. Model upgrades improve the prior; they can never close this
loop.

Mechanism (minimal, deterministic):

1. **Usage logging.** Each retrieval that renders a record into an Active
   Graph appends `(record_id, claim_id, query/task id, timestamp)` to a usage
   ledger. Rendering, not just ranking, counts — an unrendered candidate
   exerted no influence.
2. **Outcome attribution.** When the enclosing task/session closes with a
   success/failure signal (explicit user feedback, eval verdict, or task
   status), every rendered claim receives one outcome vote. Outcomes are
   recorded as events with provenance, never as silent in-place edits.
3. **Posterior update.** Claim confidence becomes
   `posterior = f(extraction prior, accumulated outcome votes)` — a Beta-style
   running update keeps the storage to two counters per claim and stays
   auditable. The raw prior is preserved so re-weighting rules can change
   without re-extraction.
4. **Retrieval weighting.** Rank fusion consumes the posterior, not the
   prior: repeatedly useful memories surface more easily; memories that
   correlate with failures sink toward archival review rather than being
   deleted (history stays immutable).
5. **Credit discipline.** Correlation is not causation — a memory co-rendered
   with a failure is a suspect, not a culprit. Votes from the same session or
   task are discounted, and a claim's posterior is only trusted after a
   minimum number of independent usages (hysteresis), so early noise cannot
   bury a good memory.

This loop also answers, at claim granularity, part of the open routing
question in section 17: the usefulness signal lives on the claim, not on the
router's selection, so reinforcing a good memory does not require reinforcing
the path that found it.

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

STG records and isolated/provisional nodes must participate in global FTS,
exact, recency, and optional vector search. Graph traversal is a candidate
expansion mechanism, never the only retrieval entry point. STG entries may be
persisted in SQLite for crash recovery and cross-turn continuity; expiry is a
policy decision, not an implication that short-term data must live only in RAM.

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

AG construction is query planning, not graph copying. It should first identify
candidate nodes, then allocate local-content and relation budgets according to
expected usefulness. The model can request progressive expansion, but the
harness enforces the total budget and provenance boundary.

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
remain inactive in an unrelated task. AG should record which nodes and edges
were selected, expanded, actually used, contradicted, or rejected so later
maintenance can distinguish retrieval from utility.

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

Completed Pi turns are checkpointed automatically. Message persistence is
idempotent by stable `(session_id, source_message_id)`. A changed session archive
appends a new immutable evidence record rather than mutating an old one.

Session storage and semantic extraction are separate:

```text
Pi message/turn
  -> immediate HistoryRecord append
  -> extraction queue
  -> zero or more governed MemoryRecord writes into STG
  -> optional immediate atomic promotion into LTG
  -> later evidence-backed structural consolidation
```

Clear, stable user-stated facts, preferences, constraints, and replaceable
states may become atomic LTG memories automatically. They do not need to wait for
a stable local subgraph. Ambiguous, inferred, sensitive, or current-task-only
candidates remain in STG, require confirmation, or expire according to policy.
Inferred relations and derived concepts require repeated independent evidence
before structural consolidation. Casual chatter, credentials, secrets, and
unverified model claims do not become verified semantic memory. Assistant
content may be retained as unverified conversation evidence when it is useful to
remember that it was said.

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

## 11. Progressive retrieval

Progressive retrieval constructs and expands the Active Graph; it is separate
from both storage tiers and the STG/LTG lifecycle:

1. **Resident layer:** a very small query-independent seed of critical
   constraints and stable profile information placed into every relevant AG.
2. **Automatic recall layer:** bounded dynamic selection from STG and LTG based
   on the current query, task, scope, time, and available budget.
3. **Agent-directed recall layer:** compact headers/cues that let the model call
   `nmg_search`, inspect costs, and expand the AG with exact details through
   `nmg_get`.

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

| Model | twin-as-top1 | cos(neg, twin) | cos(neg, best other neg) |
| --- | ---: | ---: | ---: |
| bge-small-en-v1.5 | 9/10 | 0.823 | 0.671 |
| Qwen3-Embedding-0.6B | 10/10 | 0.861 | 0.556 |
| gemini-embedding-001 | 10/10 | 0.881 | 0.654 |

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
(`docs/predicate-key-canonicalization.md`,
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

The tool is Lab-only (`NMG_ENABLE_LAB_TOOLS=1`). NMG Lite keeps its stable
three-tool surface, and the existing numerical MGR prototype remains available
for independent experiments.

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

- a normal Pi package manifest, stable extension entry, and the three-tool Lite
  surface with optional Lab tools;
- progressive `nmg_search` headers followed by exact `nmg_get` evidence loading;
- a persistent Inbox/Delta path that survives restart, participates in hierarchy
  retrieval before compaction, and is acknowledged only after external leaf
  embeddings finish;
- dirty-node threshold scheduling and node-local leaf rebuilding with stable
  content-derived block IDs that preserve unchanged embedding cache entries;
- Float32 BLOB persistence with backward-compatible JSON migration and
  disposable contiguous vector caches that support geometric append/update;
- local SQLite history, semantic memory, typed relations, evidence links, and
  session checkpoints;
- state supersession, event time, actor/truth status, scope, merge/split, and
  redirects;
- resident/automatic/cue execution layers;
- a Lab-only, file-backed session reasoning workspace with bounded compaction
  checkpoints and explicit hypothesis/evidence status;
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
- automatic turn-end maintenance in the Pi harness: session checkpointing, STG
  expiry, due-node batch rebalancing, and conservative stability-driven
  consolidation/demotion;
- accepted and rejected write-policy audit events, including durable write
  reason and source while deliberately excluding rejected statement/evidence
  content;
- FTS5, hashing evaluation vectors, model-neutral external embeddings with
  explicit query/document profiles, node/leaf indexing, and a
  rebuildable USearch experiment;
- L0-L3 local tiers, accumulated access statistics, and batch rebalancing;
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

- the reasoning workspace has no learned or deterministic activation gate yet;
  when exposed, the model may update it every turn even when the full transcript
  is already sufficient;
- reasoning nodes distinguish type and status, but hypothesis writes are not
  yet required to cite evidence, and the system does not independently detect
  unsupported scratchpad claims;
- reasoning checkpoints are bounded and session-persistent, but scratchpad
  expiry, archive policy, cross-session task continuation, and explicit
  promotion into STG/LTG remain undesigned or manual;
- the workspace exposes consolidation candidates in core code, but Pi does not
  automatically review or promote them; this is intentional until provenance
  and false-promotion evaluation are stronger;
- `MemoryGraphReasoner` remains a numerical Lab prototype that scores the
  global unvisited candidate set rather than following graph edges;
- QPP1, QPP2, and search recommendation are now independently wired, but none
  has passed its production gate. QPP1 budget prediction correlated poorly
  with the oracle Fibonacci tier in the full LoCoMo audit; QPP2 scores are
  listwise rather than absolutely calibrated; and the cost/benefit of asking
  the model to search again has not been measured. QPP1 therefore defaults to
  shadow, QPP2 to off, and the advisory only recommends rather than invokes;
- QPP2 folding is lossless at the store/Active-Graph layer but not necessarily
  lossless for the model: a needed candidate can remain folded unless the model
  explicitly unfolds the directory. A matched end-to-end test must measure
  answer quality, evidence use, extra tool calls, tokens, and latency;
- the claim-level posterior outcome loop in section 5a remains design-only.
  Retrieval/use/outcome events exist, but independent-task Beta-style counters
  do not yet update claim confidence or retrieval ranking;
- the ANN experiment has unacceptable recall on the near-duplicate workload;
- automatic extraction evaluation and the matched full-history sample are not
  yet large enough to make a product-quality claim;
- the four official benchmark adapters validate and use official-format parsing,
  but larger repeated official-protocol runs have not yet established NMG's
  general capability improvement;
- accepted topology proposals are an offline/Lab maintenance operation, not an
  unattended production mutation policy;
- store-level deletion and dependency cleanup exist, but a user-facing privacy
  deletion/export interface and erasure of every derived learned signal remain
  P5 work;
- automatic recall exposure is recorded as selection, not usefulness; without
  answer-level citations the harness cannot prove that injected memory changed
  the final answer. Agent-directed `nmg_get(activeGraphId=...)` is the current
  conservative usefulness signal.
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

Current development evidence (updated 2026-07-29):

- 275 automated tests cover UOp autodiff, the differentiable controller,
  hierarchical activation, the retained memory-graph reasoner prototype,
  reasoning-workspace persistence and checkpoint injection, P3 lifecycle,
  budget enforcement, actual-use activation, independent-task deduplication,
  reversible consolidation, write-policy audit, Active Graph traces, official
  benchmark adapters, and schema migration. Test files live in `tests/core/`,
  `tests/evals/`, and `tests/extensions/nmg/`.
- a clean DeepSeek V4 Flash Pi process wrote a unique LTG fact, a second process
  recovered it through `nmg_search -> activeGraphId -> nmg_get`, and the store
  recorded one selection and one actual use; isolated test data was removed
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

The current Pi regression, seven-category invariant suite, controlled topology
ablation, and strict seven-question LongMemEval matched sample prove integration
and mechanism behaviour, not general capability improvement. The matched sample
did ingest every haystack session for each selected question, but its
zero-configuration FTS/hashing path missed five of seven required evidence sets.
A matched external-embedding run and a larger fixed sample with repeated model
runs are required before claiming that NMG improves agent performance.

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
6. **Complete as an isolated Lab primitive:** implement a tinygrad-inspired
   UOp autodiff engine and serializable multi-head controller for node, edge,
   STOP/EXPAND, and budget decisions. Activation in the Pi retrieval path remains
   gated on a fixed feature contract and matched evidence-recall/cost evaluation.
7. **Mechanism complete, production gate open:** independently selectable QPP1
   allocation, QPP2 progressive folding, and search recommendation are wired
   through the Pi adapter. QPP2 preserves folded candidates in the Active Graph.
   Calibration, matched answer-quality/cost evaluation, and safe default
   promotion are not complete.

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

1. Add a user-facing privacy deletion/export workflow over existing store-level
   deletion and dependency cleanup, including learned-signal erasure.
2. Add optional encrypted cloud synchronization only after the local protocol
   and multi-device conflict semantics are specified.

### Immediate validation order

The next work should reduce uncertainty rather than add another subsystem:

1. Run a small matched Pi experiment over the same fixed questions with QPP
   controls independently ablated: deterministic, QPP1 active, QPP2 active,
   recommendation active, and the combined path. Record evidence recall,
   answers, tool-call count, injected tokens, and end-to-end latency.
2. Calibrate QPP1 against oracle evidence depth and QPP2 against evidence
   retention. Do not promote either default merely because a larger pool raises
   raw recall.
3. Test whether the model follows one search recommendation when useful,
   ignores it when unnecessary, and stops after an unproductive search.
4. Implement the claim outcome posterior from section 5a only after the
   existing use/outcome events can be attributed to independent tasks without
   self-reinforcement.
5. Harden the plugin boundary: add an installable Pi package manifest, validate
   the Pi session-entry schema, document the single-writer concurrency model,
   and expose user-facing delete/export.
6. Keep ANN, unattended topology mutation, cloud sync, and automatic reasoning
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
