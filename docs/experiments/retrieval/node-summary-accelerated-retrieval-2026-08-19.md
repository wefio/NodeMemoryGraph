# Node-Summary Routing for Accelerated Retrieval (2026-08-19)

[English](node-summary-accelerated-retrieval-2026-08-19.md) | [简体中文](node-summary-accelerated-retrieval-2026-08-19.zh-CN.md) · [Terms](node-summary-accelerated-retrieval-2026-08-19.terms.yaml)

**Status:** Historical design exploration, not an implementation or performance report. Its external-literature notes were not independently rechecked here. Current QPP behavior and retrieval contracts belong to the owners linked below.

## Problem and alternatives

The 2026-08 note considered whether node-level semantic summaries could reduce the cost of generating and ranking candidates when a store grows large. It compared three strategies:

| Strategy | Search behavior | Main trade-off |
|---|---|---|
| **A. Pruning** | Use summary/route signals to select nodes, then search only within those nodes | Smaller pool and potential long-term savings, but may miss evidence if summaries are incomplete or stale |
| **B. Progressive ordering** | Search promising node-local candidates first; if insufficient, fall back to the unchanged full pool | Potential early-stop speedup with a full-pool fallback; no recall-loss guarantee was measured in this note |
| **C. Cascade** | Start progressively, then adapt how much of the pool to search based on confidence or budget | Combines early stopping with selective pruning, but requires calibrated decisions and more complexity |

The note first recommended C, then recorded a user decision to **separate the mechanisms rather than directly blend scores**: per-query progression uses immediate summary/lexical signals; learned routing is reserved for gradual, long-term pool pruning. A full-pool fallback was proposed as the final recall safeguard. This is a historical design decision, not proof that either mechanism is currently wired this way.

## Safety conditions proposed for learned pruning

The note identified a cold-start failure: an untrained node with zero weights could receive a zero score and be pruned everywhere. Its proposed guard required all of the following before pruning a node:

- enough training examples (`examples ≥ N`);
- a clearly low route score (`score < θ`); and
- evidence that the query is in-distribution, using lexical overlap with that node's historical queries.

Otherwise, do not prune; rely on the summary route and full-pool fallback. It also warned against training on exposure-biased routing alone. A proposed positive training example required summary match, actual retrieval, and explicit use (`usedNodeIds`); routing diagnostics should be stored separately from the training labels.

## Proposed trace signals and evaluation

The proposed instrumentation had two levels: per-query `(query, node, routed, recalled, used)` traces for diagnosis/retraining, and per-node routed/recalled aggregates for quick monitoring. The note cautioned that “routed” can create exposure bias and should not itself be treated as a relevance label.

Before implementation, the proposed large-data check was LongMemEval 500 questions or a large LoCoMo store. Measure first-round sufficiency/early-stop rate, full-pool versus node-local pool size and latency, speedup, and recall loss against gold evidence. The proposal required zero recall loss before enabling a default progressive route; pruning was to remain optional until its error was controlled. No such benchmark result is reported in this design note.

## Current owners and boundary

- [Fibonacci progressive recall](../../design/fibonacci-progressive-recall.md)
- [Retrieval confidence controller](../../design/retrieval-confidence-controller.md)
- [QPP implementation](../../../src/core/qpp.ts)
- [Store retrieval and ranking](../../../src/core/store/retrieval.ts) and [`search-ranking.ts`](../../../src/core/store/search-ranking.ts)

The current QPP path is not evidence that the proposed node-summary candidate-pruning system exists. Consult these owners for current defaults and bounds. The historical paper list and numerical performance claims from external systems are omitted from this compact record; verify sources before citing or adopting them.