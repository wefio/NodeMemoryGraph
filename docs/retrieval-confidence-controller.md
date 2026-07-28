# QPP × 可微计算图：触发式召回

> 状态：设计提案（未实现），不改动 `src/`。

## 定位

检索置信度不是新发明——它是 IR 里的 **post-retrieval QPP**（Query Performance Prediction）预测器；τ 触发是 **QPP-thresholded adaptive retrieval**。既然未实现，直接叫 **QPP**（代码标识 `qpp`，公式符号 `C`），不再造 `recallConfidence` 这个名。下文对齐已有研究，定三阶段演进。

## 要做什么

把检索从"固定拉 top-K"改成：**首趟召回后算 QPP → 低于阈值就触发第二趟搜索 + 扩池 5–10 条 → 搜索结果与原召回记忆汇入统一池由 LLM 综合**。触发决策交给可微计算图（`DifferentiableController`），不碰 MGR，不依赖 LLM 配合。

## 为什么

- 弱类（preference 0.16 / multi-hop 0.42 / sensitive 28.6%）本质是"推荐/综合"任务，低绝对分是任务性质，真实成绩看 delta（整体 +44.3）。
- 证据审计铁证：证据全命中 89.67%，部分命中掉到 16.67% —— 瓶颈是**召回覆盖**，不是排序或综合。
- 多跳能力本就支持（`graphHops=1` + 弱 reader 不主动搜导致休眠），问题在"默认不触发"，不是"做不到"。
- 全局加预算（K=20→40 仅 +1.6pt）收益递减，边际预算应集中给真正需要的多跳查询。

## 红线

触发 = **系统侧、非 LLM**。绕开"弱 reader 不主动搜"的病根，跨所有阶段成立（硬规则 / 代理损失 / Gumbel-Sigmoid DC 都是系统侧）。因此显式跳过 Self-RAG（LLM 自发 reflection token，需强模型微调，弱 reader 不触发）与 FLARE（生成侧触发，不同轴，见"不做什么"）。

## 怎么做

### 0. 归一化前置（任何 score-based QPP 的前提）

`hybridScore`（`search-ranking.ts:53-55`）= 0.5·boundedLexical + 0.35·vector + 0.15·route 是**手设权重、未归一化**（lexicalScore 可达 10+，vector/route∈[0,1]，量纲不一）。算 QPP 前必须 **Z-score 跨候选集归一化**各通路分数，否则 top1 与方差跨量纲无意义。`contextUsefulness`（`search-ranking.ts:5-25`）= `combinedScore + bonus`，bonus 可使值 >1（preference +0.3）→ clamp 到 1.0 饱和。RankSVM 学通道组合权重是手设 0.5/0.35/0.15 的 supervised 版，与 DC 学 QPP 分量权重平行（Stage 2 可一并接管）。

### 1. 算 QPP（post-retrieval，learned-weight）

公式（Stage 1 起采用，替代原手设 `0.5*topScore+0.3*intentCoverage+0.2*reasonHealth`）：

```
C = z(Top1) + τ_v·z(variance) + w_ic·intentCoverage + w_rh·reasonHealth
```

这是 **learned-weight NQC 变体**（Top1 锚定 + 方差项 = score-based QPP 族），不是手设先验。高 C = 不触发，低 C = 触发。

**三信号按失败模式正交选取**（推导依据，非拍脑袋）：

| 分量 | 检测的失败形态 | 评测佐证 |
|---|---|---|
| `Top1` | 一条强匹配都没有 | 无证据→7.45%，检索没捞到东西 |
| `variance` | 分布扁平、无清晰赢家（NQC 族信号，非 raw max） | 部分证据→16.67%，匹配是噪声填充 |
| `intentCoverage` | 捞到了但类型错（要 preference，全是 fact） | preference 0.16 / assistant 0.29 |
| `reasonHealth` | 匹配是假的（三路全 ≤0 的兜底塞入） | hybrid_match 是 recallReason 红灯 |

权重排序依据：`Top1` 最 informative（单信号即可否决触发）；`variance` 是 NQC 族核心、抓"分布形状"；`intentCoverage` 抓 `Top1` 盲区（高分但类型错）故独立值钱；`reasonHealth` 与 `Top1` 部分冗余（弱匹配大概率即 hybrid_match）故最低。**具体数值靠学，非手设**：Stage 1 贝叶斯优化，Stage 2 DC 梯度。

**分量精确口径**（从 `trace.selections` 算，即过预算后存活的 top-K——LLM 实际所见）：
- `Top1` = `clamp(max(selections.scores.usefulness), 0, 1)`；`scores.usefulness` 见 `store.ts:1383`。
- `variance` = top-K 归一化分标准差（NQC 族，须归一化后算；高方差双解——清晰赢家 vs 噪声离群——归一化缓解）。
- `intentCoverage`：3 族意图正则→期望类型（`search-ranking.ts:9-23`：`list/count`→derived/event/fact/state；`recommend/suggest/preference`→preference+constraint；`assistant/you said/previous`→conversation_evidence）；coverage = 命中族中"期望类型确实出现在 top-K"的比例；**不命中任何正则→取中性 0.5**（不冤枉单跳事实题，不能取 0）。
- `reasonHealth` = **仅 direct 选择项**中 `reason≠hybrid_match` 的比例（剔除 graph_expansion：其三路分恒 0，计入会把好召回拉成 0）；`recallReason` 见 `search-ranking.ts:72-84`，现仅 debug 用，正好接上。
- 空结果 → C=0（必触发，正确）。

**别混淆**：这是"检索充分度"，与 `store/schema.ts:53` 的 `confidence` 列 / `types.ts:62,120` 的 `MemoryRecord.confidence`（每条记忆的**抽取可信度**）是两回事。

### 2. 触发决策（系统侧，三阶段）

**Stage 0 — plumbing + guardrail floor**
最简硬条件（`Top1 < floor` 或结果空 → 触发）验证第二趟检索 + `expandedMaximum` 预算 + 统一池管道通畅；立**永久 guardrail floor**（Stage 1/2 学化门控说"不触发"但结果灾难性空/全 hybrid_match → 无论如何触发）。价值在验证管道，非决策质量。原"手设 0.5/0.3/0.2 公式 + 手设 τ"的 Stage 0 **砍掉**——与 Stage 1 代理公式重复且更差。

**Stage 1 — 代理损失（工程首选）**
`C` 如上；权重 `τ_v / w_ic / w_rh` 用**贝叶斯优化 / Optuna 黑盒**在 trace feedback（`trace.usefulMemoryIds / rejectedMemoryIds / contradictedMemoryIds`，见 `controller-protocol.ts:89-100`）上学；触发阈值手工设 + **rolling-window 校准**（近期高 C 结果实际 usefulness 下降 → 降阈值扩探索池，不死守）；DC 仍 shadow。轻量、解耦、近端到端。

**Stage 2 — Gumbel-Sigmoid DC**
阈值本身可微学化（Gumbel-Sigmoid 松弛 0/1 硬开关，梯度回传）；`Loss = 生成Loss + λ·搜索成本惩罚`；DC 出 shadow，取代手工/黑盒阈值。Soft-Hard（REALM/可微 RAG，softmax top-k→注意力→与生成向量融合）太侵入（改 retrieval→gen 接口，NMG 返回 context 非融合向量），列替代不主推。

**τ 标定方法**（Stage 0/1 起点阈值）：eval traces 采 (C, 证据完整性) 对；full-evidence（89.67% 批）=正、partial-evidence（16.67% 批）=负；τ = 使 partial-evidence 召回率 ≥ 目标（如 0.8）的阈值下限，扫 0.4–0.5。

### 3. 接入计算图本体（落点已就绪，近乎免造）
- `differentiable-controller.ts:14` 已内置 `ControllerAction="expand"|"stop"`，`:3-11` 有 `CONTROLLER_BUDGET_DIMENSIONS`。
- `controller-runtime.ts:107-148` `allocate()` 在 `action==="expand"` 时解锁 `expandedMaximum` 预算信封（独立预算、有上限）。
- `ControllerRuntime` 当前只在 `index.ts` 导出、**未接入 `store.ts` 实时循环**；集成 = 在首趟候选边界调用 `runtime.allocate()` 并按 `action` 行动。
- 把 `qpp` 及其分量作为新 feature 喂 `globalFeatures`（`controller-protocol.ts:19-52` 加 `qpp / top1 / score_variance / intent_coverage / reason_health`，协议版本 1→2）；DC 过 gate 后从 globalFeatures 学化取代黑盒/手工权重与阈值。`globalFeatures` 全是标量统计量（`:140-173`），DC 在其上学习——梯度停在特征层，不穿过 ANN top-K 回传 embedder。

### 4. 预算与池
- 搜索走 `expandedMaximum` 独立信封（有上限，不撑爆上下文）。
- 三层结果汇入统一池；**provenance 留系统侧，LLM 不该知道"这是搜来的"**。
- 候选步按置信度自适应省 token，但过度裁剪会裁掉补全答案的那条，须保守（证据审计：部分证据→16.67% 崩，收缩仅在全证据时才缩）。

## 不做什么

- **不训练/不引入 embedding 模型**：代理损失与 Gumbel-Sigmoid DC 都在检索已产出的分数上运作；DC 梯度停在 `globalFeatures` 标量层，穿不过 ANN top-K（选择不可微，differentiable retrieval 已知断层）回传 embedder。与 park 自研 MiniMind encoder 自洽——攻覆盖/触发，与 embedder 质量正交；BGE 已验证够用（0.8008 LME）。embedder 质量仅二阶影响 vectorScore→分布→QPP 信号干净度，非功能依赖。
- **不做 FLARE（生成侧 entropy 触发）**：正交轴（生成 token 熵 vs 检索分数分布），但 NMG reader 外置（deterministic AutoRecall + deepseek-v4-flash），eval 拿不到 token logprob → 当前架构障碍。列为未来互补轴；双轴置信度（retrieval QPP + generation entropy）才完整，先发 retrieval 侧。
- **不做 Self-RAG**：LLM 自发 reflection token 需强模型微调，弱 reader 不触发，违背系统侧红线。
- **不做端到端可微检索**：REALM 软索引太侵入，拒。

## 风险

- τ 必须标定 + 滚动校准，否则错位置 firing 或漂移。
- `variance` 高双解（清晰赢家 vs 噪声离群）——靠归一化缓解，标定时验证。
- 经典 QPP 在 dense/neural IR 上相关性掉 10%+（文献）；NMG 用 BGE dense+hybrid，靠 `intentCoverage`/`reasonHealth` 领域增强补偿——这两项是 vanilla QPP 没有的 typed-memory / provenance 信号，非冗余。
- 只攻"覆盖"半；"捞进来没排对/拼对"的 ranking/composition 半需另打，两者配套才完整。
- DC 过 gate 前不可启用学化路径（Stage 2），Stage 1 黑盒权重不等于梯度学化。
