# 历史设计记录：渐进召回与 QPP 信号修复

[English](llm-sufficiency-recall-design.md) | [简体中文](llm-sufficiency-recall-design.zh-CN.md) · [术语](llm-sufficiency-recall-design.terms.yaml)

> **状态：**2026-08-02 的历史实现／设计记录，不是当前契约。文中的测试数、测量值和“已实现”标签只描述当时的 rollout，不是当前验证。当前 owner 是[检索充分性与控制器边界](retrieval-confidence-controller.zh-CN.md)及[Fibonacci 渐进召回](fibonacci-progressive-recall.zh-CN.md)。

## 当时的背景

该记录跟进了 `nmg_automatic_recall` 与 `searchContext` 的 trace audit。它报告 QPP 分数 `C` 约为 `0.92`，原因是审计 benchmark trace 中 `reasonHealth` 为 `1.0`、`intentCoverage` 为 `0.5`；3,140 条已记录 trace 只有一次触发。它还报告，一条评测路径从固定 limit 开始并立即停止，而 Pi extension 没有传入 `secondPass`。

配套的证据信号实验后来记录了需要改分数的原因：在该样本中，NQC 离散度对 `complete@20` 的预测优于当时使用的信号；LLM 充分性判断只是离线比较项，并不意味着 NMG 应内建 judge。详见[实验报告](../experiments/qpp/evidence-signal-experiments-2026-08-02.zh-CN.md)。

## 2026-08-02 记录的决策

该记录提出了五项改动：

1. 渐进遍历从可配置的 `initialEvidenceTarget` 开始，而不是把首个固定 limit 当作答案；`limit` 作为硬上限。
2. 移除 `intentCoverage` 与 `reasonHealth` 的常量正向贡献，在 QPP 分数中使用归一化离散度（`NQC`）。
3. 保留扩展预算与调用方 limit 的 guardrail。
4. 相对 Top-1/Top-2 gap 至少为 `0.05` 时，将其作为测量得到的 strong-hit 条件，使用较小初始目标；引用样本显示单独的 Top-1 绝对分不能预测证据数量。
5. 不在 NMG 内建 LLM 充分性 judge。提案把语义充分性判断交给消费检索结果的 Agent，并将进一步检索描述为由请求驱动。

该记录还指出，QPP 不打算预测问题需要一条还是多条 evidence。后续证据报告支持这个边界，但具体实现和默认值之后已有演变。

## 当时记录的实现

记录称已实现 Fibonacci 遍历：初始目标 `13`；相对 gap 达到 `0.05` 时，strong-hit 目标至多为 `3`；调用方 limit 为硬上限；QPP 阈值为 `0.55`；retrieval trace 保存每档详情。它报告 30 个针对性测试及完整 `502/502` 测试通过，随后构建项目。这些都是 2026-08-02 记录中的历史陈述，不是本轮文档整理实际运行的检查。

同一记录引用 LoCoMo 1,986 题对比固定 Top-20 的结果：records `-27.8%`、noise `-28.6%`、evidence coverage `+0.8` 个百分点，并使用 oracle 追加上界。[实验记录](../experiments/qpp/evidence-signal-experiments-2026-08-02.zh-CN.md)说明了这些数字的范围；它们不能证明当前产品质量，也不能证明实时消费模型的追加率。

## 当前行为边界

- 当前分数为 `Top1 + 0.5 × NQC`；`intentCoverage`、`reasonHealth` 和其他分量只用于诊断，不参与分数。当前 QPP 与 guardrail 定义见[控制器设计](retrieval-confidence-controller.zh-CN.md)。
- `searchContext()` 默认不启用 `secondPass`；便捷包装方法默认启用；Pi QPP2 默认关闭；OmniMemEval bridge 默认开启。调用方启用后，核心逻辑会遍历符合条件的 Fibonacci 档位，并由 QPP 在 evidence 充分时停止。这些是不同调用方的契约，不是统一默认值。
- 调用方 `limit` 是硬上限，不会生成任意中间 Fibonacci 档位。遍历会从同一个过采样候选池重选，不会重跑 ANN/FTS，也不会逐档增加 relation expansion。
- 可学习列表折叠与确定性的 QPP 遍历是不同机制。2026-07 局部探针实验不能证明其 QPP2 模型就是当前产品模型。

参见当前[调用方专属激活表](retrieval-confidence-controller/confidence-and-trigger-design.zh-CN.md#调用方专属激活)与[渐进召回细节](fibonacci-progressive-recall.zh-CN.md)。

## 历史范围边界

原记录当时排除了 NMG 内建 LLM judge 和列表级 QPP2 压缩。这些是当时设计快照中的决定，不是永久产品禁令：当前确定性 second pass 与可选 Pi QPP2／controller 路径由不同 owner 负责，并有各自默认值。不要把历史的“Status: current”或旧测试收据当作当前行为证据。