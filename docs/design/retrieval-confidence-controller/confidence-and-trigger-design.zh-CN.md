# QPP 分数、渐进触发与控制器接线

[English](confidence-and-trigger-design.md) | [简体中文](confidence-and-trigger-design.zh-CN.md)

**Authority：**[父文档范围](../retrieval-confidence-controller.zh-CN.md)。

## 当前分数与触发

QPP 会用 `hybridScore(scores.lexical, scores.vector, scores.route)` 重算每个候选的强度，不使用 `combinedScore` 或 `usefulness`：这些值在不同检索路径上的量纲可能不同。重算后的强度限制在 `[0,1]`；基于分数的分量只使用 direct selections，不使用 `graph_expansion` selections。

当前分数为：

```text
C = Top1 + 0.5 × NQC
NQC = clamp(stdev(direct strengths) / mean(direct strengths), 0, 1)
```

`Top1` 是 direct strength 的最大值。direct 候选少于两条或均值接近零时，`NQC` 为 `0`。`variance`、`intentCoverage`、`reasonHealth`、`topGap`、`expansionDependence` 和 `expansionRisk` 会作为诊断结果返回，但不参与 `C`。因此，早期把 variance、intent coverage 和 reason health 加权相加的公式并非当前运行时分数。

默认阈值为 `0.55`；`C < threshold` 时触发 `below_threshold`。确定性的 guardrail 不依赖该阈值，以下情况会直接触发：

- 没有候选：`guardrail_empty`；
- 至少有一条 direct 候选且 `reasonHealth === 0`（每条 direct 候选都是 `hybrid_match` fallback）：`guardrail_all_fallback`；
- `Top1 < 0.2`：`guardrail_low_top1`。

这些规则估计的是检索充分性，不是答案真伪。`reasonHealth` 是 reason 不等于 `hybrid_match` 的 direct selection 占比；没有识别到 query-intent family 时，`intentCoverage` 取中性值 `0.5`。

## 渐进重选

第二趟从同一个过采样候选池重选累计 Fibonacci 前缀，不会再次发起 ANN/FTS 搜索。当前遍历保持原始 graph-hop 上限；更大的 evidence envelope 不表示会逐档重跑 relation expansion。

- `initialEvidenceTarget` 默认 `13`。若 `Top1` 相对 `Top2` 的差距至少为 `0.05`，初始目标会降至至多 `3`（`strongHitInitialTarget`）。
- 目标仍必须是 Fibonacci 档位。调用方的 `limit` 是硬上限；系统不会合成中间档位。若上限低于初始档位，就不会访问该档位。
- 在访问到的档位上，QPP 认为充分时停止。候选池耗尽、调用方上限或扩展 evidence 预算也会使遍历停止。`QppTriggerDecision.expansion` 记录访问的目标、选中数量、估算 token、判定和停止原因，不记录每档的 memory ID。

### 调用方专属激活

| 调用方 | 默认值 | 含义 |
| --- | --- | --- |
| `searchContext()` | `secondPass` 关闭 | 会计算初始 QPP 判定，但只有选项为 true 才遍历后续档位。 |
| `searchContextWithSecondPass()` | `secondPass` 开启 | 便捷包装方法；显式选项可以覆盖默认值。 |
| CLI `nmg search` | 关闭 | 使用 `--second-pass` 显式启用。 |
| Pi extension | `NMG_QPP2_MODE=off` | QPP2 active 会启用渐进检索并尝试 learned fold；fold 仍需要可执行动作的控制器通道。 |
| `OmniMemEvalBridge` | `secondPass` 开启 | 构造选项可以覆盖这个仅适用于评测桥接器的默认值。 |

不要把某个调用方的默认值理解成产品全局默认。Pi 的 `NMG_QPP1_MODE` 是另一项配置：默认 `shadow`；只有显式 Pi 搜索处于 active 且调用方没有提供 `limit` 时才接入 allocation，返回的预算仍受硬上限约束。

## 标定与证据边界

`DEFAULT_QPP_WEIGHTS` 将 NQC 系数固定为 `0.5`；`DEFAULT_QPP_THRESHOLD` 为 `0.55`。两者都是保守但未完成标定的运行点，不是经 matched 验证的生产最优值。默认初始目标 `13` 来自有限的 LoCoMo 测量，详见[渐进召回](../fibonacci-progressive-recall.zh-CN.md)。

2026-08 LoCoMo 信号实验按 session 分组切分。归一化离散度特征对 `complete@20` 的 AUC 为 `0.667`，对 `multi_evidence` 的 AUC 为 `0.470`；这些结果既不能证明能预测证据数量，也不能外推到该样本之外。详见[实验记录](../../experiments/qpp/evidence-signal-experiments-2026-08-02.md)。

[`tau-worker.ts`](../../../evals/controller-shadow/tau-worker.ts) 只写入候选产物，不修改运行时配置。它使用带显式 `expansionUseful` 标签的样本，按时间顺序切分 train/validation，要求至少 50 条总样本、至少 10 条 validation 样本、两份切分中均同时存在正负标签；阈值单次最多移动 `0.05`，并检查 held-out balanced accuracy。产物始终报告 `eligibleForActivation: false`；默认阈值仍为 `0.55`（调用方可以通过搜索选项显式覆盖）。

## 可学习控制器的执行边界

`ControllerPolicyChannel` 将评分与执行动作分开。`NMG_CONTROLLER_RUNTIME_MODE` 默认 `shadow`；`shadow` 可以评分，但不能 allocate、fold 或 rerank。`controlled` 要求已训练候选和 `NMG_SHADOW_COLLECTION_ORIGIN=controlled`。`active` 还要求 activation receipt 绑定候选 hash、feature protocol、retrieval/controller/product gate 产物，以及不同于候选且可加载的 rollback target。

Pi 的 `ControllerShadowBridge` 是可选适配器，不是通用检索路径。它的 `allocate()` 只用于 QPP1 处于 active 且调用方未提供 `limit` 的显式 Pi 搜索。daemon 的 Lab 操作 `controller_shadow` 则被固定为 shadow 模式。这些路径不会使研究标定自动成为默认，也不能证明存在在线训练循环。

## 非目标

- 不根据分数推断问题需要 `single` 还是 `multi` evidence；引用的实验显示该目标接近随机。
- 不把答案文本重合、注入或读取当作正向训练标签。应依照相应数据契约使用可归因的明确反馈或验证过的 evidence。
- 不把 QPP 等同于 `MemoryRecord.confidence`、答案正确性，或读者会使用每条返回记录的保证。

## 源码参考

核心分数与遍历位于 [`qpp.ts`](../../../src/core/qpp.ts) 和 [`retrieval.ts`](../../../src/core/store/retrieval.ts)。调用方配置见 [`config.ts`](../../../src/integration/config.ts)，评测默认值见 [`OmniMemEval bridge`](../../../evals/omnimemeval/bridge.ts)；控制器门控见 [`controller-channel.ts`](../../../src/integration/controller-channel.ts)、[`controller-shadow.ts`](../../../.pi/extensions/nmg/controller-shadow.ts) 和 [Pi extension](../../../.pi/extensions/nmg/index.ts)。