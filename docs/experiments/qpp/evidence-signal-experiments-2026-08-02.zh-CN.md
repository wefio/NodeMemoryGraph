# QPP 证据信号实验：top-1 差距、列表内聚与 LLM 充分性（2026-08-02）

[English](evidence-signal-experiments-2026-08-02.md) | [简体中文](evidence-signal-experiments-2026-08-02.zh-CN.md) · [术语](evidence-signal-experiments-2026-08-02.terms.yaml)

> **状态：**历史研究报告。原文列出的两个结果 JSON 当前 checkout 中不存在，因此以下数值保留自报告，本轮文档整理未独立复现。以下公式与落地建议描述的是实验当时状态，不是当前运行时；当前契约见[QPP 设计](../../design/retrieval-confidence-controller.zh-CN.md)。

## 背景与协议边界

实验当时，自动召回的 QPP 原型使用当时记录的公式 `C = Top1 + 0.3·variance + 0.3·intentCoverage + 0.2·reasonHealth`。当前分数已不同，改为 `Top1 + 0.5 × NQC`，见[当前设计](../../design/retrieval-confidence-controller.zh-CN.md#当前契约)。

实验假设是：单证据问题的 Top-1 margin 应较大；多证据问题中，证据之间的相似度应高于证据与噪声之间的相似度。以下实验只将标签用于评测，不将其输入检索或特征。

## 实验一：检索信号审计

协议：`locomo10.json` 中 1,978 个带 evidence 标签的问题；BGE-small record 向量；将原始检索、Top-1 反查与 QPP2 反查三路做加权 RRF@20；按 session 分组做五折。标签不进入检索或特征。

特征集包含七个基线信号、五个 Top-1 分布信号和四个列表内聚信号。

| 特征 | `multi_evidence` AUC | `complete@20` AUC |
| --- | ---: | ---: |
| `top1`（基线，绝对分数） | 0.466 | 0.564 |
| `gap`（基线，绝对差值） | 0.471 | 0.580 |
| **`nqc`**（归一化离散度） | 0.470 | **0.667** |
| `t1_over_mean` | 0.458 | 0.664 |
| `qpp2_top1_mass`（基线） | 0.456 | 0.655 |
| `mass_gap` | 0.464 | 0.611 |
| `t1_margin_rel` | 0.474 | 0.578 |
| `t1_zscore` | 0.469 | 0.573 |
| `list_coherence` | 0.485 | 0.438 |
| `top1_neighbourhood` | 0.477 | 0.455 |
| `top1_iso` | 0.523 | 0.545 |
| `list_query` | 0.482 | 0.474 |
| 全特征 logistic 融合 | 0.513 | 0.667 |

**假设 A——Top-1 离散度可预测证据数量：**该样本不支持这一假设。Top-1 离散度特征对 `multi_evidence` 的 AUC 为 0.46–0.52，接近随机。同一类特征对 `complete@20` 的效果更好，其中 NQC 是最佳单特征，AUC 为 0.667。在本实验中，较强的 Top-1 分布信号更能表明检索结果完整，而非问题需要多少条证据记录。

**假设 B——无标签的列表内聚：**对两个目标而言，proxy 特征都较弱（AUC 0.44–0.55）。对 110 个可见列表（至少含两条 evidence）的标签诊断发现，evidence-evidence 平均相似度为 `0.808`，evidence-noise 为 `0.761`；间隔在 `85.5%` 的列表中为正，对 `complete@20` 的 AUC 为 `0.657`。该诊断需要知道哪些项是真实 evidence，因此不能作为在线特征。

## 实验二：LLM 充分性判断

协议：top-12 检索；平衡抽样 150 个问题（75 个单证据、75 个多证据，每个 session 最多 8 个）；由 `deepseek-chat`（`deepseek-v4-flash`，temperature `0`）判断检索到的记录是否足够，并返回 `{sufficient, confidence}`。标签只用于评测。

| 目标 | 占比 | confidence AUC | 二值 AUC | 混淆矩阵（TP/FP/TN/FN） | 平衡准确率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `multi_evidence` | 46.7% | 0.508 | 0.463 | 8/15/65/62 | 0.463 |
| `complete@20` | 28.7% | **0.732** | 0.670 | 17/6/101/26 | 0.670 |

- LLM 判断同样无法预测证据数量（AUC `0.508`），与实验一及更早的 v1 audit（`0.513`）一致。
- 在该样本中，它对 evidence 完整性的预测优于纯检索特征（`0.732` 对比 NQC 的 `0.667`），但需要额外模型调用。
- 150 次判断中，有 6 次模型认为“足够”但 evidence 实际不完整。模型更常判断“不足”，而不是“足够但仍缺证据”（26 个 FN 对 6 个 FP）。
- 报告记录的成本：76,070 prompt token 与 6,831 completion token（约 82K token；150 次调用约人民币 0.5 元）。

## 阶段三：动态推荐机制测量

协议：`locomo10.json` 中 1,986 个问题，按 session 分组，每个 turn 一条 record，使用 BGE-small 语义检索。报告新增 `audit-elbow.ts`、逐题分数序列与 gold 命中位置输出，以及 embedding cache；报告称重跑约需五分钟。生成产物不在当前 checkout 中。

### 该数据集与检索设置中的观察

- 固定 top-K recall 呈现近似幂律形状（报告拟合 `R²=0.995`），边际收益递减、噪声近似线性增长。这只是对该数据集与设置的拟合，不是普遍的检索定律。
- 在此设置中，三种无监督分数分布方法都无法可靠估计所需证据数量：语义余弦分数较平（top-1/top-2 gap 中位数 `1.25%`），证据／噪声区分为 `2.2%`，elbow 检测选在 rank 1–3，与标注所需数量的 Spearman 相关约 `0.05`。Adaptive-K 结果退化为常数 K 加常数缓冲。
- 唯一有用的极端信号是相对 top-1/top-2 gap 超过 `5%`；这些查询的所需数量中位数约为 `3`。Top-1 绝对强度本身不能说明证据需求较少；即使 Top-1 较高，查询也可能需要最多 `7` 条记录。
- 报告建议将充分性判断留给消费检索结果的 Agent，并把 QPP 的自动作用收窄为检索 guardrail。这是历史建议；当前调用方默认值和已实现分数见[当前设计](../../design/retrieval-confidence-controller.zh-CN.md)。

### 与固定 Top-20 的历史比较

| 指标 | 固定 Top-20 | 报告中的自适应方案 | 差异 |
| --- | ---: | ---: | ---: |
| 记录数（token 代理） | 20.00 | 14.44 | -27.8% |
| 噪声记录 | 19.51 | 13.94 | -28.6% |
| Evidence coverage | 0.389 | 0.397 | +0.8 pp |

报告称 77% 的查询一次完成；`22.9%` 的追加率是 oracle 上界，不是实时消费模型的追加率。强 gap 查询占 `5.9%`，初始目标为三条记录。这些都是有界离线结果，不构成产品级质量或成本保证。

### 历史落地建议

报告当时建议将 `initialEvidenceTarget` 做成可配置项、在 `topGap ≥ 5%` 时走 strong-hit 分支、允许消费方请求更多 evidence，并将 `secondPass: true` 设为生产默认值。这些是当时的建议，不代表当前所有调用方的默认值。当前 core `searchContext`、便捷包装方法、Pi QPP2 和 OmniMemEval 的激活默认值各不相同，见[调用方专属激活](../../design/retrieval-confidence-controller/confidence-and-trigger-design.zh-CN.md#调用方专属激活)。

## 实验记录的结论

1. **不要用这些信号预测证据数量。** 在测量样本中，检索信号与 LLM 信号对 `multi_evidence` 都接近随机。证据数量不能与检索完整性混为一谈。
2. **有证据支持的目标是完整性预测。** 本报告中，LLM 充分性 confidence 对 `complete@20` 的 AUC 为 0.732，NQC 为 0.667，`qpp2_top1_mass` 为 0.655。这些样本内测量不能建立实时触发策略。
3. **需要标签的内聚指标只适合审计，不适合在线触发。** 它依赖 gold evidence 集合。
4. **采用相对基线并保留可配置性。** 报告中的自适应方案只在一个数据集上与固定 Top-20 比较，且使用 oracle 追加上界；没有证明通用最优值。

原报告列出的结果 JSON `evals/results/locomo-evidence-mode-signal-v2.json` 与 `evals/results/llm-sufficiency-150.json` 当前 checkout 中不存在。本报告保留了叙述中的数值，但不能替代原始产物或重新运行。