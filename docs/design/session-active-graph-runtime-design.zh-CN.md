# 会话 Active Graph 运行时

[English](session-active-graph-runtime-design.md) · [共用术语](session-active-graph-runtime-design.terms.yaml)

**Status:** current
**Updated:** 2026-10-15

用本蓝图查找已实现的会话 AG 核心与剩余验收缺口。已有切片包括任务／分支生命周期、
有界 item、维护状态及宿主中立披露账本。本文细化[设计基线](design.md)与
[AG 运行时决策](../decisions/implemented/2026-08-29-session-active-graph-runtime.md)，
不宣称目标整图已全部集成。

## 运行时是什么

`SessionActiveGraphRuntime`（`src/core/session-active-graph.ts`）是一个 Agent 会话
唯一的工作记忆容器，由 daemon 拥有，驻留内存。它刻意保持非权威：持久真值在
STG/LTG，所属会话 release 时整个活图消失。

设计区分四种身份：

- `agId`：会话工作图，每会话一个。
- `taskFrameId`：AG 内一个语义任务分区。
- `projectionId`：一个不可变暴露／反馈边界，即冻结修订。
- `boardChannelId`：设计中的 Task Board 频道身份；board API 用 `taskId` 选择，
  它不是 AG 帧，也不是新增的 API 参数。

每次面向模型的检索，从可变 AG 冻结不可变 `ProjectionRevision`。get、诊断归因和
声明结果将投影解析回其所属持久 trace，并拒绝跨会话使用。

## 当前实现：已验证核心

以下机制已实现并有测试覆盖：

- 会话级可变图，带稳定 `agId`、单调投影 `sequence`、`latestProjectionId`，
  以及同一任务帧内各投影的 `parentProjectionId`。
- 不可变投影：`deepFreezeGraph` 冻结图、选择、扩展、账本、预算和 usage；
  part 复制到冻结 set。
- 投影到 trace 的来源与跨会话拒绝：
  `projection(projectionId, sessionId)` 对另一会话返回 null。
- `observe()` 支持有界工具观察和 Task Board 投影，kind 为
  `"tool_observation" | "board_projection"`。调用 `activateTemporaryProjection`
  前不向模型显示；按内容哈希去重，按 item／字符预算淘汰。
- `reasoning_artifact` 支持有界 TTL 与明确来源。过期从 live snapshot 移除，
  不改写冻结投影。
- 会话、item、字符、投影均有界；`compareEvictionPriority` 依激活值、再依最近
  激活时间确定淘汰。
- `release(sessionId)` 移除会话及其投影归属。
- `snapshot()` 投影活动语义引用和 `working_state`；临时投影激活时另含普通观察。
- 专用 `bindWorkingState`／`replaceWorkingState`／`clearWorkingState` 每帧维护
  一份精确暂定文本，`observe` 不能写此 kind。替换保留 item ID，更新内容哈希和
  捕获 binding 来源，不创建披露或语义记录。空白、含秘密、过大、陈旧或容量拒绝
  均保留旧值。
- 状态计入同一驻留 item／字符上限，普通 item 淘汰保护它；显式 clear、帧／会话
  淘汰和 release 移除它，清空披露窗口不移除。默认状态上限取驻留容量与
  8,000 UTF-16 code unit 输出准备上限扣除必需临时标签和分隔符后的较小值；
  配置不能提高该上限。
- 经普通[状态空间入口](state-spaces.zh-CN.md) `nmg_state` 启用 AG writer，租用既有权限，
  捕获 session 工作帧 fence。内部旧租约／RPC 路径仍兼容；面向模型的日常 Lab
  用法被拒绝。客户端在模型输入之外附带 fence，重试时不变。同步写入时会话、
  AG 实例代际、活动帧及 binding 仍须匹配；重新绑定、切换、release 使旧写入
  失效。这些元数据用于 fencing，不用于认证。
- 当前工具／RPC 适配器在租约启用时明确使用 session 工作帧，而不是查询哈希。
  库调用者可绑定真正可信的任务帧。语义任务检测和适配器 A→B→A 恢复尚未实现，
  不得从 board 频道推断任务。

运行时测试：`tests/core/session-active-graph.test.ts`、
`tests/core/working-state.test.ts`。服务／客户端合同：
`tests/cli/working-state.test.ts`、`tests/integration/working-state-client.test.ts`。
[工作状态决策](../decisions/implemented/2026-10-08-ag-working-state.zh-CN.md)记录该有界
切片。简短写入回执和表面准备，不是宿主输入替换、可见性提交或成本／连续性证明。

### 专用状态输入携带

共用 `working-state-input.ts` 合同读取当前 snapshot，在共用输出预算内准备一份
完整暂定正文；以会话、AG 实例代际、帧、捕获 binding 及内容／文本哈希 fencing。
它不拥有历史、可见性缓存或第二份存储，始终保持未确认。

Pi 每用户回合携带一次正文，作为 `before_agent_start` 返回、持久化
`nmg-context` 消息中的带标签块。扩展不注册逐次推理 `context` hook，所以同回合
后续模型调用不重复注入，也不重写／删除较早位置。状态不进入混合召回投影。
回合中读取使用已有会话历史或只读 `/nmg state` 视图。owner 不可用、snapshot
属于外部或未完整准备、读取中会话变化时，不贡献正文，也不把旧进度冒充当前进度。
clear／release 从下一回合停止携带，并移除对应活状态；不删除已有宿主消息。
若压缩移除了回合消息而状态仍是当前状态，下一个用户回合重新携带。

该切片所记录的 Pi 1.1.0 hook 表面允许后续替换输入／payload，不提供最终请求体
确认。适配器报告确认不受支持，不向披露账本提交状态暴露。这只是携带，不保证
最终 provider 输入。范围与证据由[携带决策](../decisions/implemented/2026-10-08-ag-working-state-input.zh-CN.md)拥有。

## 文献对照：调查于 2026-09-01

所记录调查是作者事后对照，不是独立语义审稿、需求来源或新一次联网核实。
NMG 的要求来自自己的[设计基线](design.md)、
[AG 运行时决策](../decisions/implemented/2026-08-29-session-active-graph-runtime.md)及
[记忆模型](memory-graphs.zh-CN.md)。历史比较指出相近问题，不证明研究覆盖完整或
测得优越性。

### 研究背景

| 记录的工作 | 引用 | 原调查描述的机制 | NMG 对照 |
| --- | --- | --- | --- |
| MemGPT | [arXiv:2310.08560](https://arxiv.org/abs/2310.08560) | OS 式虚拟上下文、快速 core 与慢速 archival memory、压力触发归档 | 统一预算工作处理有界上下文，不证明选出了最优高信号集合。 |
| A-MEM | [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)，NeurIPS 2025 | 按相似度连接、演化的笔记 | NMG 区分有类型关系、提案和获准持久结构；共现不是结构接纳。 |
| Zep | [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) | 时序知识图与 Graph RAG | 历史／时序链和会话投影处理该问题的不同部分。 |
| AgentFold | [arXiv:2510.24699](https://arxiv.org/abs/2510.24699)，ICLR 2026 | 学习式多尺度上下文折叠、压缩、归并 | NMG 提议确定性任务帧冷却／淘汰，不是比较两者细节损失的实验结果。 |
| Memory surveys | [arXiv:2512.13564](https://arxiv.org/abs/2512.13564)；[arXiv:2505.00675](https://arxiv.org/pdf/2505.00675) | 事实、经验、工作记忆分类 | AG 提供工作上下文，STG/LTG 保存暂定／持久含义。分类用于解释，不是验收测试。 |

### 工程实践

| 记录的来源 | 调查主题 | NMG 对照 |
| --- | --- | --- |
| [Anthropic：有效上下文工程](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Context rot 与选择小型高信号集合 | 硬预算及披露限制输出，不证明所选集合最小或最好。 |
| Anthropic，同上 | 上下文外的结构化笔记 | 帧组织工作上下文；持久笔记须通过受控 `remember`。 |
| Anthropic，同上 | 工具结果清理 | `observe()` 去重／淘汰和披露控制临时输出。 |
| Anthropic，同上 | 隔离的子 Agent 上下文 | 帧隔离是图内类比；Task Board 拥有跨 Agent 协调。 |
| [Context as an Environment](https://arxiv.org/html/2608.21690) | 可经索引恢复的淘汰 | 冷却帧仅在上限内保留时可恢复；不保证已淘汰临时状态可恢复。 |

这些交集支持考虑保留来源、确定性的预算检查，不证明机制全覆盖、淘汰后细节全保留
或 NMG 优于所引系统。STG/LTG 支撑的引用，只有底层记录仍可用时才可检索；
冷却集合有界。[剩余工作](#剩余工作)保留尚未兑现的合同。

## 剩余工作

[剩余工作 owner](session-active-graph-runtime-design/remaining-work.md)拥有本蓝图的
后续切片与停止条件。

## 决策中的验收条件

决策以这些条件作为从 proposed 提升为 implemented 的门槛：

- [x] 区分四种身份：agId／taskFrameId／projectionId／boardChannelId。
- [x] AG 驻内存、会话私有，不将 AG 内容持久化为语义记忆。
- [x] 投影冻结选定检索面，get／归因／replay 解析其来源；不确认最终 provider 输入。
- [ ] 工具观察与检索语义引用共用一份总预算。
- [x] HA fast state 按会话／分支隔离；单有激活不能提高语义置信度或边稳定性。
- [ ] MGR 使用有界选定 AG 子图，记录推导来源，输出假设性 TTL 有界 artifact。
- [ ] 任务切换测试覆盖继续、A→B、A→B→A、共享约束、误切换、压缩、会话清理。
- [x] 适配器局部披露／继续缓存已迁移或删除，不保留永久兼容层。

## 实现沿革

- **核心引入**：协议 v9 session AG RPC、投影注册、Pi 工具／Task Board 接入，
  提交 `e03150c` 为部分引入，归入初始 `SessionActiveGraphRuntime`。
- **后续加固**：有界任务帧／冷却生命周期、分支归属、驻留 item／字符预算、
  TTL artifact。上述当前源码／测试界定这些边界；单一语义／观察总预算和完整推理
  集成仍是验收缺口。
