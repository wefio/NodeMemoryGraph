# STG/LTG connectivity and provisional memory

[中文](stg-ltg-connectivity-and-provisional-memory.zh-CN.md) · [Terms used](stg-ltg-connectivity-and-provisional-memory.terms.yaml)

**Authority:** [Parent scope](../design.md).

## STG/LTG connectivity and provisional memory

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

Relation type alone does not grant write authority. The establishment policy is
defined by whether the edge is mechanically entailed by the transaction that
creates it:

| Relation family | Immediate source | Otherwise |
| --- | --- | --- |
| provenance (`derived_from`) | Core derivation transaction with exact source memory IDs | Reject; a model assertion is not provenance |
| lifecycle (`supersedes`) | Validated same-domain state transition with an acyclic predecessor chain | Keep both states and request explicit resolution |
| transform structure (`is_a`, redirects) | Reviewed merge/split transaction and rollback journal | Store a topology proposal, not a consolidated edge |
| explicit domain attachment (`applies_to`, `part_of`) | Harness/tool supplies stable IDs and attributable evidence for both endpoints | Proposal or STG observation |
| regulatory (`contradicts`, `exception_to`, `distinct_from`) | Explicit attributable judgement after scope/time compatibility checks | Proposal; never infer from retrieval co-occurrence alone |
| identity/refinement (`same_as`, `refines`) | Reviewed topology proposal; `same_as` still requires the separate reversible merge actuator to canonicalize identity | Keep nodes separate |
| causal/dependency/support (`causes`, `depends_on`, `supports`) | Explicit attributable evidence or reviewed proposal | STG observation until independently supported |
| associative (`related_to`) | Stability consolidation from independent verified outcomes, or an explicit administrative relation | Co-retrieval remains an observation only |

“Immediate” therefore means _entailed by a governed operation_, not “a model
chose a relation label with high confidence.” Core methods may materialize such
edges inside the same transaction; model-facing `remember(action="relate")`
creates a pending proposal. Administrative `linkNodes` remains an explicit trust
boundary and must not be exposed as unattended model authority.

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
> [memory-graphs.md](../memory-graphs.md), especially its “STG: provisional
> memory,” “STG vs index Delta,” and “Promotion and demotion” sections.

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
