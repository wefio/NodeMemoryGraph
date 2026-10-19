# 路由实验的数据策略：数据集、采集、泛化与质量（2026-09-07）

[English](data-strategy-2026-09-07.md) | [简体中文](data-strategy-2026-09-07.zh-CN.md) · [术语](data-strategy-2026-09-07.terms.yaml)

**状态：**有日期的研究综述，汇总内部 OmniMemEval 数据结构与外部文献；不是实时数据集清单或当前实现契约。开展新实验前，需重新核实外部结论、artifact 可用性与代码路径。

## 核心结论

用于训练决策策略的关键样本不是 benchmark 的 `(question, corpus, gold answer)`，而是实际执行过的 `(state → action → reward)`。要知道注入某种上下文是否有帮助，必须对实际 action 执行 answer model 并评分；多个 action 还需要探索。单次固定策略的 recall benchmark 不能替代这种干预样本，也不能自动证明真实多轮 Agent memory 中的泛化。

数据质量同样需要预先论证：gold 与 judge 可能有噪声；训练、验证和测试应按 owner 隔离；分数差应与 judge 噪声比较；真实 harness 中的跨用户污染风险需要单独控制。综述明确建议将 benchmark 视为受限 sandbox，而不是默认可信的 ground truth。

## 原综述记录的数据集判断

| 数据集 | 当时指出的适用点 | 当时指出的限制 |
|---|---|---|
| LoCoMo | 约 10 个 owner，时间与多轮问题；有检索上下文 artifact 与官方评分路径 | owner 数太少，难以支持 owner 级分折与多 action 探索；综述援引的 gold／judge 审计噪声会限制细粒度分数差解释 |
| LongMemEval | 500 条独立问题，owner 级准确率泛化的样本数较多 | 每题独立 haystack，几乎没有 owner 内序列，难以研究历史状态特征；综述还记录了其作为 memory benchmark 的上下文窗口有效性争议 |
| PersonaMem v2 | 约 200 个人设、多轮对话，结构上适合序列历史 | 当时 owner 与问题映射、官方评分接线尚未确认，搭建成本最高 |

这些数量与可用性是 2026-09 的记录，不是当前仓库或 benchmark 的即时状态。原文列举了有害／干扰上下文、STALE、冲突个人记忆及成本感知检索等候选数据，但也指出它们与 NMG 用户记忆任务并不完全匹配，需另做适配审计。

## 样本获取与评估门槛

原方案提出：每条训练样本至少需要一次真实 answer 执行和一次评分；若要估计多 action 策略，还需跨 action 探索，成本须预先声明。建议的质量门槛包括：审计所选子集 gold、报告 judge 一致性／噪声、owner 级隔离、检查覆盖的记忆能力、以及明确声明 benchmark 到真实多会话 Agent 的迁移边界。

原文认为，对于实际注入决策，纯 recall benchmark 会偏向“总是 retrieve”；“要不要注入、注入多少、上下文是否有害”更贴近选择性检索和冲突／陈旧记忆数据。但这些映射仍是研究判断，并非已验证的统一数据集方案。

## 当时记录的奖励／学习契约

2026-09-07 记录称 `src/lab/context-reward.ts` 实现了以一次已执行决策为单位的单一标量 reward，并将语义判定分为 `verified`、`correctAbstain`、`insufficient`、`rejected` 和 `falsePositive`；有害注入罚分最重，`lambda*K` 成本在选择阶段扣除，不重复写入 outcome reward。原文称 `contextUseReward` 测试为 7/7，feedback 到 outcome 映射测试为 10/10，均属于当时记录。

该记录还给出两个不同的 feedback 数量：一处称有 45 条 natural events，另一处称用 108 条 natural feedback rows 验证映射（其中 68 条可映射：verified 35、rejected 13、insufficient 20）。原文没有解释两个计数的范围差异；不要将其合并为同一个数据集计数。当前实现与测试状态以源码和现行收据为准。

该学习契约针对即时 recall outcome，不自动建模多轮 credit assignment 或 H2 历史效应；原文将后者留作独立问题。answer overlap 不是 usefulness 的充分标签。

## 当前 owner 与证据边界

- 路由／奖励代码：[`src/lab/`](../../../src/lab/)
- OmniMemEval 工作流：[`evals/omnimemeval/`](../../../evals/omnimemeval/)
- 当前检索与控制器设计：[`docs/design/retrieval-confidence-controller.md`](../../design/retrieval-confidence-controller.md) 与 [`docs/design/feedback-loop-design.md`](../../design/feedback-loop-design.md)

外部文献与数据集审计结论按原综述保留，本文未重新联网核实。新的 benchmark、样本或训练决策应重新检查出处、许可、评分机制、资源预算与 owner 隔离。