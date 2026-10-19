# QPP 工程经验：审计暴露的两个问题

[English](engineering-notes.md) | [简体中文](engineering-notes.zh-CN.md) · [术语](engineering-notes.terms.yaml)

> **状态：**历史复盘，记录 commit `dd41829`（QPP shadow wiring）与 `d86b658`（squash 修复）之间的开发过程，以及 commit `86c837f` 中的后续修正。本文解释原型如何演变，不描述当前分数。当前 QPP 契约见[设计文档](../../design/retrieval-confidence-controller.zh-CN.md)。

## 问题一：clamp 饱和分数并抹掉区分度

**当时的现象：**在 7 题 LongMemEval run 上执行 `audit-qpp-signal.ts`，QPP 形成两个簇：空检索约 `0.15`，非空检索约 `1.35`。两个桶的准确率都是 `0.33`；在这个极小样本中，分数无法进一步区分查询。

**原因：**某条结果映射路径把原始 lexical 分数（实测约 `84`）赋给了 `combinedScore`，而不是有界的 `hybridScore`。`contextUsefulness` 继承了这个量纲。原型把 usefulness clamp 到 `[0,1]`，因此非空检索全部饱和到 `1.0`；`Top1` 变成常数、variance 变成零，公式退化为“检索是否返回了任何内容”。

**第一次修复尝试：**用有界 squash `s(x) = max(0,x)/(max(0,x)+10)` 替代 clamp。对于观察到的原始尺度，它将 `84 → 0.894`、`20 → 0.667`、`5 → 0.333`，恢复了分数梯度。commit `d86b658` 记录了这一中间修复。

**后续修正：**审计中的 raw lexical 量纲并不适用于所有 live 路径。同一个 `combinedScore` 字段在一条路径上可能是有界 hybrid score，在另一条路径上可能是约 `84` 的 raw lexical 分数，在 `#resultsForNode` 中还可能为零。没有一个 squash 常数能同时保留这些尺度。最终实现从 `selections.scores.{lexical,vector,route}` 重算 `hybridScore`，并用其有界 `[0,1]` 值作为 strength。详见 commit `86c837f` 和当前 [`qpp.ts`](../../../src/core/qpp.ts)。

**教训：**不要从字段名推断量纲。应用 clamp、sigmoid 或 squash 前，应检查各生产路径和真实 trace。测试样本应覆盖所有可能产生不同尺度的路径，而不只是干净的 `[0,1]` fixture。

## 问题二：benchmark trace 中的 `intentCoverage` 没有变化

**当时的现象：**七个 benchmark 问题的 `intentCoverage` 全为 `0.5`（中性值），该样本中没有可区分的变化。

**原因：**LongMemEval ingest 将记录存为 `conversation_evidence`；benchmark 导入路径没有产生 preference、fact、event 或 state 类型。此外，许多 AutoRecall query 不匹配 intent pattern。因此，该特征有时没有可检查的期望类型，有时找不到类型匹配的记录。

**教训：**特征效果可能依赖数据形状，而不只是算法。在目标 trace 上训练权重前，先检查特征分布；对该数据恒定的特征没有区分价值。当前运行时仍为诊断记录 `intentCoverage`，但不将其纳入 QPP 分数。

## 方法论经验

1. **先 shadow 可以低成本暴露故障。**原型只记录 QPP，不改变检索行为。shadow trace 使我们能在饱和问题造成静默误触发或漏触发前发现它。
2. **纯函数回放可以避免模型调用。**如果某个指标只是持久化 selections 与 records 的纯函数，就可从历史 trace 重算，而不必重跑 LLM 或支付 provider 成本。`audit-qpp-signal.ts` 是这种方法的实例。
3. **先审计，再标定。**先检查真实 trace 中的特征分布和路径尺度。用极小样本或恒定特征调权重，只会拟合噪声，不会得到可靠策略。

## 历史后续步骤

原记录建议：若要让 `intentCoverage` 有信息量，需要类型化 ingest；标定前应继续审阅更多 trace。Stage-0 渐进接线后来已经实现；当前默认值、分数构成与剩余标定边界由[当前 QPP 设计](../../design/retrieval-confidence-controller.zh-CN.md)负责。本文不声称七题审计之后已经得到经过标定的触发器或通用检索收益。