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

算 QPP 须用跨路径一致的分数。**`combinedScore` 量纲不一致**：lexical 搜索路径（`store.ts:2915`）设 = `hybridScore`（有界 [0,1]），但部分 vector 路径（`:2654`）设 = `leafScore*0.9 + lexical*0.1`（词法尺度 ~84），`#resultsForNode`（`:3684`）设 = 0。审计实测同一 hybridScore 在不同路径既出现 0.62 又出现 84。所以 QPP **不读 `combinedScore`/`usefulness`，而是从 `selections.scores.{lexical,vector,route}` 重算 `hybridScore`**（`search-ranking.ts:53-55`，恒有界 [0,1] 经 `boundedLexical`）作为 `strength`——这是 path-consistent 的，且对历史 trace（词法 84）和 live trace（0.62）都给出一致有界值。不用 squash（k 无法同时适配 0.6 与 84 两套量纲），不用 Z-score（within-set 相对值，丢绝对质量）。bonus 不进 top1（intent 类型奖励由 intentCoverage 分量单独承当，干净分离）。RankSVM 学通道组合权重是手设 0.5/0.35/0.15 的 supervised 版（Stage 2 可接管），与 QPP 分量权重独立。

### 1. 算 QPP（post-retrieval，learned-weight）

公式（Stage 1 起采用，替代原手设 `0.5*topScore+0.3*intentCoverage+0.2*reasonHealth`）：

```
C = Top1 + τ_v·variance + w_ic·intentCoverage + w_rh·reasonHealth
```

`Top1`/`variance` 基于 `strength`（重算的 hybridScore，有界 [0,1]、path-consistent，见 §0）。这是 **learned-weight NQC 变体**（Top1 锚定 + 方差项 = score-based QPP 族），不是手设先验。高 C = 不触发，低 C = 触发。

**三信号按失败模式正交选取**（推导依据，非拍脑袋）：

| 分量 | 检测的失败形态 | 评测佐证 |
|---|---|---|
| `Top1` | 一条强匹配都没有 | 无证据→7.45%，检索没捞到东西 |
| `variance` | 分布扁平、无清晰赢家（NQC 族信号，非 raw max） | 部分证据→16.67%，匹配是噪声填充 |
| `intentCoverage` | 捞到了但类型错（要 preference，全是 fact） | preference 0.16 / assistant 0.29 |
| `reasonHealth` | 匹配是假的（三路全 ≤0 的兜底塞入） | hybrid_match 是 recallReason 红灯 |

权重排序依据：`Top1` 最 informative（单信号即可否决触发）；`variance` 是 NQC 族核心、抓"分布形状"；`intentCoverage` 抓 `Top1` 盲区（高分但类型错）故独立值钱；`reasonHealth` 权重最低。**关于 reasonHealth 冗余性**：它捕获"direct 里多少比例是真匹配（reason≠hybrid_match）"，与 `Top1`（只看最强）**互补不冗余**——可能 Top1 高但 reasonHealth 低（1 强 + 多兜底）。但实测 LongMemEval 非空题 reasonHealth 恒 1.0（返回的都真），**实践可能近常数、低区分度**；标定时须做 Top1×reasonHealth 相关性分析确认其边际贡献（见 §2 标定流程）。**具体数值靠学，非手设**：Stage 1 贝叶斯优化，Stage 2 DC 梯度。

**分量精确口径**（从 `trace.selections` 算，即过预算后存活的 top-K——LLM 实际所见）：
- `Top1` = `max(clamp(strength,0,1))`，`strength = hybridScore(scores.lexical, scores.vector, scores.route)`（重算，非 combinedScore）。hybridScore 恒 [0,1]，跨路径一致。
- `variance` = `clamp(stdev(strength)*2, 0, 1)`（strength∈[0,1] 故 stdev≤0.5，*2 映射 [0,1]）。高方差双解——清晰赢家 vs 噪声离群——标定时用 Top1−Top2 差值作辅助/替代（见 §2）。
- `intentCoverage`：3 族意图正则→期望类型（`search-ranking.ts:9-23`：`list/count`→derived/event/fact/state；`recommend/suggest/preference`→preference+constraint；`assistant/you said/previous`→conversation_evidence）；coverage = 命中族中"期望类型确实出现在 top-K"的比例；**不命中任何正则→取中性 0.5**（不冤枉单跳事实题，不能取 0）。0.5 贡献 `0.5·w_ic=0.15`，偏置有界且小；标定时对"未命中正则"查询单独看分布，若系统性偏，改用 `avg(intentCoverage)` 作中性。
- `reasonHealth` = **仅 direct 选择项**中 `reason≠hybrid_match` 的比例（剔除 graph_expansion：其三路分恒 0，计入会把好召回拉成 0）；`recallReason` 见 `search-ranking.ts:72-84`，现仅 debug 用，正好接上。
- 空结果 → C=0（必触发，正确）。

**别混淆**：这是"检索充分度"，与 `store/schema.ts:53` 的 `confidence` 列 / `types.ts:62,120` 的 `MemoryRecord.confidence`（每条记忆的**抽取可信度**）是两回事。

### 2. 触发决策（系统侧，三阶段）

**Stage 0 — plumbing + guardrail floor**
最简硬条件验证第二趟检索 + `expandedMaximum` 预算 + 统一池管道通畅；立**永久 guardrail floor**（Stage 1/2 学化门控说"不触发"但结果灾难性弱 → 无论如何触发）。必触发条件（具体数值，可操作基线）：
- `totalCount === 0`（空结果）→ `guardrail_empty`
- `directCount > 0 && reasonHealth === 0`（全 hybrid_match 兜底）→ `guardrail_all_fallback`（当前权重下与 low_top1 重叠，作防学错权重的安全网留）
- `Top1 < QPP_TOP1_FLOOR(=0.2)`（hybridScore 量纲，基本没真匹配）→ `guardrail_low_top1`
- 否则 `C < τ` → `below_threshold`

价值在验证管道，非决策质量。原"手设 0.5/0.3/0.2 公式 + 手设 τ"的 Stage 0 **砍掉**——与 Stage 1 代理公式重复且更差。

**Stage 1 — 代理损失（工程首选）**
`C` 如上；权重 `τ_v / w_ic / w_rh` 用**贝叶斯优化 / Optuna 黑盒**在 trace feedback（`trace.usefulMemoryIds / rejectedMemoryIds / contradictedMemoryIds`，见 `controller-protocol.ts:89-100`）上学；触发阈值手工设 + **rolling-window 校准**（近期高 C 结果实际 usefulness 下降 → 降阈值扩探索池，不死守）；DC 仍 shadow。轻量、解耦、近端到端。

**Stage 2 — Gumbel-Sigmoid DC**
阈值本身可微学化（Gumbel-Sigmoid 松弛 0/1 硬开关，梯度回传）；`Loss = 生成Loss + λ·搜索成本惩罚`；DC 出 shadow，**取代**（非并发）Stage 1 的手工/黑盒阈值，warm-start 自 Stage 1 权重/阈值。**暴露范围**：默认只把 composite `qpp` 喂 DC globalFeatures → Stage 2 只学阈值（Stage 1 权重冻结），简单、小 eval N(≈500) 不易过拟合；数据足够时再暴露各分量让 DC 隐式再加权。Soft-Hard（REALM/可微 RAG，softmax top-k→注意力→与生成向量融合）太侵入（改 retrieval→gen 接口，NMG 返回 context 非融合向量），列替代不主推。

**τ 标定方法**（Stage 0/1 起点阈值）：eval traces 采 (C, 证据完整性) 对；full-evidence（89.67% 批）=正、partial-evidence（16.67% 批）=负；τ = 使 partial-evidence 召回率 ≥ 目标（如 0.8）的阈值下限，扫 0.4–0.5。

**标定流程**（Stage 1，审计脚本 `evals/omnimemeval/audit-qpp-signal.ts` 已可采 (qpp, outcome) 对）：
1. **相关性分析**：Top1×reasonHealth 分布（确认 reasonHealth 边际贡献，若近常数则降权）；低 qpp 是否对应 partial-evidence/错答。
2. **variance 双解处置**：人工抽高方差案例，若"清晰赢家误触发"多，用 Top1−Top2 差值替代/辅助 variance。
3. **intentCoverage 中性值**：对"未命中正则"查询单独看 QPP 分布，若 0.5 系统性偏，改 `avg(intentCoverage)`。
4. **贝叶斯优化目标**（明确标量）：`Objective = α·(partial-evidence 召回率) − β·(误触发率) − γ·(搜索成本)`。partial-evidence 召回率=触发后变对的比例（正）、误触发率=全证据题被误触浪费预算（负）、搜索成本=触发次数×均耗时（负）。
5. **sequencing 约束**：目标第 1 项"触发后变对"需第二趟真跑 → 依赖 **Stage 0 plumbing 完成**；plumbing 之前只能做 1–3 的相关性分析（shadow traces），全目标贝叶斯优化在 plumbing 之后。

### 3. 接入计算图本体（落点已就绪，近乎免造）
- `differentiable-controller.ts:14` 已内置 `ControllerAction="expand"|"stop"`，`:3-11` 有 `CONTROLLER_BUDGET_DIMENSIONS`。
- `controller-runtime.ts:107-148` `allocate()` 在 `action==="expand"` 时解锁 `expandedMaximum` 预算信封（独立预算、有上限）。
- `ControllerRuntime` 当前只在 `index.ts` 导出、**未接入 `store.ts` 实时循环**；集成 = 在首趟候选边界调用 `runtime.allocate()` 并按 `action` 行动。
- 把 `qpp` 作为新 feature 喂 `globalFeatures`（`controller-protocol.ts:19-52` 加 `qpp`，协议版本 1→2）；DC 过 gate 后从 globalFeatures 学化阈值取代手工/黑盒阈值。**默认只暴露 composite `qpp`**（Stage 2 只学阈值，见 §2）；数据足够时再暴露 `top1 / score_variance / intent_coverage / reason_health` 让 DC 隐式再加权。`globalFeatures` 全是标量统计量（`:140-173`），DC 在其上学习——梯度停在特征层，不穿过 ANN top-K 回传 embedder。

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
