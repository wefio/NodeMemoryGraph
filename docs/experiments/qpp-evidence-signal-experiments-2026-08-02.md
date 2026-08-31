# QPP 证据信号实验：top1 差距 / 内聚性 / LLM 充分性判断（2026-08-02）

> 背景：自动召回（`nmg_automatic_recall`）用 QPP（`src/core/qpp.ts`，NQC 变体
> `C = Top1 + 0.3·variance + 0.3·intentCoverage + 0.2·reasonHealth`）决定是否触发
> 第二趟渐进召回。用户假设：单条证据的问题 top1 应与其余结果显著拉开；多条证据
> 的问题中"证据-证据"相似度应远大于"证据-噪声"。实测验证（协议对齐
> `locomo-evidence-mode-signal-2026-08-02.md`：标签仅用于评估、无 LLM 时零模型调用）。

## 实验一：扩展信号审计（`evals/omnimemeval/research/audits/audit-evidence-mode-signal-v2.py`）

协议：LoCoMo `locomo10.json` 1978 个有证据标签的问题；record 级 BGE-small 向量；
三路（原始 + Top1 反查 + QPP2 反查）加权 RRF@20；五折按会话分组；标签不进检索/特征。

特征 = 原 7 个基线 + 假设 A 的 5 个（NQC 归一化离散度、相对 top1 margin、top1/均值、
top1 z-score、softmax 质量差）+ 假设 B 的 4 个（列表内聚、top1 邻域、top1 孤立度、列表-查询相关）。

| 特征 | multi_evidence AUC | complete@20 AUC |
|---|---:|---:|
| top1（基线，绝对分） | 0.466 | 0.564 |
| gap（基线，绝对差） | 0.471 | 0.580 |
| **nqc**（归一化离散度，新） | 0.470 | **0.667** |
| t1_over_mean（新） | 0.458 | 0.664 |
| qpp2_top1_mass（基线） | 0.456 | 0.655 |
| mass_gap（新） | 0.464 | 0.611 |
| t1_margin_rel（新） | 0.474 | 0.578 |
| t1_zscore（新） | 0.469 | 0.573 |
| list_coherence（新，内聚） | 0.485 | 0.438 |
| top1_neighbourhood（新） | 0.477 | 0.455 |
| top1_iso（新） | 0.523 | 0.545 |
| list_query（新） | 0.482 | 0.474 |
| 全特征 logistic 融合 | 0.513 | 0.667 |

**假设 A 判定**：所有 top1 离散度特征对 multi-evidence 的 AUC 均在 0.46–0.52（≈随机）。
**假设 A 修正**：同一族信号对 complete@20 有效，**NQC 归一化离散度是最佳单特征（0.667）**
——即"top1 显著高于其余"预测的是"检索质量好（证据完备）"，不是"证据数量"。

**假设 B 判定**：无标签 proxy（列表内聚等）对两个目标都弱（0.44–0.55）。

标签诊断（110 个可见列表含 ≥2 条证据的多证据问题）：
- 证据-证据平均相似度 0.808 vs 证据-噪声 0.761，间隔 +0.047，**85.5% 为正**（假设 B 的
  分布假设在多证据问题上成立）；
- 该间隔预测 complete@20 的 AUC = **0.657**（接近 NQC，但需要标签才可观测，不能做在线特征）。

## 实验二：LLM 充分性判断（`evals/omnimemeval/research/probes/probe-llm-sufficiency.py`）

协议：同检索管线 top-12；平衡抽样 150 题（75 单条 + 75 多条，每会话 ≤8）；
deepseek-chat（deepseek-v4-flash，temperature 0）判断"检索到的记录是否足以回答问题"，
输出 `{sufficient, confidence}`；标签仅用于评估。

| 目标 | 分布 | confidence AUC | 二值 AUC | 混淆 (TP/FP/TN/FN) | 平衡准确率 |
|---|---:|---:|---:|---:|---:|
| multi_evidence | 46.7% | **0.508** | 0.463 | 8/15/65/62 | 0.463 |
| complete@20 | 28.7% | **0.732** | 0.670 | 17/6/101/26 | 0.670 |

- LLM 的充分性判断**同样预测不了证据数量**（0.51）——与实验一、与 v1 audit（0.513）三方一致。
- LLM 充分性判断预测证据完备性显著优于任何检索信号：**confidence AUC 0.732 vs 检索最佳
  NQC 0.667**（+10pp）。
- 风险：sufficient 但实际 incomplete 共 6/150（占"足够"判断的 26%，方向偏保守——fn 26
  多于 fp 6，即模型更多地说"不够"而不是"够但缺证据"）。
- 成本：76,070 prompt + 6,831 completion tokens（≈82K tokens ≈ 0.5 元人民币，150 次调用）。

## 结论

1. **"预测证据数量"应放弃**：三重独立证据（v1 audit 0.513、v2 全部检索特征 0.46–0.52、
   LLM 0.51）一致表明检索信号/LLM 判断都区分不了单条/多条证据。证据数量是信息需求属性，
   与检索质量信号无映射。不要将 `single`/`multi` 作为 NMG 断言信号暴露。
2. **"预测证据完备"可行且已有明确最优**：LLM 充分性判断（0.732）> NQC 归一化离散度（0.667）
   > 现有 qpp2_top1_mass（0.655）。LLM 路线每次召回约 +500 token 成本，可按查询风险选择性启用。
3. **假设 B 的在线价值有限**：证据内聚间隔需知道"谁是证据"才可观测，proxy 版无效；其
   0.657 的 complete 预测能力可作为**事后诊断/审计**指标，不做在线触发特征。
4. **落地建议**：
   - 低成本：把 `nqc`（top-k 分数标准差 ÷ 检索池分数均值）加进 `composeQpp`，shadow 记录
     后离线重算验证（实验一已证其为最佳检索单特征）；
   - 中成本：`nmg_automatic_recall` 的第二趟触发从"检索信号阈值"升级为"LLM 充分性判断 +
     检索信号兜底护栏"，护栏沿用现有 guardrail（空集 / all-fallback / top1 过低）；
   - 无论哪种，继续保留 complete@20 的 shadow 评估，用 ECE/选择性风险度量校准后决定是否
     接入 Pi 适配器。

结果 JSON：`evals/results/locomo-evidence-mode-signal-v2.json`、`evals/results/llm-sufficiency-150.json`。

---

## 阶段三：动态推荐机制评测与设计收敛（2026-08-02）

### 实验环境与基础设施

- LoCoMo `locomo10.json`（1986 题，按会话分组 ingest，每 turn 一条 record，tier=2，
  `scope.diaId` 标注证据）；本地 BGE-small 语义检索（qwen3 模式，纯向量，L2 归一化）。
- 新增基础设施：`evals/omnimemeval/research/audits/audit-elbow.ts`（每题输出分数序列 + 真实命中位置）、
  `evals/results/elbow-data.json`；embedding SQLite 缓存 + store 持久化
  （`evals/results/embedding-cache.sqlite`、`audit-stores/`），重跑约 5 分钟。

### 通用规律（不依赖具体数据集形状）

1. **Scale law 形状普适**：fixed top-K 的 recall ≈ c·K^α（α≈0.5，幂律 R²=0.995），
   边际收益单调递减（4→0.7 pp/条），噪声随 K 线性增长——任何检索器都有长尾衰减，
   因此"每条线索的价值递减"是普适的决策前提。
2. **无监督分布统计在语义检索下不可行**（三条路一致证伪）：
   - 断点（elbow）检测：语义余弦分数平坦（top1-top2 gap 中位数 1.25%）、证据/噪声
     判别力仅 2.2%，无悬崖 → argmax(gap) 恒落 rank 1-3，与真实所需条数 Spearman≈0.05；
   - Adaptive-k 完整版（argmax gap + 缓冲 + 约束）：退化为"常数 K + 常数缓冲"，
     与 fixed K 覆盖等价——因为断点位置无信息，缓冲成了实际控制量；
   - 结论：**"从相似度分布无监督猜所需条数"在对话记忆检索上不可行**，任何算法形态
     都不行；文献中的成功案例（Adaptive-k 等）依赖长文档 QA 中相关/不相关分数的真实
     悬崖，分布形态不同。
3. **唯一有效的无监督极端信号**：相对 top1-top2 gap > 5%（真悬崖）的查询中位所需条数
   ≈3——只有真单证据查询才触发；top1 分数本身无判别力（高 top1 时所需条数仍可达 7）。
4. **追加 = 消费者模型驱动的爬档**：证据充分性判断（已证 LLM 0.732 > NQC 0.667 >
   检索信号）应该由读了内容的 agent 完成，NMG 不内建 judge；QPP 自动爬档降级为
   guardrail（空集 / all-fallback / low-top1）。

### 落地机制（机制通用，参数可配置）

- 首趟量 = `initialEvidenceTarget`（可配置：search options / `NMG_AUTO_RECALL_INITIAL_TARGET`），
  默认值本身不构成设计主张——验收线是"优于固定 top-20"，默认值只是该验收下的一个
  工作点，任何环境可用旋钮调整；
- 强单证据信号：`topGap ≥ STRONG_HIT_TOP_GAP` → 首趟 1-3 条（进 `QppComponents` shadow）；
- MEMORY_POLICY 授权 agent"证据不足可请求追加 / 忽略无关噪声头"；
- 扩展默认开 `secondPass: true`（生产路径从固定 top-K 切换为动态推荐）。

### 验收（vs 固定 top-20，LoCoMo 1986 题，oracle 追加上界）

| 指标 | top-20 | 方案 | 差异 |
|---|---|---|---|
| records（token 代理） | 20.00 | 14.44 | **-27.8%** |
| 噪声条数 | 19.51 | 13.94 | **-28.6%** |
| 证据覆盖 | 0.389 | 0.397 | **+0.8pp** |

77% 查询一次到位（追加率 22.9% 为 oracle 上界，真实 LLM 判断更保守）；5.9% 查询
（真单证据）首趟 3 条。**token 更少、噪声更少、覆盖不劣化，全面优于 top-20。**

### 关键结论

1. **固定档位序列（Fibonacci / 等收益 / 等间隔）都数据相关**；benchmark 分布 ≠ 真实
   数据分布，任何从单数据集学出的数值只做参考、必须可配置。
2. **不追求精确预测 K_need**（三重证据证伪：检索信号 0.5 / LLM 0.51）——动态推荐的
   价值是"降到效率甜点 + 强信号极端少给 + 消费者模型追加兜底"，不是预言所需条数。
3. **验收标准是相对基线**（优于 top-20），不是绝对最优——机制有效即可，参数留给环境。
