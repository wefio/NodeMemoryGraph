# 会话推理工作区与压缩检查点

[English](session-reasoning-workspace-and-compaction-checkpoint.md) · [使用的术语](session-reasoning-workspace-and-compaction-checkpoint.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## 会话推理工作区与压缩检查点

长会话需要一小块显式草稿板，因为普通的上下文压缩可能保留结论却丢掉证据路径、被否定的假设与下一步动作。因此 NMG Lab 提供 `ReasoningWorkspace`。它不是又一个持久记忆图，也不是原始的隐藏思维链。它是会话本地的、可审计的状态，经 Active Graph 边界投影。

工作区只记录简短的带类型条目：

```text
goal | observation | hypothesis | evidence | conclusion
decision | open_question | next_action
```

以及显式关系：

```text
supports | contradicts | derived_from | tests
rejects | depends_on | next_step
```

宿主集成遵循一条由 daemon 拥有的生命周期：

```text
model or tool result
  -> existing NMG client: lab enable/invoke
  -> daemon-owned <NMG_DATA_DIR>/lab/reasoning/<session-hash>.json
  -> bounded ReasoningCheckpoint
  -> optional harness injection after its normal compaction
```

NMG 不取代 Pi 的压缩器。`session_before_compact` 只为后续检查点标记工作区，而 `before_agent_start` 消费该标记并注入不超过固定节点数与字符预算的内容。每条检查点行同时携带生命周期状态与结构性支持状态：`referenced`、`linked` 或 `unsupported`。假设保留其状态，不受支持的假设被显式标记，而不是被呈现为已确立的事实。
有用的被否定路径会被保留，以免模型重复已被证伪的工作。

只有受支持、高重要性且证据可追溯的结论或决策才有资格进入后续 LTG 合并。新的 `evidence` 节点至少需要一个非空的证据引用字符串；该原型不会解析字符串，也不验证其目标是否稳定或外部来源。`add` 与 `update` 操作只允许在节点自身有引用、或存在来源经传递可追溯到引用的入向 `supports`/`derived_from` 路径时，把节点状态设为 `supported`；环不能制造支持。恢复经过手工编辑的状态文件时不会重新运行这项检查。若通过 `update` 删除引用会使已受支持的下游节点失去支持，该操作会被拒绝。NMG 保留引用标识符以供审计，但不主张草稿板独立验证了被引用的来源。当前原型只报告这些候选；它不会自动把草稿状态晋升为长期记忆。

在一个会话内，`add` 对规范化后的精确 `kind + content` 组合是重试幂等的。重复调用会复用既有节点，而不合并新的状态、重要性或证据；语义演进与新增证据必须使用显式 `update`。这避免工具重试把图撑大，同时保持变更有审计性。

草稿生命周期被有意绑定到会话。同一 Agent 会话可以在进程重启后恢复其原子文件；新会话永远不会自动继承另一会话的工作区。`clear` 立即删除所属会话。由于草稿板不是持久语义记忆，维护可以移除文件系统修改时间早于 30 天的工作区 JSON 文件，并删除关联的待处理压缩标记。读取与消费检查点不会刷新该时间戳。跨会话任务交接、事件归档以及 STG/LTG 晋升都需要未来的一次显式受审操作；清理绝不能暗示某结论已被验收或已从 LTG 遗忘。

`nmg_lab` 是现有 NMG 客户端（Pi、MCP、DSH 与 CLI）上的稳定能力发现入口；它不是第二个进程或客户端库。Agent 可以获取 `reasoning_workspace`、`memory_graph_reasoner` 或 `controller_shadow` 的有界会话租约，只调用 `lab list` 列出的操作，并在结束时禁用该租约。租约自动过期。`controller_controlled` 与 `controller_active` 不接受任何 Agent 自我授权：既有的候选、评测、回执、回滚与产品门禁仍然强制。项目级／全局自助被有意设为不支持。

Daemon 拥有 Lab 状态并执行原子推理工作区写入。Pi 仍可在 `NMG_ENABLE_LAB_TOOLS=1` 下暴露便利的 `nmg_reason` schema，但该工具现在委派给同一个 daemon `lab` RPC。`session_before_compact` 仅在会话能力处于活动状态时记录一次性标记，下一次 `before_agent_start` 消费一个有界检查点。MCP、DSH 或其他宿主可以使用同一状态而无需导入 Pi 代码。Lab 输出永不进入 STG/LTG，除非另经受治理的 remember 边界提交。

历史记录称，一个自动输入捕获与检查点注入的变体曾实现并于 2026 年 7 月被否决。在一次匹配的 DeepSeek V4 Flash 开发运行中（三个任务、三次重复），完整上下文基线与自动变体都得分 100%，但平均延迟从 7.0 s 升到 9.8 s。在普通 Pi 压缩之后，基线得分 100%，而自动注入得分 77.8%，并把平均延迟从 11.9 s 升到 15.7 s。显式 `nmg_reason` 调用还要更慢；本地工具执行只占约 0.1--0.2 s，表明成本主导项是额外的模型轮次，而不是本地图操作。

因此 NMG 不会自动把每个用户 turn 解析进推理工作区，也不会在普通 turn 注入该工作区。草稿板仍然是一项显式 Lab 能力，用于需要可审计推理检查点的任务。一次调用即正确，应当改为来自稳定的宿主分层：有界常驻上下文、受门控的长期召回、感知 provenance 的检索，以及仅在首次检索不足时进行的渐进证据扩展。
