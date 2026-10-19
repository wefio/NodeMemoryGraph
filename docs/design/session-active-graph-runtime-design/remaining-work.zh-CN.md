# 剩余工作（本蓝图）

[English](remaining-work.md) · [术语](remaining-work.terms.yaml)

**Status:** draft
**Authority:** [上层范围](../session-active-graph-runtime-design.zh-CN.md)。

## 剩余工作（本蓝图）

该决策的验收标准及其当前状态：

| # | 能力 | 状态 | 归属面 |
| --- | --- | --- | --- |
| 4.1 | 任务帧生命周期：切换 + 有界冷却集 + 返回 | **已实现** | `session-active-graph.ts` |
| 4.2 | 分支归属：同帧分支具有正确父链，无跨帧污染 | **已实现** | `session-active-graph.ts` |
| 4.3 | 统一的语义 + 工具 + 推理预算账本 | **部分**：存在运行时条目/字符界限；完整的多维共享账户仍未完成 | `session-active-graph.ts` + 检索预算 |
| 4.4 | 推理产物的 TTL/来源（有界 MGR 输出） | **运行期原语已实现**；自动 MGR 准入仍被推迟 | `session-active-graph.ts` |
| 4.5 | 宿主中立的披露账本（适配器窗口移入 AG） | 对 Pi、DSH、WorkBuddy 与 MCP **已实现** | 运行时 + 适配器 RPC 调用 |
| 4.6 | AG 上的 HA 准入/重打分（可选、受闸门控制） | **有意推迟**，直到存在自然效用证据；独立的 `hierarchical-activation` 检索模式仍可用，与 AG 准入/重打分接线分开 | HA + 运行时接线 |

### 任务帧生命周期

设计意图（[design.md §7.1](../design.md#71-session-ag-update-and-projection-revisions)，[决策](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)）：AG 保留**一个活动任务帧与一个小的有界冷却集**，因此任务切换不会销毁状态，返回时也不必从对话记录重建一切。

具体模型：

- `SessionState` 增加 `frames: Map<taskFrameId, FrameState>`，其中 `FrameState` 持有自己的 `items`、`edges`、`latestProjectionId`、`lastActivatedAt` 与 `parentProjectionId`。
- `registerProjection` 与 `observe` 已经接收显式的 `taskFrameId`；运行时跟踪 `activeTaskFrameId`。切换帧会把前一帧冷却（保留在有界集合中），而不是丢弃它。
- `maxTaskFramesPerSession` 为所有保留帧设上限，其中包括活动帧。新增帧将超出上限时，驱逐最后激活时间最早的已冷却帧（LRU）；有一个活动帧时，最多保留上限减一的冷却帧。
- 返回到已冷却的帧会恢复它自己的父链（下一个投影的 `parentProjectionId` 是该帧的最新投影，而不是另一帧的）。

验收映射（[决策](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)）："任务切换测试覆盖延续、A 到 B 切换、A 到 B 再到 A 返回、共享约束、伪切换、压缩以及会话清理。"

### 分支归属

一个任务帧可以分支（A→B→A 返回，或并发的子目标）。分支规则：

- 每个投影记录它是从哪个帧冻结出来的；父链是帧内局部的，因此返回到某个帧永不跨帧连接。
- `taskFrame(sessionId, taskFrameId)` 暴露某个帧的快照（条目、边、最新投影），以便 Agent 检查已冷却状态。
- 会话释放会清空每一个帧；没有帧能存活于其会话之外。

### 统一的语义 + 工具 + 推理预算

设计意图（[决策](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)）：`B` 是覆盖节点、边、证据、token、图深度、临时观察、推理步数、任务帧与延迟的**硬性总预算**。

当前的 `ActiveGraphBudget`（`types.ts`）只覆盖检索维度（节点/边/证据/token/跳数/层级/延迟）。合并预算增加：

- `maxObservations` 与 `maxReasoningSteps`（或把观察折算进既有的条目/字符界限，并把推理加入 token 预算）；
- 账本新增 `tool_observations` 与 `reasoning_artifacts` 维度，使 `budgetLedger` 报告单一的共享账户，而不是逐调用快照。

运行时在 `observe()`（工具观察）、推理产物准入与专用的当前状态准入处强制执行共享常驻账户：消耗其中之一会减少检索选择同样消耗的那一个条目/字符池。受维护的状态有显式的准入拒绝，并且不会被普通条目的裁剪悄悄移除；它可以减少可用的检索容量。这仍与完整的多维预算和模型输入预算相区分。

### 推理产物的 TTL/来源

设计意图（[决策](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)）：MGR 结果是**假设性的、带归因的、受 TTL 约束的**；它们只能经由单独的、经核验或显式的 `remember` 路径到达 STG/LTG。

- `SessionActiveGraphItem` 为 `reasoning_artifact` 条目增加 `ttlMs` 与 `sourceKind`（例如 `"mgr"`）；条目自 `createdAt` 起经过其 TTL 后过期，一旦过期即被排除在快照之外（并被驱逐）。
- 来源记录在条目上（到 MGR 调用的 `sourceId` 链）；运行时不把任何产物写入 STG/LTG。
- 包含已过期产物的投影仍必须可读（冻结的修订不可变），但活着的 AG 会停止呈现它。

### 宿主中立的披露账本

设计意图（[design.md §7.1](../design.md#71-session-ag-update-and-projection-revisions)，[决策](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#decision)）：Pi 的注入窗口移入 AG 披露账本，使每个适配器通过同一套不可变投影机制暴露模型上下文。

- 运行时记录已披露的投影 ID 以及有界的内容条目：稳定的 memory ID、在该深度可见的表示的哈希、最大披露深度，以及模型轮次数。
- Pi、DSH、WorkBuddy 与 MCP 请求 daemon 把候选分类为新鲜的或已在上下文中，然后保留各自的宿主特定渲染。没有适配器拥有第二个披露缓存。
- 更深的请求或变化的可见内容会被重新渲染。默认情况下，条目在 12 轮之后过期，账本最多保留 128 条记录；运行时选项可以调整这两个限制。压缩只清除披露状态（因为模型上下文已被移除）。具有宿主关闭生命周期的适配器释放整个 AG；无状态的 WorkBuddy hook 没有关闭事件，因此其有界账本一直存活到 daemon 驱逐或重启。
- RPC 失败会退化为展示被请求的证据，而绝不悄悄折叠掉披露无法被确认的内容。

[共享信息输出底座](../../decisions/implemented/2026-10-07-shared-information-output.zh-CN.md)现在把纯粹的准备工作与确切的渲染片段确认分开。它快照已准入的视图、只为确实装得下的、有来源的行取指纹，并返回 reader 局部候选而不写入本账本。遗留的文本接口使用同一套准备工作。实际的下一输入/授权确认与账本提交尚未由该底座接线；仅凭 `details` 或 `structuredContent` 字段名不能确立模型可见性。它的字符上限是按每段已准备文本计的，而不是[统一的语义 + 工具 + 推理预算](#统一的语义--工具--推理预算)中的统一语义/工具/推理预算。

### HA 准入（可选、受闸门控制）

分层激活日后可能针对 AG 对准入/冷却/重新激活打分，并在投影冻结之前对 MGR 产物重打分。现有的 `hierarchical-activation` 检索模式是独立表面；这里所说的 AG 准入/重打分集成尚未接线。该集成不改变语义置信度或边稳定性，也不会在 AG 中增加持久权重。接线仍推迟到存在自然效用证据之后，详见[决策的 Deferred 部分](../../decisions/implemented/2026-08-29-session-active-graph-runtime.md#deferred)。
