# QPP × 可微计算图：触发式召回

> 状态：Stage 0 已实现；Stage 1 rolling τ 的 shadow worker 已实现但数据门槛未满足；多头可微控制器已有独立 typed runtime channel，默认 shadow，Stage 2 的校准阈值替代仍未推广。

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

**Stage 0 — Fibonacci progressive re-selection + guardrail floor（已落地）**
searchContext 仍一次性过采样候选池（`min(50, max(20, limit*3))`），但不再因
top-K 截断而直接把全部扩展结果暴露给模型：
1. 可微控制器的 evidence budget head 根据 Top-1 probe、QPP 分量和查询意图预测首个
   Fibonacci 档位；
2. 从预测档位（`1/2/3/5/8/...`）完整加载结果并计算二重 QPP；
3. QPP 仍不足才进入下一档；充分、候选池耗尽或硬预算到顶即停止。

这里 Fibonacci 数字表示**累计可见记忆数**。每档仍从同一 candidates 池重选，因此
保持零二次 ANN/FTS 检索。截断仅记录预算状态，**不再单独触发扩展**，避免大型记忆库
中几乎每次查询都扩大上下文。

guardrail 必触发条件（绝对地板，免标定）：
- `totalCount === 0`（空）→ `guardrail_empty`
- `directCount > 0 && reasonHealth === 0`（全 hybrid_match 兜底）→ `guardrail_all_fallback`
- `Top1 < QPP_TOP1_FLOOR(=0.2)`（基本没真匹配）→ `guardrail_low_top1`

`searchContextWithSecondPass` = `searchContext` 加 `secondPass:true` 的薄封装。各档的
目标数量、实际数量、token、QPP 和停止原因记录在 retrieval trace，供后续反馈训练。

**Stage 1 — rolling τ auto-calibration（无感自动标定，非 eval）**
Stage 0 pool-based 已免标定可用（上）。Stage 1 是**选择性优化**——让 `below_threshold`（τ）触发更 selective（省检索），非激活前提。
- **数据边界**：`agent_end` 的答案重合只写入
  `attributed_memory_ids`，用于覆盖率诊断和选择待用户复核的 retrieval；API
  模型/供应商行为会漂移，因此它不是 useful 正负标签，也不进入 τ、DC、边稳定度或
  拓扑训练。`nmg_get` 同样只记录 disclosure。可学习 evidence target 仅来自用户明确
  确认/纠正、工具验证或官方 benchmark evidence。
- **rolling worker**（✅ shadow artifact）：`npm run eval:qpp-tau` 读取近期自然、完整标注的 shadow rows，以 `expansionUseful` 作为明确触发标签，按 chronological task split 训练/留出验证。候选单次最多移动 0.05，记录数据窗口、指标、fingerprint 与 rollback threshold；少于 50 条、held-out 少于 10 条、任一窗口缺正反例或 held-out 不改善时 fail closed。它不改 runtime 配置，也不把“未使用”臆断为负标签。
- **权重** `τ_v / w_ic / w_rh`：只允许在带独立显式
  `expansionUseful/evidenceSufficient` 标签的自然任务上优化；DC 仍 shadow。

**τ 标定方法**：起点 τ=`DEFAULT_QPP_THRESHOLD`(0.55) 占位（Stage 0 truncation/guardrail 已免标定覆盖触发，τ 仅影响 below_threshold 选择性）；rolling worker 用自然任务的显式 QPP 结果标签自适应。**不在 eval 数据集上标定**（作弊）——eval 只作离线 sanity（audit 脚本看分量 gradation/区分度，不调参）。

**标定/分析流程**：
1. **离线 audit**（`evals/omnimemeval/audit-qpp-signal.ts`）：从历史 trace 重算 qpp（hybridScore，离线纯函数）+ join outcome，看分量 gradation/区分度——**只诊断，不调参**（不作弊）。
2. **rolling worker**（生产）：采近期 N 条带明确
   `expansionUseful/evidenceSufficient` 的 trace；比较高低 QPP 分段的显式结果率。缺标签保持
   unknown，不用 answer overlap 补标签。
3. **权重调参输入**（生产数据）：Top1×reasonHealth 相关性（reasonHealth 近常数则降权）、variance 双解（Top1−Top2 差值辅助）、intentCoverage 中性值（0.5 系统性偏则改均值）。
4. **sequencing**：Stage 0 Fibonacci plumbing ✅；诊断 attribution ✅；autodiff 首档预测 ✅；
   rolling worker shadow artifact ✅，promotion gate ⬜。2026-08-13 自然运行审计有 289 条带 QPP trace，但只有 7 条
   历史 `useful_memory_ids` 标签；这些旧标签来源边界不够严格，不可继续用于训练。
   当前 worker 应输出 blocker，直到积累足量、可审计的显式正反例并留出时间段验证。

**Stage 2 — Gumbel-Sigmoid DC**
阈值本身可微学化（Gumbel-Sigmoid 松弛 0/1 硬开关，梯度回传）；`Loss = 生成Loss + λ·搜索成本惩罚`；DC 出 shadow，**取代**（非并发）Stage 1 的 rolling τ，warm-start 自其值。**暴露范围**：默认只把 composite `qpp` 喂 DC globalFeatures → Stage 2 只学阈值，简单、小 eval N(≈500) 不易过拟合；数据足够时再暴露各分量让 DC 隐式再加权。Soft-Hard（REALM/可微 RAG，softmax top-k→注意力→与生成向量融合）太侵入（改 retrieval→gen 接口，NMG 返回 context 非融合向量），列替代不主推。

### 3. 接入计算图本体（落点已就绪，近乎免造）
- `differentiable-controller.ts:14` 已内置 `ControllerAction="expand"|"stop"`，`:3-11` 有 `CONTROLLER_BUDGET_DIMENSIONS`。
- `controller-runtime.ts:107-148` `allocate()` 在 `action==="expand"` 时解锁 `expandedMaximum` 预算信封（独立预算、有上限）。
- `ControllerRuntime` 已通过 `ControllerPolicyChannel` 接入 Pi 检索控制边界。QPP1/QPP2/
  rerank 开关只声明可用能力；runtime channel 才授予候选执行权。`off` 不评分，`shadow`
  只观察，`controlled` 仅允许受控实验，`active` 要求绑定候选、feature protocol、三类 gate
  artifact 和 rollback artifact 的人工审批准入收据。预算扩展在首趟候选处调用
  `ControllerShadowBridge.allocate()`，再把受硬信封约束的预算交给搜索。它没有、也不应
  直接嵌入 `store.ts` 的数据访问循环；零训练步控制器不会改变产品预算，控制器协议也
  不进入回答 prompt。rolling τ worker 已能生成 fail-closed、可回滚的 shadow artifact；
  尚未完成的是足量自然数据校准和通过 matched gate 后的候选推广。
- 把 `qpp` 作为新 feature 喂 `globalFeatures`（`controller-protocol.ts:19-52` 加 `qpp`，协议版本 1→2）；DC 过 gate 后从 globalFeatures 学化阈值取代手工/黑盒阈值。**默认只暴露 composite `qpp`**（Stage 2 只学阈值，见 §2）；数据足够时再暴露 `top1 / score_variance / intent_coverage / reason_health` 让 DC 隐式再加权。`globalFeatures` 全是标量统计量（`:140-173`），DC 在其上学习——梯度停在特征层，不穿过 ANN top-K 回传 embedder。

### 4. 预算与池
- Stage 0 不另起搜索——从首趟过采样池（`min(50, max(20, limit*3))`）按 `expandActiveGraphBudget`（2x evidence/nodes/tokens +1 graphHop，有上限）重选。零二次检索、零额外 LLM。
- 重选后的结果即统一池；**provenance 留系统侧，LLM 不该知道"这是扩来的"**。
- 候选步按置信度自适应省 token 须保守（证据审计：部分证据→16.67% 崩，收缩仅在全证据时才缩）。

## 不做什么

- **不训练/不引入 embedding 模型**：代理损失与 Gumbel-Sigmoid DC 都在检索已产出的分数上运作；DC 梯度停在 `globalFeatures` 标量层，穿不过 ANN top-K（选择不可微，differentiable retrieval 已知断层）回传 embedder。该模块关注覆盖与触发，和具体 embedder 正交；现成的小型 embedding 模型已经足够验证当前假设。embedder 质量仅二阶影响 vectorScore→分布→QPP 信号干净度，非功能依赖。
- **不做 FLARE（生成侧 entropy 触发）**：正交轴（生成 token 熵 vs 检索分数分布），但 NMG reader 外置（deterministic AutoRecall + deepseek-v4-flash），eval 拿不到 token logprob → 当前架构障碍。列为未来互补轴；双轴置信度（retrieval QPP + generation entropy）才完整，先发 retrieval 侧。
- **不做 Self-RAG**：LLM 自发 reflection token 需强模型微调，弱 reader 不触发，违背系统侧红线。
- **不做端到端可微检索**：REALM 软索引太侵入，拒。

## 多跳查询的方向评估

针对多跳查询的召回充分性判别，调研 4 个学术方向，逐一对 NMG 现状给判断：

| 方向 | NMG 现状 | 判断 |
|---|---|---|
| aspect-aware QPP（拆子主题分别评）| `intentCoverage` 已是粗版（query→3 意图族→期望类型→覆盖）| 不追细版——query decomposition 需 LLM/复杂规则，破坏 QPP"纯检索信号、无 LLM"设计；若未来要做，是独立 query-decomposer 模块，不混进 qpp |
| compositional sufficiency（证据链组合完整）| `graph_expansion` + `reasonHealth` 已是间接代理（expansion 存在=多跳链、reasonHealth<1=有 expansion 补）| Stage 2+ 候选；真正的"链完整性"需 outcome 标签（隐式反馈已有），当前不优先 |
| LLM sufficiency discriminator（轻量 LLM 读摘要判充分性）| 无 | 明确不追——与"纯检索、免 LLM、免 API"哲学冲突；弱 reader 不该把稀缺 LLM 调用花在判充分性上（与"模型不积极用工具、要自动"的诉求反了）|
| intra-list consistency / 二重 qpp（在结果里二次检索看一致性）| `graph_expansion` 已是一次"二重"（在 direct 上扩关联节点），但当前 qpp 把 expansion 标 `isDirect=false` 排除在 score 信号外——丢了"多跳题靠 expansion 拼证据"信号 | 有增量，见下 |

**可做增量（shadow 分量，未实现）**：`expansionDependence = expansions / totalCount`。但不能单独用——多跳题靠 expansion 是**正常**的（高 dependence ≠ 召回差）。真正信号是交互项 `(1 − Top1) × expansionDependence`：direct 强 → dependence 正常；direct 弱 + dependence 高 → 拼起来的链不稳固 → qpp 拉低 → 触发补强 direct。

**风险**：第 5 个分量，`reasonHealth` 实测已近常数低区分度——再加交互项可能在 benchmark 同样退化；"expansion 多 = 多跳题正常"的歧义，标定时若误判会把多跳题都触发浪费预算。**先 shadow 记 trace，用隐式反馈的 (qpp, useful) 对验边际贡献，再决定升入 C 或留 shadow**——审计先于标定。

## 风险

- **τ 非必需但有漂移**：Stage 0 触发已由 truncation/guardrail 免标定覆盖；τ 仅影响 `below_threshold` 选择性。τ 漂移由 rolling worker（生产 (qpp, useful)，非 eval）校准。worker 已生成 fail-closed shadow artifact；足量自然标签和 matched promotion 完成前，runtime 仍使用占位 0.55。
- **隐式反馈噪声/稀疏**：matcher（≥50% token overlap；Han bigram）是 precision-favoured 起点——noisy labels → noisy τ；弱 reader 答案若语义改写过大、不复用可辨识片段，标签仍会稀疏。需监控 useful 率；优先结合 exact `get` 和显式反馈，必要时再以经过校准的 embedding 相似度提供候选信号，而不能直接把 injection/fetch 当作成功使用。
- `variance` 高双解（清晰赢家 vs 噪声离群）——hybridScore 已 path-consistent；双解靠 Top1−Top2 差值辅助（标定时验证）。
- 经典 QPP 在 dense/neural IR 上相关性掉 10%+（文献）；NMG 用 BGE dense+hybrid，靠 `intentCoverage`/`reasonHealth` 领域增强补偿——这两项是 vanilla QPP 没有的 typed-memory / provenance 信号，非冗余。但 benchmark 全 `conversation_evidence` ingest → intentCoverage 退化（恒 0.5），需类型化 ingest 才有信号。
- 只攻"覆盖"半；"捞进来没排对/拼对"的 ranking/composition 半需另打，两者配套才完整。
- DC 过 gate 前不可启用学化路径（Stage 2）；Stage 1 rolling τ 是生产自适应，非梯度学化。

## Implementation lineage

- **Introduced — `dd41829e`、`d86b658c`、`86c837fc`**：建立 Stage 0 QPP、分量与 guardrail floor。
- **Introduced — `2bb92098`、`72ec3a33`、`84640037`**：从固定 top-K 收敛到 Fibonacci 渐进展开和折叠。
- **Introduced — `1ae9e501`**：接通 controller shadow bridge、每轮预算与产品使用反馈。
- **Hardened — `c369fa0b`、`4074eb19`**：rolling calibration fail closed，并把 controller policy 与 Agent answer 隔离。
- **Validated — `87d02423`、`fd62ed06`**：定义 matched product evidence 和因果 matched arm；这些证据仍不足以推广默认激活。
- **Hardened — `9e7168e7`、`4a2f7ff1`**：active channel 必须通过 gate 并持有可用 rollback state。

完整 owner 导航见 [implementation lineage](implementation-lineage.md)。
