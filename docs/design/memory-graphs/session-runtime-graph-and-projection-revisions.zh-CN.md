# AG：会话运行时图与投影修订

[English](session-runtime-graph-and-projection-revisions.md) · [共用术语](session-runtime-graph-and-projection-revisions.terms.yaml)

**Authority:** [三张记忆图](../memory-graphs.zh-CN.md)。

## AG：会话运行时图与投影修订

用本参考区分会话工作记忆、冻结的检索投影和持久证据。更新模型为：

```text
candidates_t = Project(STG, LTG, q_t, TaskBelief_t)
AG_(t+1) = Update_B(AG_t, candidates_t, observations_t, TaskBelief_t)
Projection_t = Freeze(VisibleSubset(AG_(t+1)))
```

`B` 是目标多维硬预算，覆盖注入 token、节点、边、记录／证据、临时观察、
任务帧、推理步骤、局部层级／深度、扩展及延迟。最终投影小，不代表可以无界构建。
[运行时蓝图](../session-active-graph-runtime-design.zh-CN.md)区分已有边界与仍未完成的
统一语义／观察预算。

AG 可包含常驻的关键 LTG 约束、新激活的 STG 观察和任务状态、检索出的 LTG 引用及
有界内容、选定持久关系、临时 STG/LTG／查询局部关系、工具观察、未解决工作状态、
激活元数据及假设性推理。一个活动任务帧和有界冷却集合分隔这些工作。

更新是工作记忆管理，不是复制权威图：识别候选、更新对应帧、分配预算，再冻结
不可变修订。模型可以请求扩展，harness 负责执行预算与来源边界。
`ProjectionRevision` 是设计名称，具体运行时暴露 `SessionActiveGraphProjection`；
旧名 `ActiveGraph` 的检索对象不是可变会话容器。`agId`、`taskFrameId`、
`projectionId` 是不同运行时身份。设计中的协调 `boardChannelId` 由 board API
通过 `taskId` 选择，不通过 AG 帧选择。

Pi 另行限制每回合构建过程：最多三次搜索、搜索与 get 合计最多五次；两次搜索后
要求推进到精确证据；连续两次搜索没有新候选 ID 就停止。新用户回合重置计数；
这些是学习／QPP 分配之外的硬限制。

### 维护中的工作状态

每帧既有 item 中最多有一份可替换、暂定的 `working_state`。用普通
[状态空间入口](../state-spaces.zh-CN.md) `nmg_state`，选择 `space=ag`；replace／clear
前必须显式启用会话 writer 租约。日常状态不是面向模型的 Lab 操作。内部旧租约／RPC
仍兼容；迁移由[状态入口决策](../../decisions/implemented/2026-10-12-state-space-entry.zh-CN.md)拥有。

专用 replace／clear 保留精确内容，普通 `observe` 不能写此种 item。空白、陈旧、
含秘密、超尺寸或容量拒绝的写入均保留旧值。状态计入共享驻留上限，不因普通 item
淘汰而消失；clear、帧／会话淘汰或 release 才移除它。disable／租约过期撤销写权限，
不删除文本。捕获的 binding 阻断迟到写入，不认证身份，也不证明事实或协作验收。

适配器启用时明确使用 session 工作帧，不将查询哈希或 board 频道冒充语义任务身份。
宿主／provider 暴露确认、语义切换／恢复、多维 AG 构建预算及匹配收益是独立事项。
[状态决策](../../decisions/implemented/2026-10-08-ag-working-state.zh-CN.md)拥有变更语义；
[输入携带](../../decisions/implemented/2026-10-08-ag-working-state-input.zh-CN.md)拥有 Pi
每用户回合输入路径。清空／释放活 AG 不会删除已持久化的宿主消息或证据 trace。

### 披露与归因

AG 保存引用和运行时注解，不保存权威副本。它可跨回合、随压缩变化，release
销毁活图。明确获准的写入、已记录结果和持久 trace 有各自生命周期。

daemon 披露账本保存记忆 ID、内容哈希、已渲染最大深度及回合。按 daemon 默认值，
十二回合内未变化且已足够深入渲染的内容折叠为 `already_in_context`。请求更深、
证据变化、超出窗口或换会话时重新渲染。默认最多 128 个引用；压缩移除上下文时清空，
会话结束时销毁。它是上下文缓存元数据，不是验证后的使用结果。Pi、DSH、WorkBuddy、
MCP 共用账本，各自渲染；账本失败时展示请求的证据，不静默隐藏。

持久 trace 带所属 harness `sessionId`。公开 trace 读取、披露、诊断及验证反馈必须
携带匹配调用者身份，跨会话访问须在学习／稳定性更新前拒绝。可信库级查询不是认证。
协议 v9 区分会话 `agId` 与不可变 `projectionId`；公开参数 `activeGraphId` 指后者，
内部解析到一条或多条持久检索 trace。

带身份绑定的 `nmg_get` 使精确扩展可观察。自动召回与答案重叠只是诊断性暴露，
不是因果使用证据。获准的 user／tool／task／benchmark 结果遵守声明结果合同；
不能从检索、沉默或仅仅任务成功推断结果。用户／工具摘录、任务来源谱系必须独立
可归因；benchmark 信号不是模型编造的票。Pi 的 `session_before_compact`
清空披露，以便压缩移除的证据可再次渲染。

### 共享 Task Board：跨 Agent 协调，不是记忆图

[Task Board owner](session-runtime-graph-and-projection-revisions/shared-task-board.zh-CN.md)
定义共享协调、私有投影与协作权限。它不是另一张记忆图，也不是发布私有 AG 的旁路。

### AG 生命周期：活图驻内存，修订 trace 持久化

活 AG 可变、会话驻留。不可变投影观察单独持久化：选择、渲染、扩展、精确获取、
诊断性答案匹配、独立支持／反驳结果是不同阶段。API／答案重叠不证明因果使用。
trace 可按接纳规则参与持久化决策；活动内容只是候选信号，不是已经持久化。

```text
STG + LTG ──update──▶ session AG (mutable, memory-resident)
                            │ freeze visible subset
                            ▼
                    ProjectionRevision
                            │ render / expand / nmg_get / verify
                            ▼
                    observation trace (persistent)
                            │ dedupe by session/task/source lineage
                            │ + outcome attribution
                            ▼
                 persistence decision: promote LTG / demote / keep
                            │
                            └────────── updates LTG ──▶ next projection
```

- 单有活动绝不提升或提高稳定性。须按会话／任务／来源谱系去重，并关联结果。
  激活、独立跨任务复用、正面结果合起来也只是提升候选，不自动接纳。
- 不活动可与 `access_count`、`importance` 一起提名 L4/L5 保留审查，是信号，
  不是独立删除许可。
- CLS replay 是“用选定 trace 参与归并”的机制类比，不证明已经部署自动海马式
  replay；仍须遵守[提升规则](../memory-graphs.zh-CN.md#提升与降级)。

#### 常驻关键约束：理论候选

目标常驻集合会进入每次投影。以下是候选理由，不是已接纳的默认选取策略：

- 意图优先效应（Goschke & Kuhl 1993；Marsh et al. 1999，PMID 10226441）
  提供未完成意图持续激活、完成后抑制的动机。它提示常驻与满足后降级，不证明
  NMG 已校准这两者。
- MemGPT 可由 Agent 自编辑、始终在上下文中的 core block 是小型常驻集合的工程
  先例，不是 NMG 依赖。

未决提案用显式 `pinned`／`safety_constraint` marker，并将常驻内容计入预算、
先于可选内容分配。集合如何维护仍未决定。

#### 过滤使用：跨领域 trace 字段

已插桩检索路径可记录可选 `RetrievalTraceInput.filterUsage`，类型 owner 是
`src/core/types.ts`。下列数字仅为示例，不是一次实测：

```json
{
  "dimensions": ["scope.project"],
  "candidatesBefore": 10,
  "candidatesAfter": 4,
  "selectivity": 0.6
}
```

`candidatesBefore` 统计 SQL 返回、尚未后过滤的候选；`candidatesAfter` 统计最终结果
limit 前的存活数，排序不改变基数。`selectivity` 为 `1 - after/before`，无候选时为
零。它们不是 SQLite 内部扫描行数、实测延迟或保证可获得的下推收益。缺失／旧版
遥测不等于测得零。测量边界由 `src/core/store/retrieval.ts` 拥有。

同一记录可服务多个消费者；下表是预期用途，不证明每个消费者已集成：

| 消费者 | 问题 |
| --- | --- |
| 索引决策 | 使用率 × 选择性 × 延迟占比是否足以支持建索引？ |
| 预算投影 | 更小的过滤候选池能否收紧获准预算？ |
| QPP 校准 | scope 特定的分数分布是否需要不同阈值？ |
| Router 学习 | 哪些 scope／过滤上下文可作路由信号？ |
| 保留 | 缺乏需求是否提名某 scope 审查，而不直接授权删除？ |
| Agent 反馈 | 显式 scope 是否能缩小本次查询？ |

索引决策草案由[改进领域](../improvement-areas.md)拥有。潜在消费不等于当前默认
策略，也不是建索引命令。

### 共用信息输出边界

AG 与 Task Board 共用来源绑定的有类型视图及纯输出准备，不共用存储、图身份或
协作权限。准备过程将正文和必需标签一起处理，报告省略项，不能提交披露账本。
匹配片段只产生读者局部的 acknowledgement 候选；另一会话不能确认私有 AG 内容。
视图指纹不替代不可变检索投影，也不证明真值。

[共用输出基础](../../decisions/implemented/2026-10-07-shared-information-output.zh-CN.md)
拥有库／文本边界。维护状态、Pi 输入携带和分组上下文输出预算是已实现切片；
[状态空间](../state-spaces.zh-CN.md)拥有当前输入组合。最终暴露／权限确认及匹配成本／质量
证据仍未完成。输出准备既不确认最终 provider 输入，也不代表多维 AG 构建预算完成。

### 投影生命周期与分层披露设计

[分层披露](../tiered-disclosure-design.md)是投影构建的时间维度：顺序打开层级、暴露
`tiersOpened`，由 `nmg_get` 显式解锁深证据。[边激活](../edge-activation-design.md)
拥有 AG 内机制：节点激活是状态，边激活由其派生，先有界传播再应用预算。
两者都不会让激活成为持久真值信号。
