# 反馈密度下的 Agent 收敛

[English](agent-convergence-feedback-design.md) · [术语](agent-convergence-feedback-design.terms.yaml)

**Status:** draft — implementation partial; theory and default activation unproven
**Updated:** 2026-09-03

本文把一次设计讨论整合为单份蓝图：一个解释长任务型 Agent 为何失败（以及为何成功）的理论、支撑它的文献、既有 NMG 系统中已经实现该模型若干部分的部件，以及能够闭合剩余回路的候选设计。这样写是为了让未来的 Agent 不必重新推导这场对话就能接手。

## 实现边界（部分实现，不是系统完成）

阅读完整职责：[实现边界（部分实现，不是系统完成）](agent-convergence-feedback-design/implementation-boundary.md)。

## 被取代的模型

流行写法把长任务型 Agent 框定为一种可靠性乘积：若每步成功概率为 `p`，则 `n` 个顺序步骤成功的概率为 `p^n`——在 `p = 0.99`、`n = 100` 时为 36.6%。该模型作为算术并没错；它错在**把系统建模**错了，因为它假定错误是吸收态：没有反馈、没有纠正、没有可逆性。这一假设只对盲目的串行链条成立，在工程中几乎对别的一切都不成立。随机梯度下降就是标准反例：没有哪一步是最优的，带噪甚至更差的步是常态，而过程仍然收敛——因为每一步都被一个持续可得的损失信号牵引。

因此有效的问题不是"如何提高单步成功率"，而是**"出错之后，世界是否允许系统回来，以及它能多便宜地发现自己已经偏离？"**

## 反馈密度模型

### 迭代作为一个有偏优化器

把 Agent 建模为带梯度估计的迭代更新：

```text
θ_{t+1} = θ_t − η·ĝ(θ_t)
ĝ       = external gradient (unbiased) + self-generated direction + noise
```

Agent 为自己写下的每一个中间目标（子目标分解、计划细化、对模糊指令的自我解释）都是一个**有偏的梯度估计**：偏置来自模型的世界模型与真实世界之间的差距。自生成方向可用于引导搜索；它们绝不能为收敛把关，因为从来没有任何外部东西验证过它们。

### 三种状态，由比率而非步数决定

令*校准率*为外部验证的频率，*漂移率*为未校准的自生成运动的累积。二者的比值决定所处状态：

| 状态 | 条件 | 更多步数 | 收敛到 |
| --- | --- | --- | --- |
| 收敛 | 校准/漂移高于临界比率 | 有帮助 | 外部目标附近 |
| 临界 | 比率接近阈值 | 振荡 | 不确定 |
| 发散/僵化 | 校准稀疏、漂移占主导 | **有害** | 模型自身的固定点 |

在任何有状态过程中，步数都是双刃剑：每多一步就同时多一次纠正机会和一次漂移机会。只在 i.i.d. 重试模型（几何分布）中，更多尝试才单调有益。在有状态、有偏、自我条件化的过程中，它们并不如此。

### 信息约束

外部损失是唯一指向目标的信息来源。若梯度完全自生成，每次迭代只能保留或丢失信息（数据处理不等式）：过程收敛到模型自身的固定点，自我蒸馏式迭代可以坍缩为一个平淡的自洽解。这就是为什么损失不能由被优化的东西自己来写——这是信息约束，不是道德约束。

### 推论

- 收敛质量是**外部校准密度与自生成偏置**的函数。收敛点是信念固定点；它与真实目标的距离等于偏置乘以曲率的倒数。
- 长任务可靠性的工程杠杆是**缩短未经验证的片段**（让反馈更密），而不是发放更大的步数预算。
- 步数非单调：长的未经验证片段会累积漂移（自我条件化），而长上下文会削弱模型对早期材料的使用。
- 可靠性来自验证回路，而不是基础模型的单步质量。

[Harness 形式化](#harness-形式化)把可训练的那部分具体化：Harness，在其自身参数空间中拥有真实梯度。

## Harness 形式化

阅读完整职责：[Harness 形式化](agent-convergence-feedback-design/harness-formalization.zh-CN.md)。

## 文献支持

下表中每条主张都有直接的实证或理论依据；这次检索执行于 2026-09-03，属于交叉核对，不是需求来源。

| 主张 | 工作 |
| --- | --- |
| 没有外部反馈的内省不能改善（甚至可能损害）推理 | [Huang 等，《Large Language Models Cannot Self-Correct Reasoning Yet》，ICLR 2024](https://mlanthology.org/iclr/2024/huang2024iclr-large/) |
| 纯自生成的循环不收敛 | [《The Mirror Loop: Recursive Non-Convergence in Generative Reasoning Systems》](https://browse-export.arxiv.org/pdf/2510.21861) |
| 密集的逐步反馈优于稀疏的最终反馈 | [Setlur 等，《Rewarding Progress: Scaling Automated Process Verifiers》，ICLR 2025](https://mlanthology.org/iclr/2025/setlur2025iclr-rewarding/)；过程奖励模型一脉（OpenAI《Let's Verify Step by Step》） |
| 可靠性来自验证回路，而非单步能力 | [《Where Does Agent Reliability Come From? A Cross-Benchmark Decomposition of Verification Loops, Specialist Models, and Scaffolding》](https://huggingface.co/papers/2607.17044) |
| 长轨迹受自我条件化效应约束 | [Sinha 等（2605.02572）](https://huggingface.co/buckets/huggingchat/papers-content/tree/2605/2605.02572.md) |
| 步数在长时程上非单调 | [《The Illusion of Diminishing Returns: Measuring Long Horizon Execution in LLMs》，NeurIPS 2025](https://neurips.cc/virtual/2025/loc/san-diego/127973) |
| 外部反馈能挽救推理；仅靠内部反思不如多视角对比 | [Reflexion（2303.11366）](https://arxiv.org/abs/2303.11366)；[SWE-agent](https://arxiv.org/abs/2405.15793)；[Self-Contrast，ACL 2024](https://aclanthology.cn/2024.acl-long.197/) |
| 未经验证的片段是长任务的结构性失败来源 | [《The Horizon Gap》（2608.06663）](https://arxiv.org/abs/2608.06663) |

**开放缺口：** 没有单一权威工作把这些统一为一条可检验的定律，形如"一个临界的校准/漂移比率把收敛态与发散态分开"。这种统一是一个候选贡献。

## 系统已经具备的东西

阅读完整职责：[系统已经具备的东西](agent-convergence-feedback-design/existing-runtime-components.md)。

## 用现有能力闭合回路

不需要新组件。"在某个目标上收敛"分解为两项既有能力加一根接线：

- AG 把外部内容片段**摄入**到会话工作记忆。定位书签是这类片段的第一种；一份 contract 或一个期望的最终形态是同类的另一种片段。
- 定位书签**固定一个内容基线并度量漂移**（SimHash 指纹 + 阈值 + 重定位）。把它用于被摄入的目标片段，是对书签机制的复用，不是新机制。
- RCP **验证行为**（测试 / lint / contract 执行）——昂贵、稀疏、无偏的纠正。

度量方式随被摄入目标的形状而定：

| 目标形状 | 漂移度量 | 成本/频率 |
| --- | --- | --- |
| 形态（"最终内容应近似这个形状"） | SimHash 距离 | O(n)，本地，高频 |
| 子片段（"应包含/可重定位到这个片段"） | snippet 定位 / diff | 中等 |
| 行为（"应通过测试 / lint / contract"） | 执行验证器（RCP 检查） | 昂贵、稀疏、最终 |

SimHash 式度量要求目标与当前内容在文档规模上可比（已测得：低于文档规模时没有信号），并且只给出量级——方向来自 diff 或验证器诊断。

### 验证决定什么可以充当闸门

Agent 会不断写下中间目标；它**不会**自发发明没有外部目标的目标（它是事件驱动的反应器——它会细化与分解，不会自我发起）。由此可得：

- 自撰目标是有偏的中间产物：它们组织执行（任务帧）并引导搜索；它们从不为收敛把关。
- 收敛/投影闸门只接受经外部验证的内容：人工签署，或其主张已被某个验证器实际演练过的内容。权威来自验证行为，而不是作者身份。

### 两级回路

- **会话内：** reconcile/验证器失败 → 漂移事件进入 AG 的 `observe()` → 在同一任务帧中做小的纠正步 → 新投影 → 重新检查。AG 提供结构（冷却集 = 动量缓冲，投影链 = 检查点序列）；缺的那根接线是 reconcile → observe。
- **跨会话：** 当一个任务真的跨越会话时，漂移事件与已完成任务成为受治理的记忆（带来源标记），由延续该工作的会话召回。形态漂移检查与 RCP 验证器归约为同一类统一事件：相对某个外部固定基线的漂移。

## 已识别的缺口（工作队列）

1. **单一事件总线尚不存在。** 任务生命周期事件（看板 resolve、书签重定位/stale、文档提交）与 reconcile 漂移事件没有以带 `(quest, h, y)` 配对的日志进入 AG `observe()`——而这正是同时喂养全局校准器（[反馈密度模型](#反馈密度模型)）与局部标签（[任务生命周期信号](agent-convergence-feedback-design/harness-formalization.md#what-quests-are-in-this-system)）的那根接线。下文的 AG 摄入缺口是这件事具体的前一半。
2. AG 无法摄入外部内容片段；书签摄入是具体的首个案例（memory 条目进入 AG 时不带它们的定位书签）。
3. 显式新记录的 RCP receipt → AG `observe()` 已实现；通用漂移流式传输、通知重放与自动 harness 反馈仍未完成。
4. 不存在干预日志或 ε-greedy 探索来使 `u(d,p)` 可估计（反事实数据）。可复用模式：学习型路由闸门（`examples ≥ N`、词法守卫、影子先行）外加一条始终随机的探针臂。
5. 看板 resolve 是有偏的完成来源，没有通过 reconcile 的假完成度量/去偏路径（[信号纯度与去偏](agent-convergence-feedback-design/harness-formalization.md#signal-purity-is-an-sgd-bias-question-not-a-stratification-question)）。
6. 经外部批准的长期任务不是一等持久记忆（无跨会话连续性；[开放知识空间的论述](agent-convergence-feedback-design/harness-formalization.md#the-knowledge-space-is-open) 中所述的知识复利需要一个受治理的目标存储）。
7. 书签漂移机制（基线 + SimHash 度量 + 重定位）只针对单个文件的过去快照得到验证；对任何被摄入目标片段的复用尚未接线。
8. 临界比率主张（[三种状态，由比率而非步数决定](#三种状态由比率而非步数决定)）在本系统中未经验证；测量先于构建（[待验证实验](#待验证实验)）。

## 待验证实验

本仓库有测量先行的传统。在构建[已识别的缺口（工作队列）](#已识别的缺口工作队列)中的任何一项之前，先做两项测量：

**阶段 1——训练之前的样本管道。** 用关联每个任务、所选干预及结果的有界记录，为既有决策点（AG 披露、召回注入、检索）埋点。被动日志与一条不执行的影子臂检查覆盖率、结果联结与策略差异，而不改变行为；它们不确立无混杂的干预效应。此后才在匹配预算下执行真正授权的随机化干预或可复现的快照分支，去估计因果收益。在考虑可选的 596 参数 MLP 之前，先把固定规则与 132 参数基线比较；不要仅仅因为观察性的 `P(y|h)` 有预测力就去训练。

**阶段 2——校准频率扫描。** 使用一个真实的、由 RCP 管理的多提交任务：

- 扫描 reconcile/验证器频率（一次跑到完成 vs N 个检查点）。
- 追踪每个频率下的收敛：漂移归零成功率、收敛所需步数，以及长未经验证片段放任运行时的失败模式。
- 以 reconcile 为基准真值，测量看板 resolve 的假完成率（[信号纯度与去偏分析](agent-convergence-feedback-design/harness-formalization.md#signal-purity-is-an-sgd-bias-question-not-a-stratification-question)）。
- 对跨会话那一段，比较"从记住的漂移状态恢复"与"从零重开"。

这些测量决定该理论是否挣得永久架构（[用现有能力闭合回路](#用现有能力闭合回路)），还是留作一份有记录的模型。

## 可执行 v1 规格与决策闸门

阅读完整职责：[可执行 v1 规格与决策闸门](agent-convergence-feedback-design/executable-v1-specification-and-decision-gates.md)。

## 相关文档

- [`docs/design/session-active-graph-runtime-design.md`](session-active-graph-runtime-design.zh-CN.md) — AG 运行时蓝图（[文献支持](#文献支持)缺口浮现处）
- [`docs/decisions/implemented/2026-08-29-session-active-graph-runtime.md`](../decisions/implemented/2026-08-29-session-active-graph-runtime.zh-CN.md)
- [`docs/design/memory-tesserae-design.md`](memory-tesserae-design.zh-CN.md) — tesserae SimHash 漂移（§4.4）
- [`docs/decisions/implemented/2026-08-29-repository-control-plane.md`](../decisions/implemented/2026-08-29-repository-control-plane.zh-CN.md) — RCP（§4.2）
