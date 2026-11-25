# Advantage-band chronological pivot and deep-tail store neighbor recall

[简体中文](2026-11-25-advantage-band-chrono-and-deep-tail-recall.zh-CN.md) · [Terms used](2026-11-25-advantage-band-chrono-and-deep-tail-recall.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [unified memory compute engine](2026-11-24-unified-memory-compute-engine.md)

## Problem

Cross-benchmark inspection of multi-hop and state-evolution queries revealed two non-overlapping recall gaps at distinct rank intervals of `DEFAULT_PIECEWISE_RERANK_GRAPH`:

1. **Mid-band (`[6..20]`) temporal state continuity:** Queries on multi-day projects, preferences, or evolving states frequently anchor one step in the top 5 while preceding or succeeding updates sit in ranks `15..40`. Ordering candidates chronologically inside `[6..20]` by group timestamp risks arbitrary ID tie-break noise on single-timestamp sessions (such as single-session batches) and perturbs precision if applied inside the top 5 (`[1..5]`) or deep tail (`[21..100]`).
2. **Deep-tail (`[81..100]`) zero-overlap store neighbors:** Adjacent source turns and `same_state` relational peers with zero lexical or semantic similarity to the initial query fall outside both hybrid candidate admission (`1..80`) and mid-band reranking. Expanding them unconditionally for `limit <= 20` or injecting them before reranking displaces high-precision top candidates.

## Decision

NMG assigns each validated mechanism strictly to the rank band where cross-benchmark ablation establishes strict zero-regression gains:

1. **Distinct-timestamp chronological sequence pivot (`w_chrono_seq_pivot` in `src/core/memory/bm25f-neighborhoods.ts` and `src/core/memory/piecewise-rerank.ts`):** Groups candidates by `stateKey`, fallback `nodeId`, or session key, buckets identical `eventTime ?? createdAt` timestamps together, and ignores groups with fewer than two distinct timestamps (`byMs.size < 2`). For multi-timestamp groups, sorts distinct timestamp steps ascending and boosts neighbors within `+-2` chronological steps of top-5 anchors (`weight: 0.18`). Wired solely inside `MID_DEDUP_RECENCY_SUBGRAPH` (`[6..20]`), leaving head (`[1..5]`) and tail (`[21..100]`) rerank subgraphs unchanged.
2. **Deep-tail (`[81..100]`) store-neighbor supplement (`collectDeepTailNeighbors` in `src/core/memory/search-compute-graph.ts`):** Runs inside `expand_search_neighbors` only when `semantic.mode === "hybrid"`, `!options.evidenceShortlist`, and `limit > 80`. Freezes ranks `1..80`, collects unseen `adjacentSources` and `same_state` `relationalNeighbors` from top-5 anchors, hydrates up to `min(20, limit - 80)` visible records below `results[79].combinedScore`, and preserves primary results above rank 80 and for all `limit <= 80` queries.

## Alternatives considered

1. **Unconditional chronological tie-breaking (without `byMs.size >= 2`):** Rejected because tie-breaking equal-timestamp session batches by record ID caused negative `All@20` / `R@20` regression on single-timestamp LongMemEval queries.
2. **Pre-rerank adjacent-turn injection or global `CombMAX` / 3-way RRF / vector cosine MMR:** Rejected on five-benchmark Pareto ablation (`locomo`, `longmemeval`, `beam`, `personamem`, `halumem`; 2,639 questions, 5,365 golds): global fusion/MMR regressed head or multi-gold recall, whereas band-isolated `[B0 | chrono_distinct | chrono_distinct | B0 | tail_store_adj]` achieved unanimous 5/5 leave-one-dataset-out (LODO) selection with zero per-dataset regression (`R@10 +0.39pp`, `R@20 +0.23pp`, `All@20 +0.46pp`, `R@100 +0.56pp`).
3. **Rule-based tool failure-burst nudges injected into agent context:** Excluded by explicit user direction to avoid extra prompt tokens for failure modes better resolved by base-model improvements.

## Consequences

- Ranks `1..5` precision and all standard `limit <= 80` product queries remain identical when `limit <= 80` and single-timestamp sessions are unaffected.
- Deep-pool callers (`limit > 80`, such as `limit: 100` benchmark/context sweeps) gain adjacent-turn and `same_state` recall in `[81..100]` without disturbing the top 80 ranked items.
