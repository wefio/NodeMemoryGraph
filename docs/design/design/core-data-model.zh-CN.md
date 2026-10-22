# 核心数据模型

[English](core-data-model.md) · [使用的术语](core-data-model.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## 核心数据模型

```text
HistoryRecord
  - immutable evidence during normal maintenance
  - stable session/message/tool source identity
  - exact content and timestamp
       | mandatory provenance
       v
Semantic memory store
  |- STG
  |    - provisional/task-local MemoryRecord and MemoryNode
  |    - observed/candidate relations and pending structure
  |    - persistent when crash recovery is required; short-term is a
  |      semantic lifecycle, not necessarily volatile RAM
  |
  `- LTG
       - durable atomic fact | state | event | preference | constraint
       - consolidated strategy | derived concept | typed relation
       - stable semantic addresses and bounded leaf/block hierarchies

STG + LTG + query + session task belief + tool observations
       |
       | select/update under one hard runtime budget
       v
Session Active Graph (mutable, memory-resident, non-authoritative)
  - task frames and selected STG/LTG references
  - temporary tool observations and unresolved working state
  - typed semantic / activation / reasoning edge layers
  - disclosure ledger and total node/edge/evidence/token/depth/latency budget
       |
       | Freeze(VisibleSubset)
       v
ProjectionRevision (immutable exposure and feedback boundary)
```

`MemoryRecord` 是一条可检索的语义陈述，带 provenance 与 STG 或 LTG 生命周期。`MemoryNode` 是记录中一个连贯分组的稳定语义地址。为每条新记忆创建一个永久节点，等于重现一个扁平存储并额外付出图开销，不是目标模型。

`MemoryRecord.eventTime` 是陈述所表示事件的历史时间，可以未知。`MemoryRecord.createdAt` 与 `HistoryRecord.createdAt` 记录保留／写入时间，均不能替代缺失的历史时间。`validFrom`／`validUntil` 描述有效期，而不是发生时间。原始导入话语可以用经过校验的消息／会话时间作为 `eventTime`：这标记话语时间，不一定是话语所提事件的发生时间。已知历史时间的保留独立于展示策略，存储的陈述与证据保持原样。读取边界上的标签遵循[时间证据展示](progressive-retrieval.zh-CN.md#时间证据展示)。

未解决的结构在记录本身上表示，而不是作为一种新的记忆类型。`resolution` 默认是 `resolved`，可以是 `open` 或 `reopened`；open 记录携带 `openedAt` 与一个或多个 `relatedMemoryIds`。这些相关 ID 是可归因锚点，不是推断出的图边。Open 记录保持被索引，并被同时排除在 LTG 基于热度的保留候选与 STG 过期之外。显式 `resolve` 把它们恢复正常保留；显式 `reopen` 把已归档记录恢复到可检索索引。每次转换都追加到 `memory_resolution_events`，保留原因与锚点，且不重写来源历史。

检索给这一状态有界的可达性。当直接检索取回一个锚点，最多两条相关 open 记录会被插入到普通首个证据窗口的末尾附近。它们与其他任何 AG 记录一样消耗相同的节点、证据、层级与 token 预算，且不启动第二次检索级联。Pi 以 `[open]` 渲染它们。因此 harness 保证的只是可达性，而 Agent 决定该未解决项是否要紧，并且必须显式调用 `nmg_remember` 并带 `action=resolve` 或 `action=reopen` 才能修订它。

一条记录可以包含若干原子事实。遵循 chat.completions 的 content-parts 模型，记录仍是单一证据单元（embedding、FTS、provenance 与生命周期都在记录粒度上运作），同时携带由原子 `MemoryClaim` 项构成的 `claims` 数组（`claims_json`）——每项有自己的文本、极性、谓词键、置信度与抽取 provenance。记录级的 polarity/predicate/confidence 列是派生的汇总缓存（首个非中性 claim），永远不是真值来源。矛盾检测连接的是 claim 而不是记录，因此一条长消息内部的矛盾与跨消息的矛盾同样可见。在查询时，`contradictionNotes()` 把每一对检测到的矛盾渲染为附加到被取回陈述上的注释，使答案阶段的读者无需任何宿主侧改动就能看到该标记。

作用域与时间在摄取、关系提议与矛盾渲染中全程使用同一个确定性兼容性模型：

- 作用域对象是精确 `key=value` 约束的合取；
- 当双方共同约束的任何键没有不同取值时，两个作用域重叠；
- 二者的交集是两个兼容约束映射的并集，因此一条宽泛的用户级记录与一条项目作用域记录只在项目交集内冲突，而不是全局冲突；
- 有效性是半开区间 `[validFrom, validUntil)`，缺失的结束端视为无界；
- 相邻区间不重叠，因此描述的是时间上的接续，而不是同时存在的矛盾；
- 畸形、空或倒序的显式区间在写入边界处失败。

查询时的矛盾注释同时要求兼容的作用域交集与重叠的有效性。当重叠比任一来源记录更窄时，渲染出的注释携带取交集后的作用域。`supersedes` 仍是顺序状态变更的常规表示；`contradicts` 保留给在同一语义域内可被判真或假的相反主张。

STG 与 LTG 描述的是语义驻留，而不是两套真值体系。晋升应当保留同一稳定记录／节点身份与 provenance，而不是把内容复制进第二个图。降级或过期改变正常可见性，但绝不重写底层 `HistoryRecord`。

AG 包含引用与查询局部注解，而不是权威副本。AG 被释放时，临时节点与边消失；只有显式记录的使用结果、稳定性观察与被接受的写入保留下来。

Harness 本地执行观察遵循同一规则。Pi 扩展会选择性地通过 `observe()` 将近期工具错误、测试结果与被编辑路径捕获为临时的会话本地 AG 观察。运行时的会话级条目数与字符数上限约束保留状态；这不是单独的 FIFO 环形缓冲，也不是持久存储。turn 元数据可用时，常规 Pi 投影只包含当前及紧邻前一个模型 turn 的工具观察。压缩前，扩展会激活有界 AG 投影，供下一轮使用。这些观察不是 `MemoryRecord`，也不会仅因工具运行过就写入 SQLite；所属会话结束时它们会消失。只有显式且经语义判断的 `nmg_remember` 调用才能把结果变成 STG/LTG 记忆。会话压缩仍由 Pi 负责；NMG 不得把注定被丢弃的原始消息区间作为自动「抢救」路径复制进持久存储。

### 影响权限

记忆类型回答**一条记录描述什么**。作用域回答**它可以在哪里适用**。影响权限回答**一条被召回的记录被允许如何改变 Agent 的结果**。这些维度彼此正交：仅凭检索相关性从不授予权限。

初始权限词汇是：

| 权限 | 允许的影响 | 禁止的影响 |
| --- | --- | --- |
| `reasoning_context` | 提供一个受作用域约束、按置信度加权的前提或来源 | 覆盖更新的状态、更强的证据或显式约束 |
| `presentation_style` | 改变语言、语气、细节、排序或格式 | 改变事实结论或工具决策 |
| `interaction_hint` | 建议一种从重复行为推断出的非约束性互动模式 | 从一次观察变成硬性要求 |
| `task_continuation` | 在匹配的任务／工作区内恢复目标、进度、决策与未完成工作 | 把临时状态泛化为用户级偏好 |
| `scoped_constraint` | 在其显式作用域内、在有效期内限制某动作 | 在该作用域之外适用，或在被取代后继续存活 |
| `experience_advisory` | 提供有证据支撑的经验供 Agent／用户解释与适配 | 悄悄变成可执行流程、系统提示、Skill 或强制计划 |

默认映射可以根据记忆类型推断，但有效权限还必须尊重来源、作用域、真值状态、驻留、时近性与取代关系。例如显式表达的偏好通常获得 `presentation_style`；重复的行为观察获得较弱的 `interaction_hint`；项目约束获得 `scoped_constraint`；策略候选获得 `experience_advisory`。

权限在渲染与使用时被强制，而不仅仅写在散文里。在结构化字段被实现之前，适配器必须为每条被选中记录渲染一条显式的使用指示。未来的 schema 迁移可以在测试表明类型派生默认值不足时持久化该权限。

晋升阈值随作用域广度与影响强度一起增长：

```text
session/task < project/workspace < user < team/organization
interaction hint < reasoning context < scoped constraint
```

更广或更改变行为的记忆需要更多独立证据、更强 provenance，以及显式的纠正／回滚路径。

### 可迁移经验

NMG 可以把重复的、与结果关联的片段合并为**可迁移经验**，但它不决定最终的行为产物。经验是关于在何种条件下发生了什么的描述性证据，而不是必须执行的指令。

逻辑经验投影包含：

```text
summary
situation / preconditions
action or approach observed
outcome
possible explanation
applicability and scope
known limitations
counterexamples and failed variants
confidence and independent-task count
source memory, outcome, and HistoryRecord references
```

形成需要多个兼容片段或一条被显式确认的经验、可归因的结果、被保留的反例，以及稳定的作用域。单个成功动作仍是事件或暂定 STG 策略。重复失败降低置信度或收窄适用性；它不抹除原始片段。

NMG 通过普通检索或中立的结构化导出来暴露经验信息。它**不会**创建或修改 `SKILL.md`、系统提示、runbook、脚本、策略或模型权重。当前的 Agent 与用户可以自行决定把同一经验变成上述任一产物——或者完全不用它。把稳定层限制在语义、条件、结果与证据上，能让经验在 Agent 宿主与产物格式变化时继续存活。

因此既有的 `strategy` 记忆被解释为暂定或已合并的经验候选，带 `experience_advisory` 权限，而不是可执行流程。模型可以为当前任务适配它们，但在行动之前必须检查适用性与相反证据。

### 置信度作为后验：结果反馈回路

今天的 claim `confidence` 是一个先验——抽取器在写入时的自评。记忆系统只有当这个数字被一个可归因到某条 claim 的结果纠正之后，才配得上「经验」这个词。仅检索与渲染并不提供那种归因。外部宿主可以在推理之后捕获用户确认、工具验证与 benchmark 证据；模型升级改善先验，但无法替代这个可审计的回路。

机制（最小、确定性）：

1. **观察日志。** 检索、披露与启发式答案重叠是彼此独立的事件。它们支持延迟、覆盖率与互动分析，但不产生有用性票。
2. **已验证结果归因。** 只有当调用者同时指出该 claim 与一个可审计的结果来源时，claim 才收到一票：显式用户确认／纠正、一次验证性工具结果，或官方 benchmark 证据。宽泛的任务成功不会被喷洒到每一条被渲染的 claim 上。结果是携带 provenance 的事件，绝不是静默就地编辑。
3. **后验更新。** Claim 置信度变为 `posterior = f(extraction prior, accumulated outcome votes)`——Beta 式的运行更新把存储保持在每条 claim 两个计数器，并且保持可审计。原始先验被保留，使重新加权规则可以在不重新抽取的情况下改变。
4. **检索加权。** 排序融合消费后验而不是先验：反复有用的记忆更容易浮现；与失败相关的记忆下沉到归档审阅，而不是被删除（历史保持不可变）。
5. **功劳纪律。** 相关不是因果。API 模型的答案重叠、反事实响应差异、工具调用是否存在，以及未被纠正的完成，都仍是诊断，因为模型／provider 漂移使它们成为很差的可移植标签。来自同一任务的已验证票会被去重，而后验只有在有足够独立观察之后才被信任。

这个回路还在 claim 粒度上回应了[开放设计问题](open-design-questions.zh-CN.md)中的部分路由问题：有用性信号活在 claim 上，而不是在 router 的选择上，因此强化一条好记忆不必强化找到它的那条路径。

### 可选互动画像，而非隐藏用户模型

NMG 目前不维护学习到的用户模型。未来适配器可以在重复的跨任务行为显示对召回深度或互动风格有稳定偏好时，保留一份小的、显式的**互动画像**——例如用户反复要求更多结果、在浅层证据后停止，或纠正过于激进的召回。这类黑箱行为测量针对的是用户可观察的选择，而不是 API 模型的隐藏认知。

画像可以调节用户作用域的默认值，例如证据预算、自动召回激进程度，或是否建议再检索一次。它必须使用衰减、最小独立任务数、可检视特征，以及重置／导出控制。单次互动仍是遥测。画像永远不能改变事实真值、claim 置信度、图稳定性、节点合并或全局控制器权重；那些继续需要已验证证据。在这一需求被证明之前，事件日志已经够用，不实现新子系统。
