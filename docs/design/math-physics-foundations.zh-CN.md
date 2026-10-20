# 数学基础：算法、类比与提案

[English](math-physics-foundations.md) | [简体中文](math-physics-foundations.zh-CN.md) · [术语](math-physics-foundations.terms.yaml)

创建于 2026-07-20 的历史设计综述。原文中的“当前状态”清单与实现缺口不是实时状态登记册。本文区分算法、数学类比、经验结果和提案；本文没有将任何提案设为已采纳的产品契约。

## 原综述试图区分的内容

原文提醒不要用数学语言为既有设计事后背书。它将例子分为：

- **显式算法或度量：**Huffman 式深度分配、cosine similarity，以及 SQLite FTS5 的 BM25 排序被列为具体数学组件。
- **设计词汇，而非已实现目标函数：**rate-distortion 语言被用作架构类比，不是已计算的 loss 或已度量的 rate／distortion 函数。
- **工程启发式：**例子包括手工加权的检索信号、EMA routing、regex gates 和分阶段披露。受数学启发不等于有证明或经过校准的错误率。

数学结论必须应用于其实际覆盖的量与假设。例如，Huffman 期望码长界本身并不能证明端到端检索或回答质量最优，尤其当权重是启发式、码长又映射到有界 tiers 时。

## 历史记录中的提案

| 提案 | 想回答的问题 | 采纳前所需证据 |
|---|---|---|
| 从标注 traces 拟合检索融合权重 | lexical、vector、route 或 tier 信号能否预测有用 memory？ | 防止数据泄漏的 labels、留出集评估、校准结果，以及与固定权重比较 |
| 用带 mistake bound 的规则替代或增强 EMA routing | perceptron 类保证的假设是否适用于 NMG 的输入与更新？ | 明确的 loss／labels、经验证的可分性或其他明确假设，以及实测行为 |
| 用 Personalized PageRank 做 graph expansion | 带 restart 的加权遍历是否优于有界 BFS？ | 受控检索 benchmark，以及计算／上下文成本测量 |
| 将谱聚类用作 split 建议 | partition metric 能否改善候选质量，同时不授权自动 split？ | 资源匹配的数据、稳定性检查，以及人工／judge 审核 |
| 推导检索或 block-size 保证 | 分布假设是否现实，界能否预测观察到的结果？ | 明确假设加经验比较；否则使用 benchmark 证据，而不要声称有保证 |

这些是研究方向，不是已接受的设计。尤其是，在某些假设下成立的理论界，不证明这些假设适用于自然语言 memories。

## 当前 owner 与证据

当前实现契约请查阅[分层激活](hierarchical-activation.zh-CN.md)、[检索置信度控制器](retrieval-confidence-controller.zh-CN.md)、[当前链设计](temporal-logical-chains-design-2026-08-13.zh-CN.md)及 [`src/core/`](../../src/core/) 下的源码模块。性能测量请查阅相关实验记录。历史提案表不取代这些 owner，也不暗示提案已实现、已 benchmark 或已选定。

治理时应区分：**形式化保证**（在明确假设下）、**经验结果**（针对测量过的路径与样本）、**启发式**（没有此类保证的规则）和**类比**（仅提供解释词汇）。