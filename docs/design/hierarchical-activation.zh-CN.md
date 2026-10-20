# Hierarchical Activation：实验路径与设计边界

[English](hierarchical-activation.md) | [简体中文](hierarchical-activation.zh-CN.md) · [术语](hierarchical-activation.terms.yaml)

实验引擎和显式评分模式已经存在；默认 vector route 仍使用 cosine。当前路径未证明 Session Active Graph admission、按 branch 隔离的状态、持久化训练 session state，或基于质量的激活 gate 已实现。

## 当前源码行为

- `HierarchicalActivation` 实现在 [`src/core/hierarchical-activation.ts`](../../src/core/hierarchical-activation.ts)，有针对性测试 [`tests/core/hierarchical-activation.test.ts`](../../tests/core/hierarchical-activation.test.ts)。
- `NmgStore.routeNodesByVector()` 的 `activationMode` 默认值为 `"cosine"`。调用方可以显式传入 `"hierarchical-activation"`；普通检索路径不会默认选择该模式。参见 [`src/core/store/graph.ts`](../../src/core/store/graph.ts) 和 [`src/core/store/retrieval.ts`](../../src/core/store/retrieval.ts) 中对应的声明。
- Store 显式路由会向 `propagate()` 传入候选向量，但不会传入 neighborhood 或 `GraphStateSnapshot`。因此该路径中的 `g₂` 回退为 `g₁`，`h₂`、`h₃` 为零值，`h₁` 是 EMA state。一般 `propagate()` API 可以接收 neighborhood 和 medium／long-term vectors，但此能力没有接入该 store 调用。
- `Router.ensureHA()` 将 session 实例保存在按 `sessionId` 为键的进程内 map 中，没有按 branch 分键。`Router.toJSON()` 只序列化非 session 实例，不会序列化 session map。这不能证明该 session state 是持久化的或归 Active Graph 所有。
- Store 注释表示，trained state 在通过 rollout gates 前不应取代确定性检索。但显式模式分支本身没有执行 training-state 或 benchmark gate。应将该注释视为设计意图，而非已强制执行的 admission 检查。
- 路由方法返回评分后的结点；本次源码审阅未发现它执行 Session Active Graph admission 或更新 `ProjectionRevision`。

`HierarchicalActivation.train()` 和 `Router.trainHierarchical()` 作为显式 API 存在；这不代表常规产品训练循环、持久化 session state 或质量收益已经建立。本文不声称这些测试或 benchmark 已通过；当前结果应查阅对应验证产物。

## 历史设计意图

早期中文设计提出三种空间摘要（`g₁`、`g₂`、`g₃`）、时间状态（`h₁`、`h₂`、`h₃`），以及融合 query 相似度、图上下文和时间上下文的多信号分数。它还提出按 session／branch 隔离 `h₁`、从 STG／LTG 投影、与 differentiable controller 联合训练，以及最终接入 Session Active Graph admission。这些属于设计假设，不是当前 `routeNodesByVector()` 契约。

为避免读者把早期提案误当成已实现的运行时行为，本文已将原有接口草图、参数表、训练损失和分阶段路线压缩为历史背景。实现事实以当前源码和测试为准；有日期的提案仅作历史参考。

## 源码参考

- [Hierarchical activation 引擎](../../src/core/hierarchical-activation.ts)
- [Router 与 session 实例生命周期](../../src/core/router.ts)
- [显式 vector route 与默认模式](../../src/core/store/graph.ts)
- [Retrieval mixin 声明](../../src/core/store/retrieval.ts)
- [Hierarchical activation 测试](../../tests/core/hierarchical-activation.test.ts)
- [当前实现沿革](implementation-lineage.md)