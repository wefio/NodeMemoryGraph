# 会话级 Active Graph 运行时

[English](2026-08-29-session-active-graph-runtime.md)

**Status:** implemented
**Approved:** unrecorded
**Relates to:** [会话 AG 运行时蓝图](../../design/session-active-graph-runtime-design.md)

## 问题

NMG 曾用 Active Graph 表示一次查询的检索结果，同时 Pi 适配器另有扁平的
`SessionRuntimeAg` 保存近期工具状态。这两套结构分别承担工作记忆的一部分，重复了
生命周期逻辑，也没有为 `AG_t = Project(STG, LTG, q_t, task_t)` 中的稳定任务状态
提供明确所有者。`activeGraphId` 同时等于检索轨迹 ID，因而无法区分可变工作图和
不可变暴露记录。

层次化激活（HA）和 Memory-Graph Reasoner（MGR）已经提供候选激活与图遍历原语，
但当时位于运行时旁路，没有共同作用于一张受预算约束的工作图。

## 决策

AG 是**会话所有、可变、纯内存的运行时图**。它是唯一的工作记忆容器，但仍然不是权威
记忆：持久事实和来源留在 STG/LTG，拥有它的会话释放时 AG 消失。

AG 可包含任务分区、STG/LTG 引用、受限工具观察、临时关系、未解决工作状态、推演
产物、激活元数据和披露账本。它可保留一个活跃任务分区以及少量有界的 cooling 分区，
从而在任务切换时不销毁状态，返回旧任务时也不必完全依赖 transcript 重建。

每次向模型披露内容时，从可变 AG 冻结一个不可变的 `ProjectionRevision`。四个身份
必须明确区分：

- `agId`：会话工作图；
- `taskFrameId`：AG 内一个语义任务分区；
- `projectionId`：一次不可变的选择、披露与反馈边界；
- `boardChannelId`：Task Board 协作频道。

更新过程为：

```text
candidates_t = Project(STG, LTG, q_t, TaskBelief_t)
AG_(t+1) = Update_B(AG_t, candidates_t, observations_t, TaskBelief_t)
Projection_t = Freeze(VisibleSubset(AG_(t+1)))
```

`B` 是节点、边、证据、token、图深度、临时观察、推演步数、任务分区和延迟的总硬预算。
HA 负责激活、降温、重新激活和预算分配；MGR 可遍历选中的 AG 子图并产生受限的假设
节点或推理边；随后 HA 可在冻结 projection 前重新评分这些产物。

AG 内部必须区分三层边，且它们不能静默互相强化：

1. 来自 STG/LTG 引用的语义边；
2. HA 产生的激活/注意力边；
3. MGR 产生的假设推理/算子边。

激活不等于真值，MGR 输出也不等于记忆写入。MGR 产物初始必须是有来源、带 TTL 的
假设，只能通过独立的验证或显式 `remember` 路径进入 STG/LTG。若以后需要持久化
HA/MGR 参数，它们属于版本化 controller/Lab 状态，而不属于 AG。

query-scoped `ActiveGraph` 改为 projection revision，Pi 适配器的扁平
`SessionRuntimeAg` 已删除，injection window 并入 AG 的披露账本。当时的 API 是实现
现状，不构成目标设计的兼容要求。

本决策设定的条件，每条都是对运行时及其宿主接线的要求：

- 规范设计明确区分 AG、task frame、projection revision 和 Task Board channel；
- AG 只存在内存并归属会话；AG 内容不会作为权威语义记忆持久化；
- projection revision 冻结模型实际看到的证据，并在 AG 变化后仍支持精确 get、归因、
  验证结果与回放；
- 工具观察和语义记忆引用共享一份 AG 总预算，但不会因此成为持久写入；
- HA 快状态按 session/branch 隔离；激活本身不能提高语义置信度或边稳定度；
- MGR 只消费受预算约束的 AG 子图，保留派生来源，并输出带 TTL 的假设产物；
- 任务切换测试覆盖连续任务、A→B、A→B→A、共享约束、误切换、压缩和会话清理；
- 当前 query AG、Pi runtime AG 和 continuation map 被迁移或删除，而不是成为永久
  兼容层。

## 考虑过的替代方案

1. **保留 query-scoped AG，另加任务状态管理器。** 改动较小，但继续保留两套工作记忆，
   并让压缩和任务恢复依赖各适配器实现。
2. **把 AG 持久化为第三张语义图。** 拒绝，因为临时激活、工具状态和假设会与长期
   记忆及共享真值混淆。
3. **让 MGR 或 HA 拥有工作记忆。** 拒绝；评分器和推演器应保持可替换，不应拥有
   证据、会话生命周期或披露来源。
4. **整场 session 视作一个任务。** 拒绝；主题漂移会造成污染，而每次 query hash
   也不能可靠表示边稳定度所需的独立任务。

## 后果

- 承载本决策的运行时是 `src/core/session-active-graph.ts`：一个活跃分区加有界
  cooling 集合、分区内的 parent chain、跨分区的统一条目/字符预算、产物上的
  `ttlMs`，以及宿主用 `markDisclosed` 写入的披露账本。
- 问题里点名的三层兼容结构均已消失：Pi adapter 的 runtime AG 被删除，continuation
  map 不再存在，query-scoped AG 已成为 projection revision；四个身份之分也消除了
  当时 `activeGraphId` 兼作轨迹名的歧义。
- 每项能力的当前状态以及它与代码的对应关系由[运行时蓝图](../../design/session-active-graph-runtime-design.md)
  §4 拥有，本记录不重述那张状态表。
- 披露账本是宿主中立的：Pi 扩展、Claude 插件、WorkBuddy 和 DSH 都通过运行时标记
  projection，而不再各自保留 injection window；若某宿主仍保留一份，同一规则就有了
  第二个家。

## 未完成项

- 多维共享总账（蓝图 4.3）：运行时已有跨分区的条目与字符上限，语义/工具/推演合成
  一本账仍未完成。
- MGR 自动准入（蓝图 4.4）：带 TTL 与来源的产物原语已实现，未经显式动作即接纳
  MGR 输出仍然延后。
- AG 上的 HA 准入与重新评分（蓝图 4.6）：在有自然效用证据前有意延后；显式 Lab
  调用及其隔离仍然可用。
