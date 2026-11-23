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
