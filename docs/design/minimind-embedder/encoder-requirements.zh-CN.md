# 图侧决定编码器需求

[English](encoder-requirements.md) | [简体中文](encoder-requirements.zh-CN.md) · [术语](encoder-requirements.terms.yaml) · 上级：[MiniMind-NMG 编码器历史档案](../minimind-embedder.zh-CN.md)

历史设计输入。记录的数据分布与架构选择不是当前实现要求，也不是经本次审计独立复现的测量结果。

## 图侧决定编码器需求

编码器输出被三个消费者使用，它们都依赖 L2 归一化向量：

```
编码器输出: Float32[256] L2
         │
         ├─→ HA (HierarchicalActivation)
         │     query·candidate cosine → g₁ cross-attention
         │     7-way blended scoring → nodeScores
         │     ★ 基础信号是余弦相似度，编码器质量决定一切下游
         │
         ├─→ MGR (MemoryGraphReasoner)
         │     g = σ(v^T @ q + b)    gate 依赖 v^T @ q
         │     q' = g·v + (1-g)·q   残差混合
         │     r = q'^T @ v          局部相关性
         │     ★ gate 门控依赖余弦相似度，编码器偏了 gate 就偏了
         │
         └─→ DifferentiableController
               node/edge/control/budget heads
               ★ 不直接消费编码器输出，消费 HA 的 nodeScores
```

**归档设计的结论**：编码器只有一个核心任务——**把语义相近的文本映射到相近的 L2 方向**。
所有"选择性关注"、"多尺度聚合"、"时序记忆"都在图侧完成。
编码器越简单，越容易验证、导出、加速。

### Attention 最终选择：双向 Full Attention

| 方案 | 判定 | 原因 |
|------|------|------|
| **双向 Full Attention** | ✅ 选定 | 每条 token 看全序列，ONNX 友好，Flash Attention 原生支持 |
| KDA 式状态化 | ❌ | 跨节点状态 = MGR gate biases + h₁ EMA 职责，冗余且冲突 |
| MLA 式压缩 | ❌（Phase 6） | 存储压缩的价值在百万节点后才明显，先做正确再做省 |
| 稀疏 Attention | ❌ | 编码器输出单一向量，不需要 token 级稀疏选择 |
| causal Attention | ❌ | 生成模型的遗产，对编码是纯负债（前向 token 看不到后文） |

### 真实数据分布（4 个 benchmark, 5732 条消息）

```
p50:    359 tokens
p75:    951 tokens
p90:   1180 tokens
p95:   1318 tokens
p99:   1657 tokens

< 500 tokens:  53%
≥ 500 tokens:  47%
≥ 1000 tokens: 21%
```

接近一半的消息超过 500 tokens。文本分布有三类：
短查询/摘要（50-200 tokens）、中长证据/对话（200-800 tokens）、长文档/轨迹（1000-5000+ tokens）。
