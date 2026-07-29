# NMG improvement areas

**Created:** 2026-07-20
**Status:** working notes, not a roadmap commitment

This document collects known gaps, risks, and opportunities discovered during
code review and evaluation. Each item includes the observed symptom, the
underlying concern, and one or more concrete approaches. Items are grouped by
impact rather than priority.

## Status audit — 2026-07-29

The detailed notes below preserve the problem history. Current status is:

| # | Area | Current status |
| --- | --- | --- |
| 1 | Store decomposition | **Partial.** Schema, ranking, Active Graph, vector codec, row parsing, and embedding-index concerns were extracted, but `store.ts` has grown to roughly 4,100 lines and remains the main maintainability risk. |
| 2 | Vector-cache invalidation | **Resolved for the stated mechanism.** `Float32VectorCache.remove(id)` and targeted invalidation tests exist. Revisit only if measured rebuild latency regresses. |
| 3 | Router expressiveness | **Superseded experimentally, not proven.** The custom autodiff controller now learns node, memory, edge, control, and budget heads, but still lacks a production-quality matched quality/cost win. |
| 4 | Privacy deletion | **Core partial.** Soft deletion, FTS/embedding/evidence/leaf cleanup, and unsupported-derived-memory cascade are implemented and tested. User-facing delete/export and erasure of learned aggregate signals remain open. |
| 5 | Regex-only recall gate | **Open.** English/Chinese deterministic coverage is tested; multilingual semantic gating and measured false-positive/false-negative rates are not. |
| 6 | Test coverage | **Substantially improved.** The listed Chinese, graph, split, cache, and deletion paths now have coverage. Session-schema drift, QPP recommendation behavior, and natural topology adaptation remain important gaps. |
| 7 | ANN recall | **Deferred by evidence.** Exact local scan remains the default; the current ANN path must not be promoted without a recall/latency crossover. |
| 8 | Concurrency model | **Open.** Current runtime assumes one Pi extension event loop and one synchronous SQLite handle. |
| 9 | Session serialization | **Open.** Capture is automatic and idempotent, but the Pi branch shape is still parsed from `unknown` without a versioned validator. |
| 10 | Topology acceptance | **Intentionally Lab/manual.** Proposal creation and explicit review work; unattended mutation lacks a precision gate. |

---

## 1. Store file is too large (~4,100 lines)

**Symptom:** `src/core/store.ts` contains mutations, queries, maintenance
operations, schema migrations, and formatting helpers in one class.

**Concern:** A single 2,900-line file is hard to navigate, review, and test in
isolation. New contributors must understand the entire file before making a
safe change.

**Approaches:**

- **Split by concern (recommended):**
  - `store-mutations.ts` — `remember`, `deriveMemory`, `mergeNodes`, `splitNode`
  - `store-queries.ts` — `search`, `searchContext`, `routeNodes`, `recallCues`,
    `getContext`, `residentKernel`
  - `store-maintenance.ts` — `rebalanceNode`, `rebalanceDueNodes`,
    `rebuildVectorIndex`, `rebuildLeafBlocks`, `acknowledgeIndexDelta`
  - `store-migrations.ts` — `#migrate` and all `#ensure*` helpers
- Keep `NmgStore` as a thin public façade that delegates to the split modules.
- Move standalone helper functions (`mapNode`, `mapSearchResult`,
  `stableLeafBlockId`, `leafBlockSummary`, etc.) to a `store-mapping.ts` or
  keep them module-private in the query module.

**Constraint:** all modules share one `DatabaseSync` handle; the split must
preserve transactional integrity. Passing the handle and prepared-statement
caches explicitly is safer than opening a second connection.

---

## 2. Vector cache invalidation is too coarse

**Symptom:** `#invalidateVectorCaches(kind)` drops the entire leaf or node
cache regardless of which IDs actually changed.

**Concern:** After a single-node merge or split every node embedding cache is
discarded and rebuilt lazily on the next query. At a few hundred nodes this is
cheap; at a few thousand it adds measurable latency.

**Approaches:**

- **Per-ID invalidation:** add a `remove(id: string)` method to
  `Float32VectorCache` and call it from `mergeNodes`/`splitNode`/`rebuildLeafBlocks`
  for the exact affected IDs.
- **Generation counter:** tag each cache entry with a generation number and
  bump the generation when the underlying row changes. Stale entries are
  skipped during scoring and lazily evicted.
- Defer: measure cache rebuild cost at the target scale first. If rebuilding
  10,000 entries takes < 5 ms the coarse invalidation is acceptable.

---

## 3. OnlineNodeRouter has limited expressiveness

**Symptom:** `OnlineNodeRouter` is a per-node exponential moving average
(EMA) of query embedding vectors. Scoring is cosine similarity between the
stored EMA vector and the new query vector. There is no notion of negative
examples or cross-node feature interaction.

**Concern:** An EMA of positive query vectors converges toward the centroid
of queries that happened to be labelled useful. It cannot distinguish "this
node is relevant" from "this query vector happens to be close to the centroid
of a popular topic." When multiple nodes share similar vocabulary the router
may assign high scores to all of them, providing no discrimination.

**Approaches:**

- **Logistic regression per node (moderate complexity):** store a weight
  vector learned via online logistic regression with both positive (useful)
  and negative (retrieved but not marked useful) labels. The current
  `usefulMemoryIds` field in `RetrievalTraceInput` already provides the label
  source.
- **Small two-layer MLP shared across nodes (higher complexity):** a compact
  query encoder projected into the same space as node embeddings, trained
  with a contrastive objective. Requires a framework dependency or a custom
  autodiff implementation.
- **Evaluate the current EMA first:** run a controlled comparison of EMA
  versus cosine-only versus logistic regression on a fixed retrieval
  benchmark before investing in complexity. The design document already
  requires this: "If a learned router does not beat deterministic routing, it
  remains optional."

---

## 4. No explicit privacy deletion

**Symptom:** There is no API or tool to delete a memory and its dependent
artifacts. The design document lists this as P3.

**Concern:** Users will eventually need to remove stored information. A
partial or incorrect deletion can leave orphaned derived memories, dangling
relations, stale embeddings, and misleading search results.

**What must be cleaned up when deleting a `MemoryRecord`:**

| Artifact | Action |
|---|---|
| `memory_records` row | Mark deleted or remove |
| `memory_evidence_links` | Remove rows referencing this memory |
| `memory_derivations` | Decide: cascade-delete derived memories or re-justify them |
| `memory_fts` / `memory_fts_registry` | Remove FTS entry |
| `memory_embeddings` | Remove embedding row |
| `memory_leaf_members` | Remove from leaf blocks; mark blocks dirty |
| `memory_index_delta` | Remove delta entry |
| `retrieval_traces` | Purge references in JSON arrays |
| `topology_proposals` | Purge references in partitioned memory IDs |
| `node_retrieval_signals` / `node_pair_signals` | No direct reference, but counts may become stale |
| Vector caches | Invalidate affected IDs |

**Approaches:**

- **Soft delete first:** add a `deleted` status to `MemoryRecord`; filter it
  out in all queries. This is the safest starting point because nothing is
  physically removed and rollback is trivial.
- **Cascade hard delete:** a transactional stored procedure or method that
  walks the dependency graph and removes every linked artifact. Must respect
  foreign keys and handle `ON DELETE CASCADE` vs manual deletion explicitly.
- **Derived memory policy:** when a source memory is deleted, either
  cascade-delete every derived memory that depends on it, or keep derived
  memories that have enough remaining sources. The second option is more
  useful but harder to implement correctly.

---

## 5. Gate decision relies solely on regex patterns

**Symptom:** `decideMemoryLoad` in `gate.ts` uses hardcoded Chinese and
English regex patterns to decide whether a prompt needs memory retrieval.

**Concern:**

- **Coverage gaps:** there are no patterns for Japanese, Korean, Arabic,
  Hindi, or any of the dozens of other languages that a multilingual model
  may encounter. A user writing in French ("souviens-toi de...") will get
  `mode: "none"` even though they are explicitly asking for recall.
- **Translation attacks:** a prompt that says "Translate the following to
  English and then answer: 我之前说过什么？" bypasses the Chinese patterns
  because the model may translate before the gate sees the Chinese text, or
  the gate only sees the English translation.
- **False negatives from rephrasing:** "tell me what you know about my setup"
  semantically requires memory but matches none of the patterns.
- **False positives:** "remember to format the output as JSON" is a
  present-task instruction, not a memory retrieval request, but may trigger
  the patterns.

**Approaches:**

- **Add a lightweight classifier:** embed the prompt (using the existing
  `HashingVectorEmbedder`) and compare against a small set of labelled
  exemplar embeddings. This captures semantic intent across languages.
- **Expand regex coverage incrementally:** add patterns for the top 5-10
  languages by reported Pi user base, with the understanding that regex
  coverage will always be incomplete.
- **Fallback heuristic:** when the prompt contains a question word and a
  past-time or possessive marker in any language (detected via Unicode
  script), default to `mode: "cue"` rather than `mode: "none"`. A cue is
  cheap and avoids the worst failure mode (missed recall).
- **Model-assisted gate (cost trade-off):** ask the model (with a short
  system prompt and zero temperature) whether this prompt needs long-term
  memory. Adds one extra inference call but removes the regex maintenance
  burden. Only worth it if regex-based false-negative rates are high.

---

## 6. Test coverage gaps

**Symptom:** Chinese gate patterns, graph expansion correctness, and
end-to-end relation traversal are under-tested.

**Specific gaps:**

| Area | Risk | Suggested test |
|---|---|---|
| Chinese gate patterns | A regex typo silently breaks Chinese recall detection | Feed each Chinese pattern a matching and non-matching prompt; assert `mode` |
| Non-English gate | Unknown false-negative rate for unsupported languages | Run gate on a fixed multilingual prompt set and report the mode distribution |
| `searchContext` graph expansion | Related-node results may duplicate, miss, or incorrectly score | Insert two related nodes with known memories; assert result set after `searchContext` |
| `deriveMemory` with missing source | Error handling for deleted/absent source memories | Attempt derivation with a nonexistent source ID; assert error message |
| `mergeNodes` redirect integrity | Redirect chains longer than 1 hop may not resolve correctly | Merge A→B, then B→C; assert `upsertNode("A")` returns C |
| `splitNode` partition validation | Edge cases in the "must assign every memory exactly once" check | Split with overlapping partitions, missing IDs, and extra IDs; assert each is rejected |
| `Float32VectorCache` capacity growth | Geometric growth may allocate more than needed at very small initial capacities | Upsert more items than initial capacity; assert no error and correct scores |

**Approach:** Add these as focused `node:test` cases. They are deterministic
and fast; no model or Pi process needed.

---

## 7. ANN recall is not yet production-quality

**Symptom:** The README reports 87.5% leaf ANN accuracy versus 100% for exact
scan on a 10K near-duplicate workload. The design document states "the current
ANN configuration must not replace exact local scan yet."

**Concern:** 12.5% miss rate on leaf routing is too high for default use.
False negatives cascade: the query never reaches the correct leaf's records.

**Approaches:**

- **Investigate USearch parameters:** the current HNSW `M`, `efConstruction`,
  and `ef` may be suboptimal for the NMG vector distribution.
- **Hybrid exact+ANN:** use ANN as a candidate generator, then re-rank the
  top-K candidates with exact cosine similarity. This preserves recall at the
  cost of a small constant-factor overhead.
- **Per-node ANN:** build one small ANN index per node rather than one global
  index. Local indices have lower dimensionality in practice and higher
  recall at the same parameter settings.
- Defer until exact scan latency actually violates the budget. The design
  document's scale test shows exact node+leaf scan at 10.6 ms P50 for 10K
  items, which is well within typical agent turn budgets.

---

## 8. No concurrency model

**Symptom:** `NmgStore` uses a single `DatabaseSync` handle. There is no
documentation of the expected concurrency model.

**Concern:** Node.js SQLite synchronous API is single-threaded per
connection, which is currently fine. If Pi ever runs multiple concurrent
agent turns or a background maintenance worker, two operations on the same
database handle will serialize or, worse, interleave.

**Approaches:**

- **Document the current model explicitly:** "NMG expects a single-threaded
  access pattern. Multi-turn or multi-agent use must serialize through the Pi
  extension event loop."
- **Read-only replicas for queries:** open a second read-only connection for
  search/get operations while mutations use the primary write connection.
  SQLite WAL supports one writer and many readers concurrently.
- **Async wrapper:** if the Pi harness ever exposes async extension hooks,
  wrap the synchronous `DatabaseSync` in a worker thread with a
  request-response queue. This is a significant architectural change and
  should be deferred until the need is demonstrated.

---

## 9. Pi evidence-source resolution is fragile

**Symptom:** selective evidence admission resolves an accepted
`nmg_remember.evidence` against Pi's current `unknown[]` branch using
type-narrowing casts (`entry as { type?: unknown; message?: unknown }`).

**Concern:** If Pi changes its internal session branch representation the
resolver may fail to bind the exact source message. The durable memory remains
safe because NMG falls back to the supplied evidence excerpt, but loses the
stable Pi message identity and surrounding context.

**Approaches:**

- **Add a JSON schema or TypeBox validator** for the session entry shape that
  the extension depends on. Validate once per session before attempting source
  binding.
- **Version the history-reference format:** record the provider and source
  schema version so future adapters can resolve or migrate references.
- **Expose degraded provenance:** when exact source binding fails, record that
  the evidence is a model-supplied fallback rather than silently presenting it
  as a harness-verified source excerpt.

---

## 10. Topology proposals lack an automated acceptance policy

**Symptom:** The topology proposal system collects co-retrieval and ambiguity
signals, proposes link and split operations, and supports explicit
accept/reject — but only through the Lab tool `nmg_organize`. There is no
background process that auto-accepts high-confidence proposals.

**Concern:** This is by design (the design document says "accepted topology
proposals are an offline/Lab maintenance operation, not an unattended
production mutation policy"). However, as the signal quality improves with
scale, the gap between proposal generation and acceptance will widen.
Hundreds of pending proposals with no review mechanism create clutter and
missed opportunities.

**Approaches:**

- **Auto-accept threshold:** define a minimum observation count (e.g., 50)
  and a minimum gain (e.g., 0.9) above which proposals are auto-accepted.
  Below that, proposals remain pending for human review.
- **Periodic review summary:** add a CLI command (`npx nmg proposals`) that
  prints pending proposals ranked by estimated gain, so a human can batch
  review.
- **A/B apply-and-measure:** apply a proposal in a temporary branch, run the
  last N queries that touched the affected nodes, and compare recall. Accept
  only if recall improves. This is expensive but the safest automation path.

---

## Summary

| # | Area | Severity | Effort |
|---|---|---|---|
| 1 | Store file decomposition | Medium | Medium |
| 2 | Coarse cache invalidation | Low | Low |
| 3 | Router expressiveness | Medium | High |
| 4 | Privacy deletion | High | High |
| 5 | Regex-only gate decision | Medium | Medium |
| 6 | Test coverage gaps | Medium | Medium |
| 7 | ANN recall quality | Low | High |
| 8 | Concurrency model | Low | Low (docs) |
| 9 | Session serialization fragility | Medium | Low |
| 10 | Topology auto-acceptance | Low | Medium |

None of these are blockers for the current prototype stage. Items 1, 4, 5, and
6 are the strongest candidates for P2 attention because they affect
maintainability (1), user trust (4), multilingual correctness (5), and
regression safety (6) — all of which matter before NMG ships as a default Pi
plugin.
