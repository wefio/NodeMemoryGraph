# 会话 AG 更新与投影修订

[English](session-ag-and-projection-revisions.md) · [使用的术语](session-ag-and-projection-revisions.terms.yaml)

**Authority:** [父级范围](../active-graph-activation-and-consolidation.md)。

## 会话 AG 更新与投影修订

对查询 `q_t`、当前任务信念 `TaskBelief_t` 与有界运行时观察 `O_t`，NMG 的目标是：

```text
candidates_t = Project(STG, LTG, q_t, TaskBelief_t)
AG_(t+1) = Update_B(AG_t, candidates_t, O_t, TaskBelief_t)
Projection_t = Freeze(VisibleSubset(AG_(t+1)))
```

`AG_t` 可变，但归会话所有并驻留内存。`Projection_t` 不可变，并精确记录模型当时能看到什么。`B` 是唯一一个硬性多维预算，覆盖注入 token、节点、边、记录／证据片段、临时观察、任务帧、推理步骤、本地 tier/depth、图扩展与延迟。AG 可以包含：

- 常驻的关键 LTG 约束；
- 新激活的 STG 观察与任务状态；
- 检索到的 LTG 节点与有界本地内容；
- 选中的持久关系；
- 仅用于当前任务的临时 STG 到 LTG、LTG 到 LTG，或查询局部关系；
- 保持虚拟且归会话所有的有界宿主本地工具观察；
- 一个活动任务帧与一个小的有界冷却集合，使任务可以返回而不必保留无界 transcript。

身份是显式的而非被重载：`agId` 拥有会话运行时，`taskFrameId` 划分 AG 内的语义工作，`projectionId` 命名一个不可变的暴露／反馈边界，`boardChannelId` 命名一个 Task Board 协调频道。当前的 `activeGraphId` 与查询哈希 `taskId` 行为是需要迁移的实现证据，不是兼容性约束。

AG 可以充当一个 Agent 的**私有工作黑板**，但 AG 本身无法跨 Agent 通信。需要协调时，Agent 使用 daemon 中独立的、按任务划分的 **Task Board**。其带归属、会过期的条目通过任务本地游标读取，并投影进每个调用者的私有 AG。它们永远不会被插入记忆记录、FTS、embedding、QPP 或 LTG 检索。Agent 可以另经 `remember` 接纳一条受支持的持久结论。

```text
Agent A private AG ─┐
                    ├─ read/write ─ Task Board(taskId, cursor, TTL)
Agent B private AG ─┘                       │
                                           └─ explicit remember only ─▶ STG/LTG
```

**实现状态：** daemon 拥有有界、驻留内存的会话 AG 注册表。每次服务检索在保留稳定会话 `agId`、单调投影序号、`taskFrameId`、父修订与已持久化检索 `traceIds` 的同时，冻结一个独立的 `projectionId`。`get`、诊断归因与 claim 结果把投影解析到其所属 trace，并拒绝跨会话使用。Pi 工具与 Task Board 观察经 `sessionActiveGraph` 进入共享运行时；压缩会激活临时状态并清空内容披露账本，而会话关闭会释放 AG。Pi、DSH、WorkBuddy 与 MCP 使用该 daemon 账本来做有界内容哈希／深度折叠，而不是适配器本地的注入缓存。显式任务帧、有界冷却与帧本地父链已实现；可靠的**自动语义**任务帧分类仍未完成，且不得从当前由查询派生的任务标识符推断出来。

共享 Task Board 在 SQLite 中实现，并由 daemon RPC 与 CLI 暴露（`nmg board put/read/resolve`）。适配器默认暴露 `nmg_state` 的 board 操作与 wake 轮询；`NMG_ENABLE_COORDINATION` 的 false 类取值会抑制 board 操作，而不是私有 AG 状态。它记录 `agentId` 与来源会话，支持任务隔离、游标读取、TTL 删除与显式解决。普通 Pi 读取会把开放条目作为临时 `board_projection` 项暂存到调用者的 daemon 所属会话 AG 中；历史读取不暂存条目。成员关系／ACL 与远程多设备传输未实现；共享同一 daemon 的本地调用者必须就一个任务 ID 达成一致，并应设置稳定的 `NMG_AGENT_ID` 值。

AG 与 Task Board 通过 `core/information-view.ts` 与 `integration/information-output.ts` 共享已准入信息视图与纯文本准备。领域所有者仍然强制访问与生命周期。正文加必需标签在每表面字符预算下不可分割；私有临时 AG 陈述不会被显示预览截短。长 board 约定是可选的，紧凑读取保留交付／裁决元数据。准备好的来源指纹不是 `projectionId`、不是验收，也不是披露证明。精确片段确认只返回读者本地候选；宿主确认的账本承诺仍未完成。Pi 的分组动态上下文使用[共享信息项契约](../../state-spaces.zh-CN.md#统一上下文信息项)，包括一个合并的准备预算；这并不确立 provider 发送或成本确认。参见
[基础决策](../../../decisions/implemented/2026-10-07-shared-information-output.zh-CN.md)。

已验收的[状态空间条目契约](../../state-spaces.zh-CN.md)直接使用这个视图／输出基础，为跨 AG 与 board 空间的单个 `state read/write` 条目服务，而不合并它们的所有者。其接口与实现边界由该 topic 与[接口决策](../../../decisions/implemented/2026-10-12-state-space-entry.zh-CN.md)拥有。

显式租借的 AG 工作状态写入者通过 `state` 经专用 replace/clear 为每个帧维护一份精确临时文本，绝不使用普通 `observe`。准入在变更之前检查常驻上限与准备文本上限；普通条目驱逐保护该状态，而帧／会话驱逐与释放会移除它。捕获的会话／AG／帧代数用于隔离迟到写入，而不是调用者认证。普通工具只提供文本或空的 clear 输入；客户端在这些模型参数之外附加上下文元数据。当前适配器在启用时显式使用会话工作帧，使查询变化无法移动该状态。该兜底不是语义任务检测，也不是 A→B→A 恢复。确认只有 updated/unchanged/cleared 三种；写入不带来验收、持久写入、披露或宿主历史移除。专用状态输入携带是一项独立的共享契约：Pi 在持久化的 turn 消息内为每个用户 turn 携带一份准备好的正文，且不注册任何逐推理钩子，因此在一个 turn 内不会被重发或重排。最终 provider 确认仍不受支持；参见
[运行时输入所有者](../../session-active-graph-runtime-design.zh-CN.md#专有状态输入携带)与[工作状态决策](../../../decisions/implemented/2026-10-08-ag-working-state.zh-CN.md)。

共享 Agent 策略在推进多步工作时、在计划或阻塞变化处维护一个紧凑状态锚点，并区分已验证完成与实现、计划。必要事实必须可从仓库或显式共享任务引用恢复，而不只依赖私有 AG 的生命周期。Pi 的只读 widget 与 `/nmg state` 子命令使用既有 snapshot/准备路径，不进行语义检索，也不使用第二个 store。widget 是带标签的预览；该命令返回完整的已准入文本。所有者／读取失败与过期响应不得把陈旧进度呈现为当前。用户呈现与状态维护都不构成披露承诺或协作验收。参见
[日常使用决策](../../../decisions/implemented/2026-10-12-working-state-daily-use.zh-CN.md)。

AG 更新是工作记忆管理，不是复制图。它识别候选节点、更新任务本地运行时状态、分配一份总预算，然后只冻结可见子集。模型可以请求渐进扩展，但宿主同时强制 AG 总预算与不可变的投影／provenance 边界。

投影预算与**构建过程预算**是分开的。限定最终 AG 并不能阻止 Agent 反复发起会重新发现同一批候选的检索。因此 Pi 适配器还把每个用户 turn 限定为三次显式 search 与总计五次 recall 工具调用，允许至多两次没有插入精确证据推进的 search，并在连续两次 search 未增加候选 ID 后停止。新的用户 turn 会重置这个短时守卫。这些是 QPP 与可微控制器之外的确定性宿主限制；学习到的分配可以选择更小的 AG，但无法放松它们。
