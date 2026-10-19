# 基于节点摘要的加速检索（2026-08-19）

[English](node-summary-accelerated-retrieval-2026-08-19.md) | [简体中文](node-summary-accelerated-retrieval-2026-08-19.zh-CN.md) · [术语](node-summary-accelerated-retrieval-2026-08-19.terms.yaml)

**状态：**历史设计探索，不是实现记录或性能报告。本文所列外部文献未在本次审计中独立复核。当前 QPP 行为与检索契约归下方 owner 管理。

## 问题与备选方案

2026-08 笔记讨论：store 规模扩大时，节点级语义摘要能否降低候选生成与排序成本。它比较了三种策略：

| 策略 | 搜索行为 | 主要权衡 |
|---|---|---|
| **A. Pruning** | 使用摘要／路由信号选择节点，只在这些节点内搜索 | 候选池缩小，可能带来长期节省；若摘要不完整或过期，可能漏掉证据 |
| **B. Progressive ordering** | 先搜高潜力节点候选；若不足，再回退到不变的全库候选池 | 有机会早停加速，并保留全库兜底；本文没有测量召回损失保证 |
| **C. Cascade** | 先渐进搜索，再按置信度或预算调整搜索池范围 | 结合早停与选择性剪枝，但要求校准决策且复杂度更高 |

笔记最初推荐 C，随后记录用户决定**分层而非直接混合分数**：逐查询渐进使用即时摘要／词法信号；学习路由只用于长期、渐进式缩小候选池。并提出以全库 fallback 作为最后召回保障。这是历史设计决策，不证明当前已经接入任何一种机制。

## 对学习式剪枝提出的安全条件

笔记识别出一种冷启动故障：未训练节点权重为零时，可能得到零分并被全部剪掉。只有同时满足以下条件才建议剪枝：

- 有足够训练样本（`examples ≥ N`）；
- 路由分数明确较低（`score < θ`）；
- 有证据表明 query 属于分布内，使用它与该节点历史 query 的词法重叠作为 guard。

否则不剪枝；依靠摘要路由与全库 fallback。笔记还警告，不应仅根据存在 exposure bias 的路由行为训练。拟议的正样本须同时满足摘要命中、实际检索到、显式使用（`usedNodeIds`）；路由诊断应与训练标签分开保存。

## 拟议 trace 信号与评估

拟议的 instrumentation 分两级：逐 query 的 `(query, node, routed, recalled, used)` trace 用于诊断／重训；按节点聚合的 routed/recalled 计数用于快速监控。笔记提醒，“被路由到”会产生 exposure bias，本身不能作为相关性标签。

实现前建议在 LongMemEval 500 问或较大的 LoCoMo store 上检查：第一轮充分率／早停率、全库与节点内候选池的大小和延迟、加速比，以及相对 gold evidence 的召回损失。提案要求启用默认 progressive route 前达到零召回损失；剪枝在误差可控前保持可选。本文未报告此类 benchmark 结果。

## 当前 owner 与边界

- [Fibonacci 渐进式召回](../../design/fibonacci-progressive-recall.zh-CN.md)
- [检索置信度控制器](../../design/retrieval-confidence-controller.zh-CN.md)
- [QPP 实现](../../../src/core/qpp.ts)
- [Store 检索与排序](../../../src/core/store/retrieval.ts) 与 [`search-ranking.ts`](../../../src/core/store/search-ranking.ts)

当前 QPP 路径不证明拟议的 node-summary 候选剪枝系统存在。当前默认值与边界请查阅这些 owner。本文为保持精简，省略了历史论文列表和外部系统的性能数值；引用或采用前应核实来源。