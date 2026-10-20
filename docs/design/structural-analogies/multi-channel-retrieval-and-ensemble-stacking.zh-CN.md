# 多通道检索 = Ensemble Stacking

[English](multi-channel-retrieval-and-ensemble-stacking.md) · [使用的术语](multi-channel-retrieval-and-ensemble-stacking.terms.yaml)

**Authority:** [父级范围](../structural-analogies.zh-CN.md)。

## 多通道检索 = Ensemble Stacking

**当前实现**：`src/core/store/retrieval.ts` — retrieval path；`src/core/store/search-ranking.ts` — `hybridScore`。

**结构**：

```
NMG                              Stacked Generalization
────────────────────────────────────────────────────────────
FTS5 匹配 → lexicalScore         Base learner 1 → prediction
向量 cosine → vectorScore        Base learner 2 → prediction
路由 score → routeScore          Base learner 3 → prediction
combinedScore =                  Meta-learner:
  weighted_sum(scores)             linear combination of base predictions
```

**相似点**：
- 多个独立信号（base learners）各自打分
- 线性组合（meta-learner）产生最终排序
- 各信号可以独立失效（FTS 找不到、向量有噪声），融合后鲁棒

**差异**：
- 真正的 stacking 的 meta-learner 是用 held-out data 训练的
- NMG 的组合权重是硬编码的，没有从数据学习
- 真正的 ensemble 会有 diversity measure，NMG 没有检验信道独立性

**与 Sensor Fusion 的相似（Kalman filter 的特例）**：
- 多个 noisy sensor 各自给出观察
- 加权融合：高精度 sensor 权重更大
- 如果三个信号独立且各自有 noise variance σ²ᵢ，最优权重 ∝ 1/σ²ᵢ

**设计启发**：如果能够估计每个信道的"噪声方差"（如 FTS 对语义模糊 query
的 recall 低 → 高方差），就可以用 Kalman-like 的自适应权重替代硬编码权重。

---
