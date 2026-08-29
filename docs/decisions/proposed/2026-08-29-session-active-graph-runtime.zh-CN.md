# 会话级 Active Graph 运行时

[English](2026-08-29-session-active-graph-runtime.md)

**Status:** proposed
**Date:** 2026-08-29

**部分实现（2026-08-29）：** protocol v9 与 `SessionActiveGraphRuntime` 已提供
daemon 所有的会话状态、不可变 projection 身份、projection-to-trace 来源映射、Pi
工具/Task Board 观察接入、确定性释放、按会话隔离的 HA 快状态，以及受 projection
预算约束的 MGR 调用。自动 task/branch 生命周期、统一总预算、共享披露账本和带 TTL
推理产物尚未满足验收条件，因此本决策继续保持 proposed。

## 问题

NMG 当前用 Active Graph 表示一次查询的检索结果，同时 Pi 适配器另有扁平的
`SessionRuntimeAg` 保存近期工具状态。这两套结构分别承担工作记忆的一部分，重复了
生命周期逻辑，也没有为 `AG_t = Project(STG, LTG, q_t, task_t)` 中的稳定任务状态
提供明确所有者。`activeGraphId` 同时等于检索轨迹 ID，因而无法区分可变工作图和
不可变暴露记录。

层次化激活（HA）和 Memory-Graph Reasoner（MGR）已经提供候选激活与图遍历原语，
但目前位于运行时旁路，没有共同作用于一张受预算约束的工作图。

## 提案

将 AG 重新定义为**会话所有、可变、纯内存的运行时图**。它是唯一的工作记忆容器，
但仍然不是权威记忆：持久事实和来源留在 STG/LTG，拥有它的会话释放时 AG 消失。

AG 可包含任务分区、STG/LTG 引用、受限工具观察、临时关系、未解决工作状态、推演
产物、激活元数据和披露账本。它可保留一个活跃任务分区以及少量有界的 cooling 分区，
从而在任务切换时不销毁状态，返回旧任务时也不必完全依赖 transcript 重建。

每次向模型披露内容时，从可变 AG 冻结一个不可变的 `ProjectionRevision`。明确区分：

- `agId`：会话工作图；
- `taskFrameId`：AG 内一个语义任务分区；
- `projectionId`：一次不可变的选择、披露与反馈边界；
- `boardChannelId`：Task Board 协作频道。

目标更新过程为：

```text
candidates_t = Project(STG, LTG, q_t, TaskBelief_t)
AG_(t+1) = Update_B(AG_t, candidates_t, observations_t, TaskBelief_t)
Projection_t = Freeze(VisibleSubset(AG_(t+1)))
```

`B` 继续作为节点、边、证据、token、图深度、临时观察、推演步数、任务分区和延迟的
总硬预算。HA 负责激活、降温、重新激活和预算分配；MGR 可遍历选中的 AG 子图并产生
受限的假设节点或推理边；随后 HA 可在冻结 projection 前重新评分这些产物。

AG 内部必须区分三层边，且它们不能静默互相强化：

1. 来自 STG/LTG 引用的语义边；
2. HA 产生的激活/注意力边；
3. MGR 产生的假设推理/算子边。

激活不等于真值，MGR 输出也不等于记忆写入。MGR 产物初始必须是有来源、带 TTL 的
假设，只能通过独立的验证或显式 `remember` 路径进入 STG/LTG。若以后需要持久化
HA/MGR 参数，它们属于版本化 controller/Lab 状态，而不属于 AG。

当前 query-scoped `ActiveGraph` 改为 projection revision。Pi 的扁平
`SessionRuntimeAg` 在工具观察进入共享 session AG 后退化为短暂事件接入缓存或被删除；
injection window 并入 AG 的披露账本。现有 API 只是实现现状，不构成目标设计的兼容要求。

## 考虑过的替代方案

1. **保留 query-scoped AG，另加任务状态管理器。** 改动较小，但继续保留两套工作记忆，
   并让压缩和任务恢复依赖各适配器实现。
2. **把 AG 持久化为第三张语义图。** 拒绝，因为临时激活、工具状态和假设会与长期
   记忆及共享真值混淆。
3. **让 MGR 或 HA 拥有工作记忆。** 拒绝；评分器和推演器应保持可替换，不应拥有
   证据、会话生命周期或披露来源。
4. **整场 session 视作一个任务。** 拒绝；主题漂移会造成污染，而每次 query hash
   也不能可靠表示边稳定度所需的独立任务。

## 验收标准

- 规范设计明确区分 AG、task frame、projection revision 和 Task Board channel。
- AG 只存在内存并归属会话；AG 内容不会作为权威语义记忆持久化。
- projection revision 冻结模型实际看到的证据，并在 AG 变化后仍支持精确 get、归因、
  验证结果与回放。
- 工具观察和语义记忆引用共享一份 AG 总预算，但不会因此成为持久写入。
- HA 快状态按 session/branch 隔离；激活本身不能提高语义置信度或边稳定度。
- MGR 只消费受预算约束的 AG 子图，保留派生来源，并输出带 TTL 的假设产物。
- 任务切换测试覆盖连续任务、A→B、A→B→A、共享约束、误切换、压缩和会话清理。
- 当前 query AG、Pi runtime AG 和 continuation map 被迁移或删除，而不是成为永久兼容层。

## 风险

- 过度任务切分会破坏因果连续性；切分不足会保留无关状态。
- 若激活、推演、语义置信度和稳定度没有类型隔离，HA 与 MGR 会形成自强化回路。
- 可变会话状态增加并发、分支所有权、清理和确定性回放的复杂度。
- 多个 cooling task frame 可能消耗内存与 prompt 预算却没有实际收益。
- 在共享运行时落地前先改适配器，会制造更多重复实现；应先实现 Core session AG 和
  projection 契约，再做宿主接线。
