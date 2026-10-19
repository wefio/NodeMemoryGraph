# Co-retrieval = 关联规则挖掘 / Hebbian 学习

[English](co-retrieval-and-hebbian-learning.md) · [使用的术语](co-retrieval-and-hebbian-learning.terms.yaml)

**Authority:** [父级范围](../structural-analogies.zh-CN.md).

## Co-retrieval = 关联规则挖掘 / Hebbian 学习

**当前实现**：`src/core/store/maintenance.ts` — `recordRetrievalTrace`；`src/core/store/graph.ts` — `proposeTopologyChanges`；`node_pair_signals` 表。

**结构**：

```
NMG                              Market Basket Analysis
────────────────────────────────────────────────────────────
每个 query = 一次"购物"           每笔交易 = 一次购物
检索到的 node 集合 = "购物篮"     购买的商品 = 购物篮
co_retrieval_count =              co-occurrence count =
  同时检索 A 和 B 的次数            同时购买 A 和 B 的交易数
useful_count = A 和 B 都被标记     （无直接对应，但可用于过滤）
  为有用的次数
────────────────────────────────────────────────────────────
support(A,B) = co_retrieval_count / total_queries
confidence(A→B) = useful_count(A,B) / query_count(A)
```

**相似点**：
- 计数逻辑与 Apriori 算法的第一步完全一致
- `node_pair_signals` 就是关联规则挖掘的 2-itemset 频率表
- proposal 生成时的 minObservations 阈值 = minimum support

**差异**：
- 不做 upward closure pruning（没有 >2 项的 itemset）
- 没有 lift / conviction 等更高级的 interestingness measure
- useful_count 作为质量过滤（比纯 support 多一层筛选）

**与 Hebbian 学习的相似**：
> "Neurons that fire together, wire together."

- node = neuron
- co-retrieval = co-activation
- link proposal = synaptic strengthening proposal
- observation threshold = LTP (long-term potentiation) 需要重复刺激

**设计启发**：
关联规则挖掘有标准的 interestingness 度量（lift、conviction、Jaccard），
可以用来替代当前的 estimatedGain = useful_count / max(queries)，
这些度量对 popularity bias 有更好的校正。

---
