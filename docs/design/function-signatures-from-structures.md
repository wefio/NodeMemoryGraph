# Function Signatures from Structural Analogies

[English](function-signatures-from-structures.md) | [简体中文](function-signatures-from-structures.zh-CN.md) · [Terms](function-signatures-from-structures.terms.yaml)

Historical design brainstorm, created 2026-07-20. The analogy list below is a way to generate questions and candidate interfaces; it is not a product requirement, a current API catalog, or proof that NMG shares the guarantees of another field.

The original note's premise was that recognizing a familiar structure can provide a useful vocabulary for discussing inputs, outputs, and boundary conditions. Its examples were proposals, not code contracts. Current implementation and behavior must be checked in their owning source and design documents.

## Analogy catalogue

| NMG area considered | Structural analogy | Question the analogy suggested | Boundary |
|---|---|---|---|
| Index deltas and rebuilds | LSM trees | Is there an observable backlog or backpressure signal? | Does not establish that a full LSM compaction model is required |
| Node redirects and merge/split | Union-Find | Would path compression help, and how should split ambiguity be represented? | Union-Find does not naturally model reversible split operations |
| State supersession | MVCC | Which historical reads or diffs are useful? | Similarity to versioning does not imply full MVCC semantics |
| Co-retrieval signals | Association-rule mining | Would support, confidence, or lift separate real association from popularity? | A candidate measure is not a validated relevance signal |
| Multi-channel retrieval | Ensemble methods | Should channel weights be learned or reliability be exposed? | The analogy does not establish a useful learned fusion policy |
| Node identity and partition changes | Equivalence classes / clustering | What evidence should trigger split, merge, or refinement? | A clustering metric is not an automatic merge/split authority |
| Vector caching | CPU cache hierarchy | Which operations need load, eviction, invalidation, or hit-rate metrics? | Scale and cache policy require workload evidence |
| Write policy | IDS/rule engines | Should rules be configurable and explainable? | This does not authorize a second hidden write judge |
| Graph expansion | Diffusion processes | Would probabilistic propagation or decay improve bounded traversal? | This is a proposal, not current retrieval behavior |

## Current owners

The current, separately reviewed analogy documents are [Structural analogies](structural-analogies.md), [State supersession and MVCC](structural-analogies/state-supersession-and-mvcc.md), [Co-retrieval and Hebbian learning](structural-analogies/co-retrieval-and-hebbian-learning.md), and [Multi-channel retrieval and ensemble stacking](structural-analogies/multi-channel-retrieval-and-ensemble-stacking.md). They explicitly distinguish explanatory comparison from product requirements and implementation evidence.

For current code, consult the relevant modules under [`src/core/store/`](../../src/core/store/) and the [implementation-lineage index](implementation-lineage.md). This historical catalogue does not assert that the original “already has” or “missing” lists are still accurate.