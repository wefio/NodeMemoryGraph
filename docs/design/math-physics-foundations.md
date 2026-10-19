# Mathematical Foundations: Algorithms, Analogies, and Proposals

[English](math-physics-foundations.md) | [简体中文](math-physics-foundations.zh-CN.md) · [Terms](math-physics-foundations.terms.yaml)

Historical design survey, created 2026-07-20. Its original “current” inventory and implementation gaps are not a live status register. The items below distinguish algorithms, mathematical analogies, empirical evidence, and proposals; none of the proposed analyses is an adopted product contract here.

## What the survey was trying to distinguish

The original note warned against using mathematical language as post-hoc justification. It grouped examples into:

- **Explicit algorithms or measures:** Huffman-style depth assignment, cosine similarity, and SQLite FTS5's BM25 ranking were identified as concrete mathematical components.
- **Design vocabulary, not an implemented objective:** rate-distortion language was discussed as an architectural analogy, not a computed loss or measured rate/distortion function.
- **Engineering heuristics:** examples included hand-weighted retrieval signals, EMA routing, regex gates, and staged disclosure. Calling these mathematically inspired does not give them a proof or calibrated error rate.

A mathematical result has to be applied to the quantity and assumptions it actually covers. For example, the Huffman expected-code-length bound does not, by itself, prove end-to-end retrieval or answer-quality optimality when weights are heuristic and code depths are mapped into bounded tiers.

## Proposals recorded in the historical note

| Proposal | Intended question | Evidence needed before adoption |
|---|---|---|
| Fit retrieval fusion weights from labeled traces | Can lexical, vector, route, or tier signals predict useful memories? | Leakage-safe labels, held-out evaluation, calibration, and a comparison with fixed weights |
| Replace or augment EMA routing with a rule having a mistake bound | Do the assumptions for a perceptron-style guarantee hold for NMG's inputs and updates? | Explicit loss/labels, verified separability or other stated assumptions, and measured behavior |
| Use Personalized PageRank for graph expansion | Does restart-based weighted traversal improve useful recall over bounded BFS? | A controlled retrieval benchmark and compute/context cost measurements |
| Use spectral clustering as a split suggestion | Does a partition metric improve candidate quality without granting automatic split authority? | Resource-matched data, stability checks, and human/judge review |
| Derive retrieval or block-size guarantees | Are distribution assumptions realistic, and does the bound predict observed outcomes? | Explicit assumptions plus empirical comparison; otherwise use benchmark evidence rather than claim a guarantee |

These are research directions, not accepted designs. In particular, a theoretical bound under assumptions is not evidence that those assumptions hold for natural-language memories.

## Current owners and evidence

Use [Hierarchical activation](hierarchical-activation.md), [retrieval confidence controller](retrieval-confidence-controller.md), [current chain design](temporal-logical-chains-design-2026-08-13.md), and the source modules under [`src/core/`](../../src/core/) for current implementation contracts. Use the relevant experiment records for measured performance. The historical proposal table does not supersede those owners or imply that a proposal has been implemented, benchmarked, or selected.

The governing distinction is: **formal guarantee** (under stated assumptions), **empirical result** (for a measured path and sample), **heuristic** (a rule without such a guarantee), and **analogy** (explanatory vocabulary only).