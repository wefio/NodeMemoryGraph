# 设计收敛：有界链披露

[English](converged-design.md) | [简体中文](converged-design.zh-CN.md) · [术语](converged-design.terms.yaml) · 上级：[时间／逻辑链设计历史](../temporal-logical-chains-design-2026-08-13.md)

2026-08-13 的有日期设计综合。下方外部研究比较是历史引用，不是经过独立核验的 NMG 证据。“当前源码契约”中的扩展数值已对照当前源码检查；实现仍是权威依据。

## 设计边界

时间类问题可能需要正序、倒序或受限时间窗口；具体使用哪种顺序由查询决定。检索应召回相关证据，不应按时间对所有结果做全局重排。Chain 结构是召回补充和呈现辅助，不是推理引擎：调用方显式写入成员与有向 edge，下游消费者负责解释返回的上下文。

Temporal chain 保存记录的有序引用；Store 默认按追加顺序加入成员，因此调用方若要求按 event time 排序，必须提供由 `eventTime` 推导的位置。Logical chain 使用显式成员关系和有向 DAG edges。一条记忆可以属于多条 chain；共享成员会形成交集，但不表示系统推断了关系。

## 当前源码契约

只有调用方设置 `expandChains` 时才执行链扩展。扩展会追加有界补充内容，不改变主检索排序。`src/core/store/retrieval.ts` 中当前默认值与硬上限为：

- 跨链交集：`chainExpansionMaxHops` 默认 `1`，硬上限也是 `1`；因此直接命中的链可披露一层相邻链（`C0 → C1`），不会继续递归到 `C2`。
- 链选择：`chainExpansionMaxChains` 默认 `4`，硬上限 `8`。代码使用 MMR 风格选择：直接命中链的 relevance 权重更高并叠加 topic overlap；redundancy 使用成员 ID 的 Jaccard overlap；分数为 `0.7 × relevance − 0.3 × redundancy`。
- Edge 披露：`chainExpansionMaxEdges` 默认 `64`，硬上限 `128`。
- Logical-chain 成员遍历：`chainExpansionMaxMemoryHops` 默认 `2`，硬上限 `8`；temporal chain 使用 position 与 `chainExpansionWindow`。
- 若提供 `chainExpansionWindow`，则围绕命中位置限制成员窗口。未提供时，非命中成员须通过 `0.5` activation 阈值。`chainExpansionMaxMembers` 默认等于主结果数量。
- 追加补充内容共用默认预算 `min(16,000, 1,024 + 0.75 × primaryEvidenceChars)`；调用方可以覆盖预算选项。此预算也与其他未排序追加补充共享。
- `src/integration/chain-projection.ts` 中 logical-chain 呈现另有默认 `2,048` 字符结构预算。它不替代证据预算，陈述正文与投影结构分开。

这些是当前源码数值，不代表某条链能提升回答质量。下方链接指向具体代码与调用方。

## 记录中的设计理由

有日期的设计选择了四项约束：时间顺序应由查询意图决定，而非全局重排；temporal/logical 路径以显式静态引用表示；通过共享成员有界披露跨链证据；推演产物不能静默修改记忆或链结构。最后一项是治理边界，不表示所有调用方都使用同一种监督方式。

旧稿引用 Mem0、Zep/Graphiti、TH-RAG、MMR、chronological passage assembly、MemOps、TrustMem、FOREVER 和 ForgetBench 作为设计动机。本文不复现第三方指标与结论，不得将其报告为 NMG 测量结果。

## 源码参考

参见 [`SearchOptions`](../../../src/core/types.ts)、[链扩展与追加预算](../../../src/core/store/retrieval.ts)、[链持久化与 DAG 检查](../../../src/core/store/base.ts)、[logical-chain 投影](../../../src/integration/chain-projection.ts) 和 [chain 测试套件](../../../tests/core/memory-chains.test.ts)。