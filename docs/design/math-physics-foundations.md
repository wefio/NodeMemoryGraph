# NMG 数学与物理基础：当前状态与可补之处

**Status:** 诚实评估 / honest assessment
**Created:** 2026-07-20

上一版文档犯了常见错误：用理论反向解释设计，暗示"因为数学上正确所以设计合理"。
实际上 NMG 目前只有极少数组件是**从数学出发构建的**，其余是工程直觉。

本文档诚实区分三类状态：
- **已有**：代码里确实在算这个，有显式的数学结构
- **可补**：此处可以放一个数学框架，放了之后能给出设计判据或可证明的界，目前没有
- **不必补**：工程直觉够用，加数学只是装饰

---

## 1. 真正已有的数学

### 1.1 Huffman 编码 — hierarchy.ts

**代码证据：**

```typescript
// hierarchy.ts — 这是真正在算 Huffman 树
export function huffmanDepths(items: WeightedMemory[]): Map<string, number> {
  // while queue.length > 1: pop 两个最小权重, merge, depth+1
}

export function blockTiers(
  depths: Map<string, number>,
  capacities: readonly [number, number, number],
): Map<string, MemoryTier> {
  // 按 depth 排序，前 C0 条 → tier 0, 接下来 C1 条 → tier 1, …
}
```

**为什么说它是"从数学出发"**：这不是用数学解释已有设计，而是已有的设计
就是在做 Huffman 编码。输入带权重的 memories，输出每个 memory 的码字深度，
再按容量边界离散化。这是整个 codebase 里唯一显式实现了某个定理的算法。

**给出了什么**：给定 access probability 分布，Huffman 树保证期望查询深度
E[L] ∈ [H(p), H(p)+1)，其中 H(p) 是熵。这意味着如果 probability 估计准确，
tier 系统在信息论意义上是最优的。

**盲区**：`hierarchyWeight` 如何从 `{importance, access_count, pending_access_count}`
映射到概率权重——这一步没有理论依据，是启发式。

---

### 1.2 Cosine similarity — vector.ts

**代码证据：**

```typescript
export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  // 标准内积 / (norm * norm)
}
```

这是内积空间的标准操作。用于向量检索和 embedding 比较。本身不深奥，但它是
检索排序的核心度量。

**注意**：有 cosine similarity 不代表有"向量空间检索理论"。NMG 没有
Rocchio relevance feedback、没有 formal vector space model scoring、
没有推导过为什么 cosine（而不是点积、欧氏距离、Jaccard）。

---

### 1.3 BM25 — SQLite FTS5（非 NMG 实现）

FTS5 使用了 BM25 排序。BM25 来自概率信息检索理论（Robertson & Spärck Jones, 1976）。
但这不是 NMG 实现的，是 SQLite 带来的。NMG 只是用了 `ORDER BY bm25(memory_fts)`。

---

### 1.4 率失真框架 — design.md §8（设计语言，非代码）

design.md §8 用了信息论的词汇来描述系统架构。但这停留在**设计文档层面**，
没有进入代码：
- 没有 rate-distortion 函数被计算
- 没有 distortion measure 被量化
- progressive disclosure 各阶段的信息量没有被度量
- 没有拉格朗日乘子来平衡 rate 和 distortion

它是一套描述系统目标的语言，不是驱动工程决策的数学。

---

## 2. 看起来有数学、其实没有的

以下组件常被误认为有数学基础，但实际上只是工程实践：

| 组件 | 看起来像 | 实际情况 |
|---|---|---|
| HashingVectorEmbedder | Johnson-Lindenstrauss 随机投影 | FNV-1a 哈希 + n-gram feature extraction，没有任何 J-L guarantee。维度 256 是拍脑袋的，不是由 ε, δ, N 推导出来的 |
| OnlineNodeRouter | 在线凸优化 / 梯度下降 | 就是 EMA w ← (1-η)w + η·x。没有 regret analysis，没有 convergence proof，没有损失函数定义 |
| Gate regex patterns | 假设检验 / 分类器 | 就是正则匹配。没有 sensitivity/specificity 分析，没有 ROC，没有 error rate modeling |
| Multi-channel retrieval | 信道编码 / 冗余 | 三个信号加权求和。没有学过信道独立性，没有学过最优融合权重，没有纠错码结构 |
| Progressive disclosure | Successive refinement | 分阶段加载是好的 UX 设计。没有证明每阶段是最优的，没有量化过信息增量 |
| Write policy regex | 形式语言 / 安全性质 | 就是禁止模式黑名单。没有形式化过 safety property，不是 finite-state monitor |

---

## 3. 可以真正补上去的数学

以下是**目前没有、但放了之后能提供设计判据或可证明界**的地方。

### 3.1 检索混合权重的贝叶斯推导

**当前状态**：`hybridScore(lexical, vector, route)` 的权重是硬编码的，
`combinedScore = lexical * 0.7 + route * 0.3` 等。没有原则性方法选择这些权重。

**可补**：如果有 labeled retrieval traces（哪些检索到的 memory 最终被用上了），
可以直接 fit 一个 logistic regression：
```
log P(useful | memory, query) = β₀ + β₁·lexicalScore + β₂·vectorScore + β₃·routeScore + β₄·tier
```
模型的系数就是最优权重。还可以加 interaction term 检测信道是否独立。

**投入产出**：低投入（已有 retrieval traces 的 usefulMemoryIds 字段），
直接产出可解释的融合权重。

### 3.2 Router 的 regret bound

**当前状态**：EMA 更新没有性能保证。

**可补**：换成 Passive-Aggressive (PA) 或 Perceptron 更新，可以获得 mistake bound：

> 如果数据是线性可分的（margin ≥ γ），Perceptron 的 mistakes ≤ (R/γ)²，
> 其中 R = max‖x_t‖。

这意味着可以**证明**：给定足够分离的 node embedding，router 在有限步内收敛。
而 EMA 做不到这个 guarantee。

PA 更新规则（仅比 EMA 多一个条件）：
```
if margin < 1:  w ← w + η·(1 - margin)·x_t / ‖x_t‖²
```

**投入产出**：中投入。需要修改 router update 并收集 negative examples
（retrieved but not useful）。产出是可证明的 mistake bound。

### 3.3 Graph expansion 改用 Personalized PageRank

**当前状态**：BFS 展开固定 hop 数，所有邻居等权，不做衰减。

**可补**：Personalized PageRank (PPR) 从 query-matched nodes 出发做带重启的
随机游走：
```
p = α·e_s + (1-α)·A^T D^{-1}·p
```
其中重启概率 α 控制游走局部性。

PPR 的数学优势：
- **衰减自然**：距离越远的节点权重越小，不需要硬截断
- **参数可解释**：α 接近 1 = 只看直接邻居；α 接近 0 = 全局 PageRank
- **可高效近似**：push-forward 算法在稀疏图上 O(|E|/ε) 达到 ε 精度

**投入产出**：高投入（需实现 PPR 算法或引入图库）。产出是 graph expansion
质量提升 + 可解释的重启参数。

### 3.4 Node split 的谱聚类判据

**当前状态**：`candidatePartitions` 按 `memory_type | scope` 分组。
这是 good enough，但对 non-categorical 的语义分化无能为力。

**可补**：在 node 内构建 memory-memory 相似度矩阵（用 cosine similarity），
计算 Laplacian 的前几个 eigenvector，用"谱间隙"自动确定分几组：
```
k* = argmax_k (λ_k - λ_{k+1})
```
然后用第 2 到 k+1 个 eigenvectors 的行向量做 k-means，得到 partition。

**投入产出**：中投入。需要存储 node 内所有 memory embeddings（当前已可获取）。
产出是自动发现语义分化而非依赖预定义特征。

### 3.5 Retrieval 的统计 Guarantee

**当前状态**：没有对检索质量的任何可证明界。

**可补（非平凡）**：如果向量 embeddings 满足某个可分离条件（如两个 cluster
的 centroid 距离 > 某个 threshold），可以给出 cosine similarity retrieval
的 recall guarantee。但这类分析通常要求很强的分布假设（如各向同性高斯），
在自然语言 embedding 中不一定成立。

**投入产出**：高投入，理论价值高但实用性存疑。更好的做法是直接做 empirical
recall benchmark（如现有的 LongMemEval）。

### 3.6 最优 leaf block size 的率失真推导

**当前状态**：block size = 32，是经验参数。

**可补**：建模 block 编码的 rate-distortion trade-off：
```
total cost = cost_index(B) + cost_scan(B) + cost_distortion(B)
           = c₁·|M|/B + c₂·B + λ·E[distortion(B)]
```
找到最小化 total cost 的 B*。

但 `distortion(B)` 很难建模（block 内搜索精度如何随 B 变化？），
所以即使写出来，参数估计也不容易。

**投入产出**：低投入（数学分析），低产出（因为参数估计的误差可能大于
优化收益）。当前经验 B=32 可能就够好了。

---

## 4. 优先级建议

按"补了之后真能改变设计决策"排序：

| 优先级 | 条目 | 理由 |
|---|---|---|
| **P0** | 检索混合权重的贝叶斯/逻辑回归拟合 | 已有数据，立即产出最优权重 |
| **P1** | Router 加 regret/mistake bound | 从"能跑"到"能证明收敛"，且只需改 update 规则 |
| **P2** | PPR 替代 BFS graph expansion | 提升 relation 检索质量，有可解释参数 |
| **P3** | 谱聚类指导 node split | 自动发现语义分化而非等用户手动拆分 |
| — | Leaf block rate-distortion | 数学上好看，但 32 可能已经够好 |
| — | 检索统计 guarantee | 太依赖分布假设，empirical benchmark 更可靠 |

---

## 5. 总结

NMG 目前只有 **Huffman 编码**是真正从数学定理出发构建的。其余组件的设计
来自良好的工程直觉（progressive disclosure、多路检索、EMA router），
碰巧与某些数学概念同构，但数学没有驱动决策。

这本身不丢人——工程直觉做出好系统是常见的事。但如果要把 NMG 定位为
"有数学根基的系统"，需要在关键决策点（检索融合权重、router 更新规则、
graph expansion 策略）引入形式化的推导或可证明的 guarantee。
