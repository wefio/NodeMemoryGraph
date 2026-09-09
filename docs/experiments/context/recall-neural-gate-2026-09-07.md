# 神经门控的召回预探针设计（2026-09-07）

状态：设计提案，未实现。决策点在文末，待拍板后分 PR 落地。

## 1. 问题

auto-recall 现在由硬编码关键词门 `decideMemoryLoad`（src/core/gate.ts）先行裁决：
命中“回忆词”→retrieve，命中“可选帮助词”→cue，否则 →none（不召回、不搜索）。

该门是**先验的**，无法知道库里有没有相关记忆——因为不搜就不知道。于是出现
“库里明明有相关记忆、回合却毫无召回意图词”的漏召回：实测例即
`今天北京天气怎么样` + 用户库中 weather-query-method（wttr.in）记忆：
门判 none → 不搜索 → 记忆不可见。在全新会话里这条记忆等于白存。

在线学习（ContextRouter，commit a732f20 起 daemon 全持有）只对“实际执行过的
retrieve”更新权重、无探索，因此也学不到 none/cue 分支的价值——这正是 v1
明确推迟、现在要补的缺口。

## 2. 外部启发（2026-09-07 网搜综述）

- **选择性/自适应检索**是主流：Self-RAG（反射 token，需微调）、Probing-RAG/SEAKR
  （读内部隐藏态/不确定性，需白盒权重）、Adaptive-RAG（外部轻量分类器按复杂度路由）。
  闭源 API 下只有 Adaptive-RAG 路线可用（外部分类器），白盒/微调路线不可行。
- **Abstention 学习**：RSCB-MC（Risk-Sensitive Contextual Bandit，γ>α>β，abstain 单独
  计 reward）——本项目已采纳其非对称奖励形式；AWA-RL 同类。
- **廉价预检**：hybrid 检索里 keyword/lexical prefilter 是成熟做法；本项目实测
  per-user store 检索 ~1ms（370 记忆 avg 1.19ms），lexical FTS 远快于 embedding 调用。
- **abstain 动作的线上反馈**：bandit 需探索 abstain/none 才能学到其价值；无免费信号。

## 3. 关键洞察：贵的不是“搜”，是“升级+注入”

- per-user store 极小 → 每次先跑一次 FTS top-k（lexical，不展开 evidence、不调
  embedding）≈ 免费（~ms）。
- 真正的成本与风险在**升级**：语义检索 + 把候选折叠/披露进模型上下文（token 占用、
  干扰/噪声）。在线学习的代价 λ·K 也是按注入 K 计的。
- 因此“廉价内容预探针”的正确定义不是“要不要跑 FTS”（每次跑），而是
  **“看到这次 FTS top-k 后，值不值得升级到 cue/retrieve 并注入”**。
- 这把门从“先验关键词”改成“**每次免费看内容，再决定要不要升级**”，
  绕开“不搜就不知道有没有相关记忆”的死结——而且看的是内容，不是枚举主题词。

## 4. 设计

### 4.1 决策面与升级路径

每回合先跑 **pre-probe = FTS top-k**（k 小，如 5；纯词法，取 id/node/preview/score，
不展开、不 attribution）。然后神经门控在三条上打分：

| 动作 | 含义 | 代价 | 反馈来源 |
|---|---|---|---|
| none | 不注入 | 0 | 探索 + 回顾式漏召回探测 |
| cue | 注入 header 提示（少量） | 低（~5 条 header） | 同现有 retrieve 反馈 |
| retrieve | 完整召回披露 | 高 | 现有 feedback 链路 |

升级是单向且受 budget 约束的：probe 分低→ none；临界→ cue；高/明确意图→ retrieve。

### 4.2 神经门控 = 复用 ContextRouter（同一在线可微路由层）

输入特征（全部 cheap、缺失即 missing-masked，不伪造）：
- probe 产物：top 分、top-gap、命中数、命中是否触及常驻记忆主题；
- 回合：decideMemoryLoad 意图分类输出（作为先验特征保留）、continuation 标志、
  预估注入 token / context 占用；
- 历史：该 session 近 N 次的 {decision, reward}（收敛到“上轮刚被拒→这轮少 inject”）。

与现有在线学习共用：stage（features, action）→ feedback → RSCB reward →
ContextRouter.update → persist（a732f20 的 daemon 链路原样扩展）。

**冷启动无回退**：先用现有硬编码 gate 的输出作为初始化先验/监督起点，学出来的
分只在明显优于先验时接管（或先 shadow 记录、后切换）——延续 controller
“shadow→actuate”的既有范式。

### 4.3 none 分支的训练数据（核心难点，三条候选源）

1. **ε 边界探索注入极简 cue**：对门判“临界 none”的回合，以 ε 概率注入一个极简
   cue（header 5 条、可折叠），观察其效用（被用上=好；被拒/噪声=坏）。这给
   none-vs-cue 边界真实标签。成本 = ε×少量 token。
2. **回顾式漏召回探测（无注入）**：回合结束后廉价探测该回合“本应使用记忆”：
   后续回合的召回命中本回合主题 / 用户纠正或追问暴露缺了先验上下文 / answer-overlap
   对上了库内记忆。能无扰动地给 none 负例（该召回没召回）。
3. **稀疏 LLM 自评**：仅对低置信的 none 回合问一次消费方 judge“这轮给记忆会有用吗”。
   省：不每回合问。兜底源，成本最高。

建议：主用 1+2（有扰动的边界样本少、无扰动的回顾样本多），3 只做校准。

## 5. 里程碑（拟 PR 拆分）

- M1：pre-probe 落地 + 特征抽取（不动决策：shadow 记录“若升级会怎样”）。
- M2：门控分加入在线学习（none/cue 开始有探索样本），仍以先验为主、shadow 比较。
- M3：边界接管（门控分明显优于先验处启用）+ 回顾式漏召回探测闭环。
- 每步都过 agent:verify + 无回退指标（复用既有评测/召回覆盖口径）。

## 6. 待拍板决策点

1. pre-probe 用纯 FTS top-k 还是 hybrid(词法+已有向量, 若 embedding 恢复)？
2. ~~门控与 ContextRouter 同参数同头，还是独立 gating head~~ → **已定：统一单模型**。
   不造第二个网络；ContextRouter 动作空间本就是 none/cue/resurface/retrieve，
   召回升级门 = 其原生动作选择。正则 gate 输出 + probe 特征并入同一 32 维输入。
   统一边界：只统一“上下文注入决策族”（per-turn 要不要注入）；per-item 的
   哪条上/折叠（DifferentiableController、QPP/QPP2）粒度不同，不并入。
3. none 分支数据：主用 ε-cue 探索(1) + 回顾式探测(2)，LLM 自评(3) 仅校准——同意？
4. ε 预算与“shadow 后接管”的阈值口径。
5. M1 是否直接做成 shadow-only 先出报告再定 M2/M3。
6. **M0（新增）**：离线容量探针——在真 (features→outcome) 数据上折外比
   “统一模型线性 132 参数 vs 单隐层(32→16→4≈596 参数)”。不是第二个网，
   只回答“这一个模型要不要加容量”；线性≈隐层则定线性，差才升级。

参考：decideMemoryLoad（src/core/gate.ts）、ContextRouter 在线学习
（src/lab/context-router-online.ts，a732f20）、RSCB 奖励（src/lab/context-reward.ts）。

---

# 7. 实验性想法（非本次范围）：虚拟节点式全局视野通道

状态：**实验性，不承诺实现**。代价小但无测位，当前零代码，仅记录为 seam。触发条件见 7.5，满足再评估。

## 7.1 想法来源

- 用户自创双流架构（高维主干 H1→…→HL + 低维历史流 p1→…→pL + Plus1 残差），自查确认 ≈ 图神经网络 **virtual node**（Gilmer et al. 2017 MPNN 的 master node；OGB 基线普遍用 virtual node 提表达力；近年有专门表达力分析论文）。
- 抽象成**通用原语**：给任意“处理一批单位”的架构廉价加一个全局视野通道。

## 7.2 机制（契约）

```
GlobalViewChannel（单位 = 一批被局部处理的东西：候选记忆 / 会话回合 / 网络层）
  每单位：   向下游写廉价摘要（其状态的小投影）
  每步聚合： mean / sum / attention → 低维全局态 g
  状态更新：  g ← update(g, 聚合)        # 可跨步递推 = 时间视野
  广播：      g 以 add/concat/gate 注回每个单位的下一步
每步 O(N) 而非 O(N²)；低维 g 保证便宜。
```

同族：virtual-node GNN / [CLS]·global attention / Perceiver latent / RNN state——
同一抽象：**局部计算 + 低维全局态读写**。

## 7.3 在本系统里：该住哪 / 不该住哪

- **值钱位置：per-item 池决策**（检索/披露时给候选池打分：DifferentiableController、QPP）——
  让“每条该不该上”带池语境（我在什么池、池里还挤着什么），补今天 per-item 独立打分的缺。
- **不该住：per-turn gate**（每回合只有一个决策、无 item 集；gate 要的“全局”=会话态，
  正解是手写聚合 →（数据够）学低维循环态，不是虚拟节点）。
- **红线**（沿用 docs/design/hierarchical-activation.md）：全局态 g 必须是候选池/会话
  可观测字段的可微投影 + 归因奖励，**不得长成第二套不可见隐性记忆**。

## 7.4 为什么现在不实现（数据/测位）

- 在线实标 ≈ 1 条；shadow 事件虽有 per-item 池（387 retrieval × ~10 候选），但 per-item
  特征薄、无金标（只记控制器做了什么，非该做什么），feedback 在 turn 级 → 测不出
  “池内相关性”不循环的答案。
- **结构性错配**：唯一会攒真实反馈的管道是 turn 级 gate（§8），虚拟节点的价值在
  per-item 池，当前无 per-item 带金标结果流 → 就算一直攒也喂不到它住的层。
- 代价虽小，无测位则实现 = 不可验证的参数。

## 7.5 按需启用触发条件（满足再评估，非本次范围）

1. 出现带金标的 per-item 池数据集（候选 → 该不该上），或
2. DC/QPP 离线评估显示“同一记忆在不同池里效用明显不同”（池内相关性证据）。

到时流程：shadow 原型 → 与 per-item 独立打分 A/B → 有据才 actuate。当前仅作 seam。

---

# 8. 运行观察：在线反馈从未被触发（数据生成缺口，待修）

## 8.1 事实（2026-09-07 用户指出，已核实）

- 真实会话里 `nmg_remember(action=feedback)` **触发 0 次**；`context-router-online.json`
  唯一的 1 行来自人工 HTTP `recordFeedback` 测试，非真实使用。
- 旧 shadow 功能曾产出 125 条真实 feedback（Aug 11：collectionOrigin natural 109 /
  controlled 16）——靠 **feedback nudge** 提示驱动，不是纯自愿。

## 8.2 根因

- 新在线路径（a732f20：daemon `#search` stage → `recordFeedback` 消费）的 feedback
  **纯自愿、无触发**：auto-recall 注入后，消费方 LLM 没有任何提示去评判“这次注入
  有没有用”。
- 现有 feedback_nudge 挂在 controller-shadow 的 `pendingFeedback` 上（旧功能，受
  NMG_CONTROLLER_SHADOW 门控），**在线路径没继承**。
- 结果：stage 了、模型从不 feed back → 学不到。

## 8.3 修法选项（待拍板后分 PR 实现：扩展 + daemon + 测试）

- **A. 给在线路径接一次性 nudge**：auto-recall stage 后，下回合前注入轻提示，要求消费方
  用 `action=feedback` 交标签（带 sessionId/activeGraphId）。成本 = 少量 prompt token；
  风险 = 自愿仍可能漏。
- **B. 回合末自动标注器（扩展侧，机械标签）**：不另付一次 LLM 判断，用可观测结果派生——
  回答是否引用了被召回记忆（已有 `deriveAnswerOverlapMemoryIds`，src/core/feedback.ts）、
  用户是否纠正/追问、任务成败；只在高信号时自动 `recordFeedback`（稀疏但高质）。
  风险 = overlap≠useful，须保守、禁止伪造标签。
- **C. 稀疏 LLM 自评**（仅低置信 none/边界回合问一次 judge）——§4.3(3) 已规划，成本最高，仅校准。

建议：**A + B 组合**（A 补触发、B 兜底高信号），C 留校准。当前先修数据生成，否则 §4 的
在线学习与 §5 里程碑都无米下锅。
