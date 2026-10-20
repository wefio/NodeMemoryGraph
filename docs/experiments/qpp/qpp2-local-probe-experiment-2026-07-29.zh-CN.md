# QPP2 局部探针实验（2026-07-29）

[English](qpp2-local-probe-experiment-2026-07-29.md) | [简体中文](qpp2-local-probe-experiment-2026-07-29.zh-CN.md) · [术语](qpp2-local-probe-experiment-2026-07-29.terms.yaml)

> **状态：**历史研究记录。以下 `QPP1`／`QPP2` 名称只适用于该实验，不定义当前运行时开关，也不能证明当前适配器执行这些实验模型。原文列出的三个结果目录在当前 checkout 中均不存在；以下数据来自保留报告，本轮没有独立复现。当前 QPP 设计见[设计文档](../../design/retrieval-confidence-controller.zh-CN.md)。

## 实验角色定义

仅在本实验中：

- `QPP1` 预测从全局记忆池取回多宽的候选集，并选择 Fibonacci 展开档位。
- `QPP2` 不重新寻找另一个 Top-1，而是在 QPP1 候选集中对必要 evidence 与噪声排序，并控制实际展示给 Agent 的上下文。

评价目标不是单纯增加候选数量，而是在固定输出条数或 token 预算下提升官方 evidence recall。

## 第一性原理约束

如果第二阶段仍使用完全相同的文档向量和余弦函数，把全集限制为 Top-K 并不会改变 `cos(query, document)`，排序也不会改变。局部 softmax 或 z-score 归一化只会改变分数尺度，不会凭空产生新信息。

因此，列表级局部探针至少需要一种与候选集合相关的信号：

1. 候选之间的语义相似度；
2. 候选节点之间的图连接；
3. 独立 reranker 或 cross-encoder；
4. 局部统计，例如 local IDF、中心化或白化；
5. 在候选集合上做二阶相关传播。

原型采用二阶传播：

\[
r_i^{(2)} = \alpha r_i^{(1)} + (1-\alpha)\sum_j \operatorname{softmax}_j\left(\frac{\cos(d_i,d_j)}{T}\right)r_j^{(1)}
\]

可微控制器将直接相关度、候选集内相似度、二阶支持、图连接和查询意图作为特征。为避免未成熟的 QPP2 破坏高置信结果，它保留第一阶段的 15 条安全锚点，只让 QPP2 从扩展区域选择其余 5 条。

## 初始实验协议

- 数据：LoCoMo，每类 30 个问题，共 150 个。
- 多跳定义：官方 category 1。
- Evidence 标签：LoCoMo 官方 evidence IDs。
- 向量：`BAAI/bge-small-en-v1.5`。
- 训练／验证：五折分层交叉验证。
- LLM 调用：无。
- 候选上限：50。
- 对比输出：固定 Top-20、动态 QPP1 档位、QPP1 + QPP2、全部 50 个候选。

报告列出的结果目录为 `evals/controller/results/2026-07-29T09-28-10.616Z`。

### 全部 150 个问题

| 策略 | Evidence recall | 平均记录数 | 平均估算 token |
| --- | ---: | ---: | ---: |
| 固定 Top-20 | 0.2567 | 20.0 | 9,145 |
| 动态 QPP1 档位 | 0.4439 | 34.2 | 15,618 |
| QPP1 + 可微 QPP2 | 0.2639 | 20.0 | 9,126 |
| 基于多样性的局部选择 | 0.3183 | 20.0 | 9,132 |
| 完整 Top-50 | 0.5911 | 50.0 | 22,779 |

### 官方多跳类别

| 策略 | Evidence recall | 平均估算 token |
| --- | ---: | ---: |
| 固定 Top-20 | 0.1167 | 9,124 |
| 动态 QPP1 档位 | 0.2444 | 15,493 |
| QPP1 + 可微 QPP2 | 0.1361 | 9,109 |
| 基于多样性的局部选择 | 0.1417 | 9,009 |
| 完整 Top-50 | 0.3389 | 22,752 |

在相同的 20 条输出预算下，QPP2 只有很小的正向信号。学习策略不如简单的节点多样性选择，也没有保留 QPP1 扩大候选池后得到的大部分 recall 收益。因此实验决定继续将它留在 shadow／研究状态，而不进入 Pi 默认路径。

## 列表内聚假设检查

报告对 27 个至少有两条官方多跳 evidence 的问题直接比较 BGE 向量：

- evidence-evidence pair：64；
- evidence-noise pair：3,354；
- evidence-evidence 平均相似度：0.8699；
- evidence-noise 平均相似度：0.8495；
- 平均间隔：0.0204。

平均而言，证据之间略微更内聚，但信号弱且分布大量重叠；单一阈值无法可靠去噪。桥接 evidence 也可能语义互补而不是文本相似，因此图路径、实体覆盖和多样性不能被纯相似度替代。

## 报告记录的文献定位

报告列出了 post-retrieval/listwise/groupwise QPP、retrieval coherency、context-aware reranking、分数大小与方差、query-specific reranking depth 等相关方向。它引用 *Groupwise Query Performance Prediction with BERT*，称其联合建模 Top-K 排名上下文，相比对应的 BERT predictor 只增加不到 1% 的计算量。

报告无法在 SIGIR 2023 官方论文列表中核实“Second-order Relevance 作为局部 QPP、提升 15–20%”这一具体归因。它找到一篇同名 2021 年电商搜索论文，使用 query-product 行为图并报告平均 4.3% 的离线增益。该论文可作为邻域传播的动机，但不是 NMG QPP2 的实验依据。本轮文档整理保留了这些外部引文记录，但没有重新核验。

## 当时记录的决策

1. 保留 QPP1 候选宽度学习，因为它在测量的多跳子集中显示出 recall 增益。
2. 将实验版 QPP2 定义为受候选集合条件约束的必要 evidence 选择，不再描述为“重新找 Top-1”。
3. 当时的可微 QPP2 只记录 shadow 决策，不改变 Pi 正式上下文。
4. 保留高置信安全锚点，除非交叉验证证明全量重排不会退化。
5. 先比较简单、可解释的集合策略：query relevance + node coverage、二阶传播、图路径，以及小型 cross-encoder reranker。
6. 只有 QPP2 在相同 token 预算下可靠优于固定 Top-K，才接入 Pi。

这些是历史实验决策，不是当前运行时契约。

## Pairwise QPP2 与动态压缩：150 题复测

后续实验使用 pairwise hard-negative 训练 QPP2：对每条官方 evidence，要求其必要性分数高于第一阶段列表中排名较高的噪声。该目标学习列表内排序，不校准绝对概率。

在相同的 150 题 LoCoMo 协议下，QPP1 完整展开平均为 34.11 条记录、15,584 个估算 token，evidence recall 为 0.4556。按 QPP2 局部概率质量动态截断的结果如下：

| 保留局部质量 | Evidence recall | 相对完整 QPP1 的 evidence 保留率 | 记录压缩 | Token 压缩 |
| ---: | ---: | ---: | ---: | ---: |
| 90% | 0.3406 | 87.33% | 21.07% | 21.27% |
| 95% | 0.3672 | 90.67% | 11.70% | 11.83% |
| 98% | 0.4472 | 99.00% | 4.51% | 4.57% |

报告列出的目录为 `evals/controller/results/2026-07-29T09-37-15.222Z`。98% 档接近无损，但压缩收益较小；90–95% 档节省更多上下文，同时损失了不可忽略的 evidence。报告因此建议按 query-level confidence 标定，而不是固定一个档位。

## 全量 LoCoMo evidence 测试

完整测试使用 1,982 个带官方 evidence IDs 的 LoCoMo 问题、共 2,814 条标注 evidence；保留 BGE、五折交叉验证、80 个 epoch 且不调用 LLM 的协议。报告列出的目录为 `evals/controller/results/2026-07-29T09-49-23.691Z`。

### 总体结果

| 策略 | Macro evidence recall | 平均记录数 | 平均估算 token |
| --- | ---: | ---: | ---: |
| 固定 Top-20 | 0.3441 | 20.0 | 9,005 |
| 动态 QPP1 搜索池 | **0.5204** | 34.0 | 15,282 |
| QPP1 + QPP2 90% | 0.4294 | 25.1 | 11,278 |
| QPP1 + QPP2 95% | 0.4511 | 27.3 | 12,274 |
| QPP1 + QPP2 98% | 0.4887 | 29.5 | 13,283 |
| Top-50 候选上限 | 0.7010 | 50.0 | 22,474 |
| Oracle Fibonacci | 0.7010 | 20.4 | 9,205 |

QPP1 比 Top-20 高 17.63 个百分点，逐题配对中赢 400、输 0、平 1,582。由于当时的 QPP1 基本只扩大而不缩小候选池，这说明扩大候选池在该次运行中找回了 evidence；它不能证明控制器学会了准确分配逐 query 预算。

在 1,559 个只有一条官方 evidence 的问题中，Top-20、QPP1、QPP2 98% 的 recall 分别为 39.13%、58.50%、55.04%。在 423 个多 evidence 问题中，macro recall 分别为 17.01%、28.23%、26.14%。官方 category 1 多跳问题中的对应结果分别为 14.29%、23.89%、21.50%。

### QPP2 压缩

相对于 QPP1 完整可见集：

| QPP2 档位 | Evidence 保留率 | 记录压缩 | Token 压缩 |
| ---: | ---: | ---: | ---: |
| 90% | 89.88% | 26.06% | 26.07% |
| 95% | 92.27% | 19.56% | 19.56% |
| 98% | 96.31% | 12.96% | 12.97% |

98% 档在 1,982 个问题中有 77 个至少损失了一部分 QPP1 已找回 evidence，其余 1,905 个持平。报告因此不建议将它设为默认路径：实验展示了列表压缩能力，但尚未达到默认激活要求的近无损安全性。

### 预算置信度诊断

报告中，QPP1 预测预算与 oracle Fibonacci 预算的相关性只有 `0.0205`，档位平均绝对误差为 `20.33` 条：

- 420 个问题分配不足；
- 1,205 个问题分配过多；
- 357 个问题与 oracle 一致。

Oracle 平均只需 20.4 条记录就达到 Top-50 的 `0.7010` recall；QPP1 使用 34.0 条记录，recall 为 0.5204。报告的核心结论是：原则上应以可变预算取代固定 Top-K，但这组测量中的置信度信号还不能可靠地逐 query 分配预算。

报告提议标定 query-level evidence 完整性概率，并共同报告校准误差、预算与 oracle 的相关性以及 recall-token 曲线。QPP2 应继续作为 shadow 压缩器，直到 evidence 保留率达到预定安全阈值。

### 报告记录的训练与运行成本

- corpus preparation：8.4 秒；
- query preparation：284.2 秒；
- 最终 QPP1 训练：21.8 秒；
- 五折 QPP1/QPP2 预算训练：1,021.1 秒；
- training steps：956,160；
- embedding requests：3,984；
- embedded texts：104,457；
- LLM 调用：0。

报告将离线训练耗时主要归因于未批处理的 pairwise QPP2 计算，而非在线推理；它报告 QPP2 在线评分平均约 2.06 ms，并建议下次大规模训练前先批处理 pairwise loss 或加入可恢复检查点。

## 历史提案：可变检索池与可见集

原补充材料提出以下分工：

```text
QPP1：估计当前候选池是否覆盖回答所需信息
  └── 不充分时按 Fibonacci 档位扩展搜索池

QPP2：估计候选内容是否值得完整展示
  └── 保留必要 evidence，并压缩已扩展但更像噪声的内容
```

提案建议使用可变搜索池与可见集，而不是固定 Top-20：

\[
K_{search} = \min\{k : \Pr(\text{evidence complete}\mid q,R_{1:k}) \geq \tau_s\}
\]

\[
R_{visible} = \{r_i \in R_{1:K_{search}} : \Pr(\text{necessary}_i\mid q,R_{1:K_{search}}) \geq \tau_v\}
\]

该提案还保留最小安全前缀、record/token/latency 上限、冲突与用户固定约束的保护，以及渐进扩展而非直接跳到固定大池。它也提醒：pairwise QPP2 分数是排序，不是已校准概率；若要取消固定 Top-K，须在留出集上做校准，并报告 evidence 保留率、压缩率、校准误差与不同 query 类别中的最坏 recall 损失。

这些公式与提案属于历史研究，不是当前产品语义。当前行为见[QPP 设计](../../design/retrieval-confidence-controller.zh-CN.md)和[渐进召回契约](../../design/fibonacci-progressive-recall.zh-CN.md)。

原文引用的三个结果目录在当前 checkout 中均不存在：`2026-07-29T09-28-10.616Z`、`2026-07-29T09-37-15.222Z` 与 `2026-07-29T09-49-23.691Z`。上述测量是保留报告中的数值，不是本轮新验证的结果。