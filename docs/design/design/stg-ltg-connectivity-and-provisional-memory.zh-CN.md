# STG/LTG 连通性与暂定记忆

[English](stg-ltg-connectivity-and-provisional-memory.md) · [使用的术语](stg-ltg-connectivity-and-provisional-memory.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## STG/LTG 连通性与暂定记忆

语义图不要求连通。它的连通分量可以代表互不相关的项目、偏好、人物或历史主题。

连接以三类方式建立：

1. **Provenance 链接是即时且强制的。** 每条语义记忆都必须能到达其精确的来源消息、会话或工具结果。
2. **确定性身份链接在已知时即时建立。** 例子包括显式项目作用域、匹配的 `stateKey + scope`，以及受支持的取代关系。
3. **推断出的语义链接是延迟的。** `related_to`、因果、依赖、合并与拆分提议需要累积证据或显式确认。

仅凭关系类型并不授予写入权限。建立策略取决于该边是否由创建它的事务机械蕴含：

| 关系族 | 即时来源 | 其他情况 |
| --- | --- | --- |
| provenance（`derived_from`） | 具有精确来源记忆 ID 的 Core 派生事务 | 拒绝；模型断言不是 provenance |
| 生命周期（`supersedes`） | 经过验证的同域状态转换，且前驱链无环 | 保留两种状态并请求显式解决 |
| 变换结构（`is_a`、重定向） | 经审阅的合并／拆分事务与回滚日志 | 存为拓扑提议，而不是合并后的边 |
| 显式域附着（`applies_to`、`part_of`） | 宿主／工具为两端提供稳定 ID 与可归因证据 | 提议或 STG 观察 |
| 规制性（`contradicts`、`exception_to`、`distinct_from`） | 在作用域／时间兼容性检查之后的显式可归因判定 | 提议；绝不只凭检索共现推断 |
| 身份／细化（`same_as`、`refines`） | 经审阅的拓扑提议；`same_as` 仍需单独的可逆合并执行器来规范化身份 | 保持节点分离 |
| 因果／依赖／支持（`causes`、`depends_on`、`supports`） | 显式可归因证据或经审阅的提议 | 在获得独立支持之前保持 STG 观察 |
| 联想（`related_to`） | 由独立已验证结果进行的稳定性合并，或显式管理性关系 | 共检索仍只是观察 |

因此「即时」意味着_受治理操作所蕴含_，而不是「模型以高置信度选择了一个关系标签」。Core 方法可以在同一事务内物化这类边；面向模型的 `remember(action="relate")` 创建的是待处理提议。管理性的 `linkNodes` 仍然是显式信任边界，不得被暴露为无人值守的模型权限。

新的语义候选首先进入 STG，除非某条受治理规则可以安全地立即晋升该原子记忆：

```text
HistoryRecord
  -> governed extraction
  -> STG semantic inbox
       |- confirmed durable atom -> preserve ID and promote to LTG
       |- high-confidence match  -> attach to an existing STG/LTG node
       |- explicit new concept   -> create provisional STG node
       `- ambiguous              -> remain globally searchable and unassigned
```

已确认的用户事实、偏好、约束、可替换状态、显式 remember 请求，以及经工具验证的事实可以走即时晋升路径。它们的原子内容可以持久，而无需提交推测性的图结构。由共现、推理或单一任务推断出的关系留在 STG 中作为观察或候选，直到满足合并标准。

在已实现的路径中，普通 `remember` 有意不创建任何语义边。一次 search 会把共同取回的节点对记录为候选观察；Pi 适配器在 `agent_end` 处把答案重叠仅记录为诊断归因。只有由已验证有用证据支持、跨配置的最小独立任务数、并越过稳定性阈值的节点对，才可以被合并为 `related_to`。显式 `remember(action="relate")` 创建可审阅的拓扑提议，而不是绕过该门禁。`is_a` 由经审阅的拆分创建，而 `derived_from` 记录显式派生记忆的 provenance。因此，一个年轻或不相关的 store 正确地可能包含孤立节点，但普通 Pi 使用仍然必须累积候选观察与后续已验证结果。

隐式答案归因被有意做得保守且语言感知，但仍属诊断性质：
拉丁文本使用有区分度的整词，而连续汉文本使用字符双字组。它有助于审计检索到的文本是否浮现，以及选择向用户询问哪一次检索。它和精确 `get` 读取都不能提升边稳定性。历史共检索观察不会被回溯补记为有用：只有未来的用户、工具或 benchmark 验证结果才可以这样做。

> 暂定记忆规则、隔离要求、STG 与 Delta 的区别以及晋升／降级阈值，集中见
> [memory-graphs.zh-CN.md](../memory-graphs.zh-CN.md)，尤其是“STG：暂定记忆”“隔离”“STG 与索引 Delta”及“提升与降级”部分。

STG 记录与孤立／暂定节点必须参与全局 FTS、精确、时近性与可选向量检索。图遍历是候选扩展机制，绝不是唯一检索入口。STG 条目可以为崩溃恢复与跨 turn 连续性而持久化在 SQLite 中；过期是策略决策，并不意味着短期数据必须只存在于内存中。

这里的「全局」指所属会话内的所有检索模式，而不是跨会话可见。多 Agent 运行时必须在 search 与精确访问中携带不可伪造的 `runtime_id` 与 `session_id`，并且每条 STG 行、临时边、AG trace 与反馈事件都必须按该身份过滤。单独的 `semantic_task_id` 用于跨 Agent 去重重复证据；它不得被用作隔离身份。当前实现每个项目使用一个物理 STG store，并按行使用 Pi `sessionId` 隔离。所有者过滤适用于直接检索、open-memory 附着、图扩展、精确读取与返回的关系；共享 cache 行（`session_id IS NULL`）保持显式可见。AG trace 持久化同一所有者并拒绝跨会话读取与反馈。单独且不可伪造的 `runtime_id` 仍是未来的宿主边界，因为 Pi 目前不向该适配器提供它。

语义 STG 与既有索引 `Inbox/Delta` 不同。STG 跟踪记忆生命周期与暂定含义。索引 Delta 跟踪那些派生 leaf/vector 索引尚未压缩的记录。一条长期记忆可以位于索引 Delta 中，而一条短期记忆可能已有压缩后的索引。

孤立节点之后可以作为别名被合并、作为父级之下的细化、与另一个独立概念相连，或保持孤立。增加一条边并不意味着合并节点身份。

一般语义关系可以成环。派生与取代依赖必须保持无环。即使持久语义图包含环，每次查询也可以物化一个有界、带 visited-set 保护的局部扩展 DAG。
