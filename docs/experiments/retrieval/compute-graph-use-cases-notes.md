# Compute Graph Production Use Cases (Rolling Notes)

[简体中文](compute-graph-use-cases-notes.zh-CN.md) · [Terms](compute-graph-use-cases-notes.terms.yaml)

## Purpose and Scope

This rolling note records concrete production use cases of NMG's composable hierarchical compute
graph ([`compute-graph.ts`](../../../src/core/compute-graph.ts)), tracking how three core
primitives—**orthogonal causal band stitching**, **shared-prefix memoization**, and
**multi-objective Pareto selection**—move from offline ablations into runtime defaults. Future
compute-graph recipes and measurements can be appended directly to this document.

## Core Compute Graph Building Blocks

| Component                | Symbol / Owner                                                                                                                                                               | Role in the Retrieval Loop                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orthogonal Band Stitcher | `causal_band_stitch`, `DEFAULT_PIECEWISE_RERANK_GRAPH`, `createPiecewiseRerankGraph` in [`piecewise-rerank.ts`](../../../src/core/memory/piecewise-rerank.ts)                | Partitions ranking depths (`[1..5]`, `[6..20]`, `[21..100]`) into independent branches so head precision, mid diversity, and tail session recall compose additively without rank interference. |
| Shared-Prefix Cache      | `ComputeMemoCache`, `runGraphExperiments`, `runSyncGraphExperiments`, `VALIDATED_GRAPH_CACHE`, `INPUT_SIG_CACHE` in [`compute-graph.ts`](../../../src/core/compute-graph.ts) | Hashes `(op \| params \| subgraph \| upstream signatures)` plus WeakMap topology/input caches so multi-recipe sweeps reuse upstream recall and shared branches without recomputation.          |
| Pareto Auto-Selector     | `findParetoOptimalGraphs`, `replaceGraphNode`, `diffGraphSpecs` in [`compute-graph.ts`](../../../src/core/compute-graph.ts)                                                  | Derives candidate variants via single-node or subgraph swaps, diffs graph topology, and filters dominated variants across accuracy and latency objectives without manual scalar weights.       |

## Case 1: 3-Stage Hierarchical Retrieval and Rerank Ablation (2026-11-23)

- **Setup**: 1,867 frozen queries across LoCoMo (1,532), BEAM (235), and LongMemEval (100),
  evaluating 8 nested pipelines built from `[Recall Node] -> [Rerank Subgraph Node]`, where the
  mid-band operator (`MID_DEDUP_RECENCY_SUBGRAPH`: `r5_recency_boost -> r1_incremental_dedup`) is
  itself a nested subgraph inside `DEFAULT_PIECEWISE_RERANK_GRAPH`.
- **Measured Macro-Average Results**:

| Pipeline                   | Variant via `replaceGraphNode`                   |      All@1 |     All@20 |    All@100 |     MRR@20 | Net W/L@1 | Net W/L@20 | Net W/L@100 |     Cached p50/p95 |
| -------------------------- | ------------------------------------------------ | ---------: | ---------: | ---------: | ---------: | --------: | ---------: | ----------: | -----------------: |
| `A0_2COL_ID`               | 2-col FTS + `identity_rank`                      |     34.69% |     64.18% |     78.36% |     0.5908 |       0/0 |        0/0 |         0/0 |     1.55 / 2.62 ms |
| `G0_3COL_DATES_ID`         | Switch recall to 3-col `dates` FTS               |     35.15% |     64.75% |     78.58% |     0.5957 |      27/6 |       27/1 |        11/1 |     1.50 / 2.59 ms |
| `G1_HEAD_R3_ONLY`          | Only `[1..5]` `r3_intent_boost`                  |     35.22% |     64.75% |     78.58% |     0.5961 |      29/5 |       27/1 |        11/1 |     0.14 / 0.61 ms |
| `G2_MID_R1R5_ONLY`         | Only `[6..20]` `MID_DEDUP_RECENCY_SUBGRAPH`      |     35.15% |     65.04% |     78.58% |     0.5958 |      27/6 |       26/1 |        11/1 |     1.66 / 2.68 ms |
| `G3_TAIL_WS020_ONLY`       | Only `[21..100]` `w_session_pivot(0.20)`         |     35.15% |     64.75% |     78.71% |     0.5957 |      27/6 |       27/1 |        17/1 |     0.16 / 0.20 ms |
| **`G4_DEFAULT_PIECEWISE`** | Full 3-band default (`R3 + R1R5(40) + WS(0.20)`) | **35.22%** | **65.04%** | **78.71%** | **0.5962** |  **29/5** |   **26/1** |    **17/1** | **0.13 / 0.17 ms** |
| `G5_PIECEWISE_WS040`       | Tail weight `0.40`                               |     35.22% |     65.04% |     78.65% |     0.5962 |      29/5 |       26/1 |        21/2 |     0.16 / 0.22 ms |
| `G6_WIDE_MID_WS040`        | Mid `poolSize=80`, `endRank=30`                  |     35.22% |     65.04% |     78.65% |     0.5962 |      29/5 |       26/1 |        21/2 |     3.34 / 5.58 ms |

- **Observed Effects Across the 3 Components**:
  1. **Orthogonal composition**: `G1` lifts `All@1` without hurting `All@20` or `All@100`; `G2` lifts
     `All@20` (`64.75% -> 65.04%`) without hurting `All@1`; `G3` lifts `All@100` (`78.58% -> 78.71%`)
     without perturbing the top 20. Combining all three in `G4_DEFAULT_PIECEWISE` preserves every
     band's peak simultaneously.
  2. **Shared-prefix cache speedup**: Across `85,882` node evaluations (`1,867 x 8` pipelines),
     `ComputeMemoCache` hit `37,341` times (**43.5% hit rate**), cutting total sweep latency from
     **33.16s to 12.70s (2.61x faster)**. Upstream recall and already-evaluated branches stayed warm
     so `G4` evaluated in `p50 = 0.13 ms / p95 = 0.17 ms`.
  3. **Automatic Pareto winner**: Both 3D quality `(All@1, All@20, All@100)` and 4D quality-latency
     `(All@1, All@20, All@100, -p95Ms)` calls to `findParetoOptimalGraphs` retained a single
     frontier recipe: **`G4_DEFAULT_PIECEWISE`** (`DEFAULT_PIECEWISE_RERANK_GRAPH`).

## Case 2: HTTP Multi-Clause Fusion and Tail Assembly Graph (`DEFAULT_HTTP_SEARCH_GRAPH`)

- [`http-search-graph.ts`](../../../src/integration/http-search-graph.ts) encodes multi-clause HTTP
  retrieval fusion (`fuse_clause_hits -> select_supplemental_tail -> stitch_http_page`) as a
  swappable `ComputeGraphSpec` injected into [`HttpMemoryService`](../../../src/integration/memory-http-service.ts)
  via `options.searchGraph`.
- Node-less HTTP imports now omit synthetic `AML session` nodes and populate `sourceSessionId`,
  while `w_session_pivot` clusters candidates via `sessionId -> sourceSessionId -> aml_session ->
nodeId -> evidenceId -> id` before `stitch_http_page` caps tail context scores monotonically.

## Case 3: 5-Layer Relational Projection, Context-Safe Caching & BM25F + Temporal Neighborhood Promotion (2026-11-23)

- **Architecture & Caching Hardening**:
  - Replaced single-table JSON `payload` dependencies in pivot projection with a 5-layer relational SQLite schema (`nmg_sources`, `nmg_memories`, `nmg_memory_evidence`, `nmg_memory_relations`, `nmg_memory_markers` in [`sqlite-relational.ts`](../../../src/core/memory/sqlite-relational.ts)), adding `time`, `evidence`, and `actor` pivot dimensions plus implicit/explicit `semantic` edges (`memory_relation`, `supersedes`, `related_to`, `contradicts`, `shared_concept`) and node-free `engine.linkMemories`.
  - Fixed `ComputeMemoCache` ([`compute-graph.ts`](../../../src/core/compute-graph.ts)) to fold execution `context` signatures (including function properties via source hash and cached array references) and `ComputeRegistry` per-operator registration fingerprints into node cache keys.
- **2,000-Row Relational Projection Benchmark** (800-row legacy JSON vs 5-layer SQLite):
  - **Ingest (2,000 rows, batch=100)**: `906.84 ms` (`2,205 rows/s`) with atomic synchronization into all 5 relational tables plus dual FTS5.
  - **Filtered + Paginated Pivot Query (`eventTimeFrom..To` + `sourceActor` + `memoryType`, `limit=200`, 200 matches)**: **`5.43 ms` p50 (`5.49 ms` avg)** via `nmg_memories_by_filter` vs **`8.62 ms` p50 (`8.77 ms` avg)** for full-table `JSON.parse(payload)` scan (**1.60x faster** even at 2,000 rows, scaling $O(\text{limit})$ instead of $O(N)$ with zero `JSON.parse(payload)` calls).
- **1,867-Query Compute-Graph Experiment (`bm25f_field_score` & New Neighborhood Operators)**:
  - Evaluated 11 compute-graph recipes derived via `replaceGraphNode` from `G4_DEFAULT_BASE` across LoCoMo (1,532), BEAM (235), and LongMemEval (100) using `RERANK_COMPUTE_REGISTRY` in [`bm25f-neighborhoods.ts`](../../../src/core/memory/bm25f-neighborhoods.ts) and [`piecewise-rerank.ts`](../../../src/core/memory/piecewise-rerank.ts):

| Recipe (`Pipeline`)        | Graph Delta (`replaceGraphNode`)                                            |      All@1 |     All@20 |    All@100 |     MRR@20 | Net W/L@1 | Net W/L@20 | Net W/L@100 |
| -------------------------- | --------------------------------------------------------------------------- | ---------: | ---------: | ---------: | ---------: | --------: | ---------: | ----------: |
| `G4_DEFAULT_BASE`          | Baseline (`R3 + R1R5 + w_session(0.20)`)                                    |     35.22% |     65.32% |     78.71% |     0.5957 |       0/0 |        0/0 |         0/0 |
| `B1_BM25F_ONLY`            | Head -> `bm25f_field_score(0.12)`                                           |     35.27% |     65.32% |     78.71% |     0.5974 |       5/8 |        0/0 |         0/0 |
| `B2_HEAD_BM25F_R3`         | Head -> `bm25f(0.10) -> r3(0.12)`                                           |     35.36% |     65.32% |     78.71% |     0.5980 |       5/4 |        0/0 |         0/0 |
| `B3_HEAD_BM25F_R3_18`      | Head -> `bm25f(0.18) -> r3(0.12)`                                           |     35.36% |     65.32% |     78.71% | **0.5993** |       8/7 |        0/0 |         0/0 |
| `N1_TAIL_TEMPORAL`         | Tail -> `w_session(0.20) -> w_temporal_pivot(0.10)`                         |     35.22% |     65.32% |     78.75% |     0.5957 |       0/0 |        0/0 |         2/0 |
| `N2_TAIL_CONCEPT`          | Tail -> `w_session(0.20) -> w_concept_pivot(0.10)`                          |     35.22% |     65.32% |     78.57% |     0.5957 |       0/0 |        0/0 |         1/2 |
| `N3_TAIL_LINEAGE`          | Tail -> `w_session(0.20) -> w_lineage_pivot(0.14)`                          |     35.22% |     65.32% |     78.71% |     0.5957 |       0/0 |        0/0 |         0/0 |
| **`J1_BM25F_R3_TEMPORAL`** | **Head `bm25f(0.10)->r3(0.12)` + Mid + Tail `w_session->w_temporal(0.10)`** | **35.36%** | **65.32%** | **78.75%** | **0.5980** |   **5/4** |    **0/0** |     **2/0** |

- **Cache & Pareto Verdict**:
  - Across `110,153` node evaluations in the 11-arm sweep (`54.53 s`), `ComputeMemoCache` achieved **`52,276` hits (47.5% hit rate)**.
  - `findParetoOptimalGraphs` on `(All@1, All@20, All@100, MRR@20)` selected `['B3_HEAD_BM25F_R3_18', 'J1_BM25F_R3_TEMPORAL']`.
  - **`J1_BM25F_R3_TEMPORAL`** strictly dominates `G4_DEFAULT_BASE` on `All@1` (`+0.14%`), `All@50` (`71.90% -> 72.18%`), `All@100` (`2W/0L`), and `MRR@20` (`+0.0023`) with zero regressions, and is promoted to **`DEFAULT_PIECEWISE_RERANK_GRAPH`** (`HEAD_BM25F_R3_SUBGRAPH` + `MID_DEDUP_RECENCY_SUBGRAPH` + `TAIL_SESSION_TEMPORAL_SUBGRAPH`). Meanwhile `w_concept_pivot` (`1W/2L` at `@100`) remains registered as an opt-in experimental operator rather than a default.

## Case 4: Turn-Adjacency Operator (`w_turn_pivot`) & PersonaMem / HaluMem Evaluation (2026-11-23)

Evaluated all **2,719 queries across 5 frozen benchmarks** (`LoCoMo` 1,532 + `BEAM` 235 + `LongMemEval` 100 + `PersonaMem` 500 + `HaluMem` 352 [272 labeled / 496 golds]) to test turn-adjacency neighborhood ranking (`w_turn_pivot` in [`bm25f-neighborhoods.ts`](../../../src/core/memory/bm25f-neighborhoods.ts)) and PersonaMem context tuning (`forget` marker admission + preference `recall_trigger` indexing).

- **Graph Delta (`replaceGraphNode`)**:
  - Added `turnOrdinal?: number | null` on `RerankCandidate` (populated in production from `nmg_sources.ordinal` via `readSourceTurnMetadata` in [`sqlite-relational.ts`](../../../src/core/memory/sqlite-relational.ts) -> `SqliteMemoryBackend.hybridCandidates` -> [`engine.ts`](../../../src/core/memory/engine.ts)).
  - Chained `w_turn_pivot` (`maxRadius: 1`, `±1` adjacent dialogue turn within the same session) in **Mid** (`weight: 0.55, anchorTopK: 5`) and **Tail** (`weight: 0.35, anchorTopK: 6`), leaving the `Head` (`[1..5]`) untouched.
- **5-Benchmark Offline Comparison (`J1_CURRENT_DEFAULT` vs Promoted `W_055_035_R1`)**:

| Benchmark (Queries / Mode)                    | Graph Variant      |    R@1 |    R@5 |       R@10 |       R@20 |  All@1 |     All@20 |
| --------------------------------------------- | ------------------ | -----: | -----: | ---------: | ---------: | -----: | ---------: |
| LoCoMo (1,532)                                | `J1_DEFAULT`       | 25.47% | 48.25% |     56.77% |     66.27% | 31.14% |     69.45% |
| LoCoMo (1,532)                                | **`W_055_035_R1`** | 25.47% | 48.25% | **57.84%** | **67.50%** | 31.14% | **71.41%** |
| BEAM (235)                                    | `J1_DEFAULT`       |  6.48% | 15.73% |     23.89% |     33.13% |  8.94% |     28.51% |
| BEAM (235)                                    | **`W_055_035_R1`** |  6.48% | 15.73% | **24.49%** | **34.21%** |  8.94% | **30.21%** |
| LongMemEval (100)                             | `J1_DEFAULT`       | 55.29% | 86.47% |     94.71% |     97.65% | 66.00% |     98.00% |
| LongMemEval (100)                             | **`W_055_035_R1`** | 55.29% | 86.47% |     94.71% |     97.65% | 66.00% |     98.00% |
| HaluMem (352 / 272 labeled, no tail splice)   | `J1_DEFAULT`       | 27.22% | 59.27% |     70.97% |     78.43% |      - |     72.79% |
| HaluMem (352 / 272 labeled, no tail splice)   | **`W_055_035_R1`** | 27.22% | 59.27% | **71.98%** | **79.84%** |      - | **74.63%** |
| HaluMem (+ Tail Splice 2 `adjacentSources`)   | **`W_055_035_R1`** | 27.22% | 59.27% | **71.98%** | **81.05%** |      - | **76.47%** |
| PersonaMem (500, `forget` hidden, no splice)  | `J1_DEFAULT`       |  6.26% | 21.87% |     30.04% |     38.01% |      - |     11.00% |
| PersonaMem (500, `forget` hidden, no splice)  | **`W_055_035_R1`** |  6.26% | 21.87% | **30.76%** | **38.54%** |      - | **12.20%** |
| PersonaMem (+ Tail Splice 2, `forget` hidden) | **`W_055_035_R1`** |  6.26% | 21.87% | **30.76%** | **39.13%** |      - | **14.40%** |

- **PersonaMem Context-Tuning Analysis (`forget` Tag & Preference `recall_trigger`s)**:
  - **Privacy vs Revocation Recall (`ask_to_forget`, 100/500 questions)**: Pre-ingested PersonaMem stores mark explicit user forget requests with `markers: [{ kind: "forget" }]` (`97` gold snippet labels hidden by `visibleMemory` / `searchableMemory`). Admitting only the paraphrased constraint `statement` does not match verbatim `history.content` golds (`R@20 = 38.21%`), whereas combining **`forget` context admission + preference `recall_trigger` markers (`WmTqKO`) + `W_055_035_R1` (`w_turn_pivot`) + Tail Splice 2** boosts PersonaMem-500 overall metrics to **`R@1 = 6.59%`, `R@5 = 23.52%`, `R@10 = 34.39%`, `R@20 = 43.68%` (`+5.67%`), `All@20 = 27.00%` (`+16.00%`)**, driven by `ask_to_forget` rising from `68.11%` to **`84.69%+`** (pairing the user's revocation turn with the assistant's acknowledgment turn via `w_turn_pivot`).
- **Pareto & Promotion Verdict**:
  - `W_055_035_R1` strictly dominates `J1_CURRENT_DEFAULT` across all 5 benchmarks (zero regressions on any cutoff; LongMemEval exact parity at `97.65% R@20` / `98.00% All@20`), and is promoted to **`DEFAULT_PIECEWISE_RERANK_GRAPH`** (`MID_DEDUP_RECENCY_SUBGRAPH` + `TAIL_SESSION_TEMPORAL_SUBGRAPH`).

### Live End-to-End HTTP + LLM Evaluation (`auto/deepseek-v4-flash`, Concurrency 8, Thinking Off)

Verified the updated HTTP service (`local-memory-http.ts` wired with `createEmbeddingClientFromEnv()`, `nmg_sources` ordinal metadata, head `r5_recency_boost(0.02)`, and future-`eventTime` `defaultValidFrom` visibility fix in `model.ts`) end-to-end against `BAAI/bge-small-en-v1.5` + `http://127.0.0.1:3425/v1` (`auto/deepseek-v4-flash`, `thinking: { type: "disabled" }`, concurrency 8):

- **Suite 1 — Interleaved `ADD -> Search -> ADD (Update) -> Search` State Chain**: **`10/10 (100.0%)`** across variable overrides (`A: 1 -> 2 -> 3`), city relocations (`Austin -> Seattle -> Tokyo`), DB migration (`SQLite -> PostgreSQL`), and gateway port changes (`8080 -> 9443`). Running this live test exposed and fixed a visibility bug in `timeFields` ([`model.ts`](../../../src/core/memory/model.ts)) where future `eventTime` values (`> now`) had `validFrom > now` and were hidden by `visibleMemory`.
- **Suite 2 — HaluMem User 1 Live HTTP End-to-End (67 sessions, 164 questions, OmniMemEval prompts & judge)**:
  - **Batch (`ADD all -> Search all`, `240` char preview / `5,500` budget)**: **`139/164 = 84.76%`** (`+3.66 pp` over historical `trial17` `81.10%`; avg `255.2 ms` search, `1,924` prompt tokens).
  - **Interleaved (`ADD session -> Search session -> ADD next`, `240` char preview / `5,500` budget)**: **`146/164 = 89.02%`** (`+7.92 pp` over `trial17`; `189.7 ms` avg search, `1,912` prompt tokens): `Memory Boundary` `97.44%`, `Basic Fact Recall` `82.50%`, `Memory Conflict` `92.31%`, `Generalization & Application` `90.32%`, `Multi-hop Inference` `88.89%`, `Dynamic Update` `50.00%` (remaining `s52-q3` `23,000` salary detail was retrieved at rank 2 `[B]` but fell after `240`-char excerpt truncation).
  - **Controlled A/B — Compact (`240 / 5,500`) vs Unclipped (`searchPreviewCodePoints: 0`, `searchMaxCharacters: 32000`, `NMG_EMBED_CHUNK_CONCURRENCY=1`, `hybrid: 164/164`, `0` proxy errors)**: Compact scored **`147/164 = 89.63%`** (`avgItems=18.1`, `123` queries clipped below 20 items, `avgTokens=1,800`) vs Unclipped **`146/164 = 89.02%`** (`avgItems=19.9`, `avgTokens=2,383`, 4 vs 3 single-question flips; unclipping recovered truncated details like `s2-q2` pets `"dogs, cats, and parrots"`). An earlier cold run that scored `75.00%` (`123/164`) was traced to `ECONNRESET` against the single-threaded local `bge_server.py` under default `chunkConcurrency=4`, which caused `backfillVectors()` to swallow HTTP 500 errors and silently degrade part of the run to lexical-only retrieval.
- **Suite 3 — PersonaMem v2 Live HTTP Sample (5 personas, 129 multiple-choice questions)**:
  - **Baseline (`240` char preview, raw HTTP `/add`)**: **`32/129 = 24.81%`** (`ask_to_forget = 28.00%`, `therapy_background = 29.41%`, `neutral_preferences = 29.63%`, `health_and_medical_conditions = 29.41%`, `sensitive_info = 25.00%`).
  - **With HTTP Write Preprocessor + Unclipped Config (`preprocessMessages: true`, `searchPreviewCodePoints: 0`, `searchMaxCharacters: 32000`, producing `recall_trigger=221`, `forget_directive=85`)**: **`61/129 = 47.29%` (`+22.48 pp`)**, with `ask_to_forget` rising `28.00% -> 56.00%`, `therapy_background` `29.41% -> 58.82%`, `health_and_medical_conditions` `29.41% -> 58.82%`, `anti_stereotypical_pref` `12.50% -> 33.33%`, and `sensitive_info` `25.00% -> 50.00%`.

## Template for Future Cases

When adding a new compute-graph experiment or production operator to this document, append a
dated section using the structure below:

```markdown
## Case N: <Short Experiment or Operator Name> (<YYYY-MM-DD>)

- **Graph Delta (`replaceGraphNode` / `diffGraphSpecs`)**: Which operator, subgraph, or band
  boundary changed relative to the active baseline.
- **Metrics & Cache Effect**: Quality metrics (`All@1`, `All@20`, `All@100`, `MRR`), `ComputeMemoCache`
  hit rate / speedup, and runtime `p50/p95`.
- **Pareto & Promotion Verdict**: Output of `findParetoOptimalGraphs` and whether the recipe is
  promoted to a default `ComputeGraphSpec`.
```
