# 在选出证据后处理词法分数并列

[English](2026-09-30-lexical-tie-ranking.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [独立相关性训练](2026-09-15-independent-relevance-training.zh-CN.md)

## Problem

首阶段词法分数相同的证据可能以较弱的顺序进入上下文。试过的小型神经网络排序器，
在真实召回轨迹上没有证明比产品现有排序有实质且可靠的收益。具体结果见
[检索实验](../../experiments/retrieval-quality/lexical-tie-ranking-2026-09-30.md)。

## Decision

仅在 FTS5 词法路径中，于 Active Graph 预算选出证据后，对相邻且
`combinedScore` 完全相同的记录排序。并列判定使用查询词在记忆陈述及前 500
个证据字符中的 IDF 加权覆盖度。候选集合、非并列顺序、QPP 决策和混合检索
保持原样。本任务的小型神经网络排序实验失败；此变更不加入神经网络排序器
或模型产物。

## Alternatives considered

- 把试过的 MLP 接入产品：同一候选集的效果弱于现有排序；限制在顶部并列组
  后的小幅收益也没有统计证据支持，因此拒绝。
- 重排所有候选或修改候选生成：超出了已测规则，也会改变证据预算或召回集合。
- 保留原词法并列顺序：会失去 LoCoMo 样本上测得的排序收益。

## Consequences

规则消耗少量临时 CPU 时间，不存储模型权重。固定样本上的 LoCoMo 排序改善，
LongMemEval 和 BEAM 小幅回退；R@20 和候选集合没有改善。这不能证明语义
候选召回或最终回答质量提高。
