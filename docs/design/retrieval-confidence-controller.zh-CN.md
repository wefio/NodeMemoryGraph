# 检索充分性与控制器边界

[English](retrieval-confidence-controller.md) | [简体中文](retrieval-confidence-controller.zh-CN.md)

确定性的 post-retrieval QPP 分数与同池 Fibonacci 遍历已实现，但是否扩展由调用方决定，并非所有调用的通用默认行为。当前分数为 `Top1 + 0.5 × NQC`，阈值为 `0.55`，另有永久 guardrail。可学习控制器仍是可选路径：运行时默认 `shadow`，滚动阈值产物不能自行激活。

## 范围

QPP 用于估计当前选中的检索结果集是否足以继续；它不证明答案正确、不预测问题需要多少条 evidence，也不替代逐条记忆的抽取置信度。`MemoryRecord.confidence` 是另一种属性。

本文负责说明设计理由与证据边界。[QPP 分数、渐进遍历与控制器接线](retrieval-confidence-controller/confidence-and-trigger-design.zh-CN.md)负责实现细节；[渐进召回](fibonacci-progressive-recall.zh-CN.md)负责 Fibonacci 档位与 trace 契约。

## 当前契约

- 核心逻辑根据当前选中的结果计算 QPP。分数使用直接候选的 `Top1` 与归一化分数离散度（`NQC`）；intent coverage、reason health 和 expansion 诊断会被记录，但当前不参与分数。
- 调用方启用 `secondPass` 后，检索会从同一个过采样候选池重新选择累计 Fibonacci evidence 档位，不会再次发起 ANN/FTS 搜索。`searchContext` 默认不启用该遍历；包装方法和适配器各自决定默认值。
- 默认目标值与阈值只是运行点，不是通用最优值。`13` 来自有限的 LoCoMo 研究，不应外推到其测量设置之外。
- 可学习分配、折叠与重排是独立的可选路径。`shadow` 控制器不能执行动作；受控或 active 执行受候选状态及相应证据／审批契约约束，不能仅凭 benchmark 或开关推定已获准。

调用方默认值和全部激活条件见[实现细节](retrieval-confidence-controller/confidence-and-trigger-design.zh-CN.md#调用方专属激活)。

## 为什么仍需继续研究

2026-08 的一项 LoCoMo 信号实验发现，在该样本中，归一化离散度（`NQC`）可预测 `complete@20`（单特征 AUC 为 `0.667`），但预测多证据问题的能力接近随机（AUC `0.470`）。该结果支持有界的充分性信号，不支持预测证据数量，也不构成通用质量保证。详见[实验记录](../experiments/qpp/evidence-signal-experiments-2026-08-02.md)。

另一项 LongMemEval 审计按 exact evidence 覆盖情况报告答案准确率：包含全部已标注 evidence 时为 `89.67%`，部分覆盖时为 `16.67%`，没有 exact evidence 时为 `7.45%`。这是辅助的严格审计，不是官方 benchmark 分数，也不是 QPP 触发收益的测量。详见[OmniMemEval 报告](../../evals/omnimemeval/README.md)。

## 边界与非目标

- 当前触发是确定性的，不调用 LLM 判断充分性。未来若引入模型判断，应作为独立设计决策。
- 系统估计检索充分性，不预测支持答案的记录数量。离线证据不足以支持把 `single`／`multi` 暴露为产品断言。
- 本设计不训练 embedding 模型，也不让 ANN/top-K 选择变得可微。可学习控制器消费有界标量特征，并受独立运行时通道约束。
- Self-RAG 与 FLARE 不是当前机制：它们依赖生成侧行为，而这里讨论的是 post-retrieval 决策。

精选实现历史见[实现沿革索引](implementation-lineage.zh-CN.md)。