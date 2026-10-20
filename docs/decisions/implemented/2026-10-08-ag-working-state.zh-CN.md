# 帧内唯一的 AG 当前工作状态

**Status:** implemented
**Approved:** explicit
**Relates to:** [持续状态提案](../proposed/2026-10-06-ag-state-transitions.zh-CN.md)

English: [2026-10-08-ag-working-state.md](2026-10-08-ag-working-state.md) · [术语](2026-10-08-ag-working-state.terms.yaml)

## Problem

按正文哈希加入 observation 会累积版本，不能替换当前状态。共享信息输出基础
保护了显示正文，却没有当前状态写入器。需要一个小型暂时载体，不增加独立库、
schema 引擎、宿主专属执行器或新的权威。

## Decision

在[共享输出基础](2026-10-07-shared-information-output.zh-CN.md)之后，只实现切片 B
中有边界的当前状态。宿主输入选择与收益验证独立推进；不宣称 A–D 已完成，
也不把维护机制当成模型成本下降的证据。

- 每个既有 `FrameState.items` 最多有一个 `working_state`，保留固定帧内 item
  身份、完整正文、内容哈希及捕获绑定的来源。替换不追加 item。它是暂时工作
  内容，不是隐藏推理、语义记忆或协作验收。
- 专用 runtime bind/replace/clear 控制写入；普通 `observe` 拒绝该 kind。
  相同正文返回 `unchanged`，成功替换返回 `updated`，幂等清空返回 `cleared`。
  确认不回显正文，不证明正确，也不产生披露或学习证据。
- 先检查绑定、非空正文、既有秘密模式规则、状态上限及全 session 驻留容量，
  再修改。拒绝保留旧正文及其他内容，不靠截断或淘汰宣称写入成功。上限不得
  超过驻留容量，也不得超过 8,000 个 UTF-16 code units 的准备预算减去暂时标签
  和分隔空格；允许配置更小上限。
- 状态占用 active＋cooled 的既有 item/character 总预算，但普通 item 淘汰不得
  静默移除它，因此可能减少检索／observation 容量。显式 clear、帧／session
  淘汰、release 和进程重启移除状态；清理可见性不清空状态。
- 可信调用方捕获 `{sessionId, agId, taskFrameId, bindingId}`。写入必须仍匹配
  AG 实例、活动帧和当前绑定；切帧、重绑或释放拒绝已捕获的迟到操作。绑定只是
  上下文 fencing 元数据，不是认证或权限本身；仍依赖既有可信 daemon／客户端边界。
- 既有 `nmg_lab` 可发现 session-only、自助启用的 `working_state` 租约，只提供
  `replace(input={text})` 与 `clear(input={})`。模型操作输入不能选择帧或任意 patch。
  service 启用时捕获绑定；普通客户端在传输前、模型参数之外附加它，重试不得
  刷新已提供的 fence。裸 RPC 调用方须自行提供捕获元数据。disable／到期撤销
  写权限，不删除正文。
- 当前适配器明确采用启用期间的 **session 工作帧**。搜索查询变化只在同一帧
  冻结新投影；未显式指定帧的 observation 使用当前帧。此为明确退化，不是语义
  任务识别，也不承诺适配器 A→B→A 恢复。库调用方可绑定真实可信任务帧，
  但不能由模型选择归属。
- 共享 AG 准备视图在普通暂时 observation 尚未激活时，也可承载带暂时标签的
  当前状态，仍按整项执行输出预算省略。准备不证明实际模型输入可见。
  普通工具、JSON／RPC 和库使用者不需要 Pi/codemode、新工具、执行器或额外输出调用。

## Consequences

既有 owner 仍为 `src/core/session-active-graph.ts`、
`src/integration/lab-capabilities.ts`、`src/cli/protocol.ts`／`service.ts` 和普通
 daemon／CLI 传输客户端。`agent-surface.ts` 投影状态；提示词只改
`src/prompts/nmg-prompts.yaml` 并由生成器更新。Pi、MCP、DSH 保持薄工具注册，
包导出 runtime 绑定和普通客户端 helper。

确定性回归覆盖替换身份、完整长正文及哈希变化、unchanged／clear、空白／秘密／
超限拒绝、总预算拒绝保留内容、普通淘汰保护、session／帧隔离、重绑／重建／淘汰
fencing、清可见性不删状态、Lab discovery／opt-in、受限操作输入、查询稳定退化、
客户端捕获且重试不刷新以及短确认显示。没有通过 live LLM、embedding 请求或
记忆 benchmark 证明收益。

## Deferred

- 逐次模型输入的实际披露确认与 output-to-ledger 提交。
- 可靠语义任务身份、适配器任务帧恢复、并发写入；首切片所属 Agent 更新仍串行。
- Pi 的按回合状态携带已由独立的
  [携带切片](2026-10-08-ag-working-state-input.zh-CN.md)实现。其他宿主尚无等价
  携带路径；两个切片都不提供最终发送确认，也不改写受保护历史。
- 统一动态模型输入预算、包装／写入／读取成本，披露时权限／版本复核，以及匹配的
  连续性／成本测试。
- 持久事件归档、任务／协作权威及语义晋升；它们保留独立 owner，不能由维护推出。

## Alternatives considered

- 每次正文变化加入哈希 observation：拒绝，旧版本仍 live，不代表唯一当前值。
- schema／JSON patch 引擎或独立状态／workspace 库：拒绝，完整正文替换和既有
  帧生命周期足以承载本切片。
- 模型参数选择归属或刷新失效 fence：拒绝，迟到内容不能借用另一激活的上下文。
- 查询哈希或 board channel 推断任务：拒绝，它们不建立可信语义身份；显式 session
  退化更诚实。
- 同时替换宿主历史或宣称模型节省：推迟，维护、实际可见性和真实收益需要不同证据。
