# Harness 形式化

[English](harness-formalization.md) · [术语](harness-formalization.terms.yaml)

**Status:** draft
**Authority:** [上层范围](../agent-convergence-feedback-design.zh-CN.md)。

## Harness 形式化

[反馈密度模型](../agent-convergence-feedback-design.md#the-feedback-density-model)说明是什么决定一个 agent 循环是否收敛。本节说明 Harness 优化的是什么，以及梯度实际住在哪里。这条脉络很老——检查单把认知状态外部化，控制论靠反馈纠正，操作系统管理工作集与上下文切换，信息检索为"该展示什么"排序，强化学习学习小的控制策略——新的地方在于：有一个强力的冻结求解器可以用来安排上下文。

### 对象与闭环

基础模型 π_θ 是固定的，从不训练。Harness 是一个可训练的上下文编排策略 H_φ：

```text
C_t = H_φ(τ_t, I_t, f_t, e_t)            # context assembly
a_t ~ π_θ(a | C_t)                        # frozen solver acts
(s_{t+1}, e_{t+1}) ~ E(s_t, a_t)          # environment responds
```

τ_t 是一个 **quest**：Agent 已外部化的一个工作单元——写成一个世界或 Agent 之后可以判定其完成或失败的对象。I_t 是可得的信息池，f_t 是当前焦点，e_t 是当前事件。（这个名字借用了 RPG 语义——冒险者接下一项有界委托、推进它、完成它——因为这种用法在模型的语料中稳定：「quest」命名一个有界、可判定的受托工作单元，而不是一个承诺或一种心情。拉丁词根是 *quaesta* ← *quaerere*，"去寻找"，与 *tessera* 的符号词汇同源。）

### 完成是局部监督信号

```text
y_t  = 1[τ_t completed]
h*_t = argmax_h [ P(y_t = 1 | τ_t, I_t, f_t, h) − λ·C(h) ]
h    ∈ { none, cue, resurface, retrieve, compress, wait, external acquisition }
```

Harness 不判定一个 quest 的语义正确性；它学习哪种编排提高其完成概率。最小有效干预不是风格偏好，而是 λ 项：一个 10-token 的 cue 若能达到与 5000-token 检索相同的 P(y=1)，则严格优于后者。

### 梯度是真实的，它住在 φ 里

```text
L(φ)           = −E[y] + λ·E[C(h)]
φ_{k+1}        = φ_k − η·∇_φ L(φ)
u(d, p | τ, C) = P(y=1 | τ, insert(C, d, p)) − P(y=1 | τ, C)
```

运行中的 Agent 没有显式梯度；训练过的 Harness 有。这解决了 SGD 类比落在何处的问题：不落在 Agent 的轨迹上，而落在 Harness 参数上，以 quest 完成作为损失。u(d, p | τ, C) 是在位置 p 呈现片段 d 的边际价值——不是相关性 Rel(q, d)，而是单次插入对当前 quest 完成概率的因果贡献。这正是"学习展示什么、何时展示"的精确形式。

### 任务单元如何分解功劳分配

一条只有一个最终奖励的长轨迹让功劳分配很难。Agent 自己写下的 quests τ_1 … τ_n 把它切成短回合：

```text
E_i = (τ_i, h_{i,1:k}, y_i)
```

长时程稀疏奖励 → 许多短的有噪奖励。每个 quest 一次编排决策是上下文赌博机；一个 quest 内部的顺序决策是在极小动作集上的小型 RL。复杂度只在证据要求时增加：监督 → 赌博机 → RL。θ 保持冻结；只有 φ（router / retriever / compressor / scheduler）移动——在本系统中就是 `src/lab/` 里的 DifferentiableController + 自动微分 + 学习型路由那一套，按[有偏优化器模型](../agent-convergence-feedback-design.md#iteration-as-a-biased-optimizer)，它已被闸门限制为剪枝而非排序。

### 本系统中的任务单元是什么

τ_t 不是提示词局部的草稿文本。承载它的对象已经存在，它们的生命周期事件就是完成信号：

| Quest | 对象 | 由什么判定完成 / 失败 |
| --- | --- | --- |
| "这个任务必须完成" | 看板条目（工单、goal 类型） | resolve / 过期 |
| "这段证据住在这里" | 定位书签（tessera） | 重定位成功 / stale |
| "这份内容应当成立" | 文档（设计文档、contract） | 提交 / reconcile 通过 |

从对象生命周期读出的完成是外部事实，不是模型自评。在没有对象、Agent 只宣布"完成"的地方，该信号是[有偏中间目标](../agent-convergence-feedback-design.md#iteration-as-a-biased-optimizer)——它可以引导，永不把关。

### 与收敛模型的关系

不需要全局势函数。提高每个局部的条件完成概率 P(y_i=1 | H_{φ_{k+1}}) > P(y_i=1 | H_{φ_k}) 即已足够：如果 quest 分解是有意义的，长轨迹会间接改善。[反馈密度模型](../agent-convergence-feedback-design.md#the-feedback-density-model)中的两层信号精确对应——quests 提供密集、局部、以生命周期为依据的标签；RCP reconcile 与人工签署提供稀疏无偏的校准，防止密集标签把 H_φ 训练成一个自洽的固定点。

> 训练 Harness 不是去解题，而是去组织上下文，使一个冻结的 LLM 最大化完成当前 quest 的概率。

以下小节并入对该框架的一次独立评审结果（属交叉核对，不是需求来源）以及该评审引发的偏置分析。它们进一步澄清梯度信号从哪来、如何保持无偏，以及目标中的成本项在本系统中实际意味着什么。

### 一条事件流，两个理论角色

quest 生命周期事件——看板 resolve、书签重定位/stale、文档提交——同时扮演**两个**理论角色：

- [反馈密度模型中的全局校准器](../agent-convergence-feedback-design.md#the-feedback-density-model)：稀疏、无偏的纠正，防止回路收敛到自洽的固定点；
- [Harness 形式化](#harness-形式化-1)的**局部标签来源**：为 φ 提供密集、以生命周期为依据的完成信号。

一条事件流同时喂养两者。因此接线是一条单一总线——对象生命周期事件进入 AG `observe()`，加上 `(quest, h, y)` 日志配对——而不是两条独立流水线。这是整个设计中最经济的结构性事实。

### 信号纯度是 SGD 偏置问题，而非分层处理问题

按"外部性"给完成来源分层的直觉只是一种工程近似。正确的理论框架是**梯度估计的偏置/方差结构**：SGD 收敛只要求 `E[ĝ] = ∇L`，因此对一个信号来源的准入检验是无偏性，而不是纯度。

| 梯度来源 | 机制 | 偏置 | 是否进入 ∇L？ |
| --- | --- | --- | --- |
| 书签 SimHash 距离 | SimHash 计算，无 Agent 参与 | 无偏、连续 | 是——密集 |
| 文档 git 提交 | git 事实 | 无偏 | 是——稀疏 |
| RCP reconcile | 独立观察 | 无偏 | 是——最稀有、最昂贵 |
| 看板 resolve | Agent 自己的动作 | **有偏**——Agent 有报告完成的动机；是系统性乐观，不是随机噪声 | 否，除非去偏 |

有偏来源不能靠降权（分层）处理；它只有两种处理方式：

1. **排除出 ∇L**——用作探索先验或课程信号，引导行为但不进入梯度。
2. **去偏**——由外部称重者（reconcile / 测试）周期性度量该来源的假完成率（resolve 说完成、reconcile 发现并非如此）；可度量的偏置是可纠正的，从而把有偏来源变成标定过的噪声梯度。

去偏频率就是外部校准频率——又是[反馈密度模型](../agent-convergence-feedback-design.md#three-regimes-decided-by-a-ratio-not-by-step-count)中的临界比率。这就是为什么该框架的收敛不单活在数学中：它活在**谁定义 quest、谁验证 quest 链**（见[本系统中的任务单元是什么](harness-formalization.md#what-quests-are-in-this-system)）。

完成信号不必是二值的。书签称重是一个**连续的** SimHash 距离，因此 `y_t` 可以携带"接近程度"信息（quest 有多近），而不只是 0/1 判定——比二值形式更密的梯度。

### 探索是目标的一部分

`u(d, p | τ, C)` 是反事实量：在同一轨迹上无法同时观察到"插入"与"不插入"同一片段于同一位置。没有刻意的干预，收集到的数据是混杂的，`u` 会系统性地偏向那些恰好与过去干预共现的信息。数学需要一个显式算子：

```text
h_t ~ ε-greedy(h*_t)              # ε decays as evidence accumulates
```

这种衰减结构在本系统中已有先例：学习型路由的剪枝闸门（`examples ≥ N ∧ score < θ ∧ lexical guard`）。探索本身也受最小有效干预约束——探测一个昂贵的干预代价很高，因此 ε 调度属于 `λ·C(h)` 的一部分，而不是免费预算。应在生产影子中保留一条始终随机的探针臂，使编排策略无法自我实现；动作空间小到（六七个离散 `h`）ε 的最坏情况被一次 cue 或一次冗余检索所界定——回路小到可以审计。

### 知识空间是开放的

"封闭的通用知识"假设（一个强力的冻结求解器）需要一处细化才完全诚实：

```text
π_θ parameters   = closed general knowledge (training cutoff, static)
observations     = open (files / tools / environment / current facts)
derived knowledge = written back through governed memory → K_t grows
```

一个在每次完成 quest 后**存入可验证**衍生知识的 Agent，会提高同类未来 quest 的 `P(y=1)`——知识跨 quest 复利，这就是在不训练 `π_θ` 的情况下摊销长时程收益的方式。这正是"你的 agent 可能变化，你的记忆不必变化"背后的机制：通用知识随模型过期，`K_t` 中经核验的知识是唯一跨代累积的资产。

对称的风险是污染：衍生知识可能是错的，而不受治理的回写会让错误像自强化回路一样通过召回传播（见[信息约束](../agent-convergence-feedback-design.md#the-information-constraint)）。因此 NMG 的记忆治理——写策略、真值状态、取代、要求可归因证据的 claim 结果——是**Harness 有效性的前提条件**，而不是一个单独特性：干净的 `K_t` 正是让 `P(y|quest)` 学习信号不被噪声化的东西。记忆内容从不被训练；只有编排 `φ` 移动，而内容治理保持规则驱动并接受外部验证。

### λ 是工作集预算的影子价格

在本系统中 `λ·C(h)` 不是抽象成本项。AG 预算账本在检索选择、工具观察与推理产物之间共享同一个容量池——放进 `W_t` 的每个片段都取自同一个 `B`。因此 `C(h)` 是账本本就会产出的一个数，而 **λ 是工作集容量的影子价格**：最小有效干预与硬预算成为同一约束的两种读法。

把它读作影子价格意味着一个软预算方向：当边际价值 `u(d,p)` 足以支持超支时，硬上限就变成一个可购买的限额。那个价值信号就是 `u` 本身，其估计需要[探索是目标的一部分](#探索是目标的一部分)中的探索——λ、u 与 ε 构成一个闭环。

### 低算力、仅路由的候选方案

阅读完整职责：[低算力、仅路由的候选方案](harness-formalization/low-compute-router-candidate.md)。
