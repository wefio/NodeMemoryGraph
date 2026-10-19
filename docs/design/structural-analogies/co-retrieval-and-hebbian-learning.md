# Co-retrieval = association-rule mining / Hebbian learning

[简体中文](co-retrieval-and-hebbian-learning.zh-CN.md) · [Terms used](co-retrieval-and-hebbian-learning.terms.yaml)

**Authority:** [Parent scope](../structural-analogies.md).

## Co-retrieval = association-rule mining / Hebbian learning

**Current implementation:** `src/core/store/maintenance.ts` — `recordRetrievalTrace`; `src/core/store/graph.ts` — `proposeTopologyChanges`; `node_pair_signals` table.

**Structure:**

```
NMG                              Market Basket Analysis
────────────────────────────────────────────────────────────
each query = one “shopping trip”  each transaction = one shopping trip
retrieved node set = “basket”     purchased items = basket
co_retrieval_count =              co-occurrence count =
  times A and B are retrieved       transactions that buy A and B together
useful_count = times both A and B  (no direct equivalent; can filter)
  are marked useful
────────────────────────────────────────────────────────────
support(A,B) = co_retrieval_count / total_queries
confidence(A→B) = useful_count(A,B) / query_count(A)
```

**Similarities:**
- The counting logic is exactly the first step of the Apriori algorithm.
- `node_pair_signals` is a frequency table for 2-itemsets in association-rule mining.
- The `minObservations` threshold during proposal generation corresponds to minimum support.

**Differences:**
- There is no upward-closure pruning (no itemsets larger than size 2).
- There are no more advanced interestingness measures such as lift or conviction.
- `useful_count` provides a quality filter beyond pure support.

**Similarity to Hebbian learning:**
> “Neurons that fire together, wire together.”

- node = neuron
- co-retrieval = co-activation
- link proposal = synaptic-strengthening proposal
- observation threshold = LTP (long-term potentiation) requiring repeated stimulation

**Design implication:** Association-rule mining has standard interestingness measures (lift, conviction, Jaccard) that could replace the current `estimatedGain = useful_count / max(queries)`; these measures could correct popularity bias better.
