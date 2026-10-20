# 与 agent 无关的 CLI 与常驻服务

[English](agent-cli-and-resident-service.md) · [术语](agent-cli-and-resident-service.terms.yaml)

**Authority:** [上层范围](../product-boundary.md)。

跨宿主具体能力覆盖由[适配器能力矩阵](../../harness-capability-matrix.zh-CN.md)比较；存在适配器入口不等于全部能力都已接入。

## 与 agent 无关的 CLI 与常驻服务

目标集成边界是一个与 agent 无关的 `nmg` CLI，而不是由 harness 直接访问 NMG 内部。Pi 仍需要一个小的 TypeScript 扩展，但该扩展应把 Pi 生命周期事件与工具翻译为一个稳定的、语言中立的协议。它不得让核心存储或处理实现变成 TypeScript 专属。

该 CLI 同时支持一次性管理用法与常驻模式：

```text
nmg remember ...
nmg search ... --compact-json  # agent-facing headers
nmg search ... --json          # full diagnostics
nmg get ... --active-graph-id <ID_FROM_SEARCH> --json
nmg status --json
nmg daemon start
nmg daemon status
nmg daemon stop
```

当前的 `activeGraphId` 不是装饰性的延续元数据。与 agent 无关的客户端必须在精确 `get` 时回传它，使拥有该检索轨迹的一方记录哪些候选被**披露**。检索、注入与精确加载是可观察的暴露状态，不是某个 API 模型依赖过某条记录的证据。把它们分开，可以防止候选暴露变成自我强化的正反馈。

在迁移期间这仍是可移植的观察不变量。目标协议把这个不可变暴露身份改名为 `projectionId`，并新增独立的会话 `agId`；`get(projectionId=...)` 通过稳定的 RPC 记录披露。适配器可以额外记录答案与记忆的重叠，但那是取决于 provider 的诊断遥测，不是因果使用的证明，也不是训练标签。只有可审计的用户确认、工具核验的结果与官方 benchmark 证据可以把记录标记为 useful/contradicted 并训练路由或图稳定性。任务成功、证据充分性、扩展有用性与过度噪声之类的标签依赖原生答案、纠正、token 与工具生命周期事件，因此它们仍是 harness 适配器的遥测。沉默或候选暴露永不被转换为正标签。

为当前 Pi 的人体工效，`nmg_remember(action="feedback")` 可以省略 `activeGraphId`，但仅用于指向同一 Pi 会话拥有的最近一次检索。所提供的 ID 仍会做会话检查，在评审较旧的 graph 时仍是必需的。这避免了脆弱的 UUID 转写，又不允许跨会话标签。

一次性命令对人与诊断仍有用。harness 通常连到常驻 HTTP JSON-RPC 服务，使有界的内存工作集、会话/STG 状态、投影延续、节点目录与热缓存跨调用存活。daemon 在 OS 分配的 `127.0.0.1` 端口上讲 HTTP 上的 JSON-RPC 2.0，使用 Node 内置的 `http` 与 `fetch`，无需第三方传输依赖。SQLite 在首次持久工作时才惰性打开。

对没有完整适配器的 harness，CLI 是回退与管理面；它并不要求每个内部机制都获得一条命令。诸如边激活之类的查询内部策略复用 `search` 及其轨迹输出。只有当某个人或不完整的适配器需要显式调用、检查或恢复该操作时，专门命令才成立。

常驻实例使用一个作用于所选 SQLite 数据库的 PID 租约。该租约记录回环端点与一个随机 bearer token。为同一数据库启动第二个 daemon 会被拒绝，过期租约会被恢复，`Shutdown` 执行常规关闭路径。只有无法触达 HTTP 端点时，PID 终止才是回退。

#### 运行时归属与并发契约

一个常驻 daemon 是一个 LTG 数据库及其已打开的每个项目 STG 句柄在应用层的权威。harness 适配器与普通 CLI 命令必须使用该 daemon，而不是打开第二个可写的 `NmgStore`。PID 租约阻止两个协作的 daemon 拥有同一个 LTG 文件。SQLite WAL 与 `busy_timeout` 提供崩溃恢复，并对管理性或测试进程提供有界容忍；它们**不**为不受支持的多进程写者定义语义顺序。

在 daemon 内部，并发是基于阶段的，而不是请求全局的：

- 每个 SQLite 阶段都是同步的，因此在另一个 SQLite 阶段开始之前，它会在 Node.js 事件循环上跑到完成；
- 外部 embedding 与摘要调用可以并发等待，且绝不跨 `await` 持有 SQLite 事务；
- 一次检索在其查询 embedding 返回之后才取得数据库视图；它不是在外层调用之前就开启的快照；
- 叶子摘要写入携带成员指纹，并在飞行中块已变化时拒绝该结果；节点摘要则有意接受有界陈旧，并记录刷新滞后所用的成员数基线；
- 维护在有界的事件循环切片中运行。其持久的 dirty/delta 状态使被中断或失败的切片可重试，并使 `remember` 的成功与机会性维护相互独立。

该模型允许并发的 Agent 轮次，而不把所有工作挡在一次慢模型调用之后，同时为持久状态保留单一权威写者。请求到达顺序决定其他方面并发的写入阶段的顺序。它不承诺分布式事务、跨独立 OS 进程的线性化顺序，也不承诺同步 SQLite 工作的并行执行。只有当测量显示事件循环写者超出其延迟预算时，读副本或 worker 线程数据库队列才作为性能选项保留。

协议兼容 epoch `nmg.v9` 通过 JSON-RPC 2.0 暴露 `protocol.ts` 中声明的类型化 lifecycle、memory、retrieval、maintenance、STG-sync、memory-chain、Task Board、run-record、Lab 与 session-Active-Graph 方法。HTTP 是唯一的常驻协议；NMG 不维护并行的 NDJSON 或平台专属 socket API。租约记录兼容 epoch。增量 RPC、可选字段与可选行为不推进该 epoch。daemon 在 `hello.capabilities` 中通告它们；客户端保留未知能力名以保持前向兼容，在本地对可选调用加闸门，且只在调用方调用缺失能力时报告 feature-unavailable 错误。只有当活着的 daemon 使用不同的兼容 epoch 时客户端才失败即关闭，随后在一个安全的协调点要求显式 `nmg daemon restart`；它们绝不自动替换共享 daemon。显式 `nmg daemon reload` 通过[受控生命周期交接](../../daemon-lifecycle-design/controlled-code-reload.zh-CN.md)替换具备该能力的 owner：准入关闭、已接受调用排空、只有持票替代进程可以取得租约，客户端刷新发现信息。持久记忆与黑板数据保留，易失的 AG 与 writer 租约被清空。缺少能力时拒绝而不是隐式升级，owner 变更后的结果不确定写入不重放；只读调用保留有界的重连重试。
`NMG_RPC_DESCRIPTORS` 是方法存在性与同 epoch 可选能力闸门的运行时声明来源。它派生出服务端白名单、TypeScript 方法联合、客户端闸门表与可选的 `hello.methods` 发现列表；双向契约测试拒绝没有服务处理器的描述符，或没有描述符的处理器。描述符目录在 daemon 生存期内冻结，并有一个确定性的 `sha256` 指纹发布为 `hello.catalogFingerprint`。客户端校验完整 hello 形状，保留通告的方法集与目录指纹，并在重连后刷新两者。该指纹只是发现/缓存身份：同一兼容 epoch 内不同的指纹不是不兼容判决。可选调用只有在通告的方法集（当存在时）与描述符的能力闸门都允许时才被准入。运行时方法注册与目录热重载未实现；加入它们首先需要一套有界的可信注册、处理器归属与在途请求策略。
这种自动化有意止步于传输声明。解析器、跨字段不变量、事务、副作用、CLI 语法、宿主暴露与 epoch 升级决定仍保持显式，因为结构化生成无法确立它们的语义或安全性。
`nmg.v5` 有意与 v4 不兼容，因为含糊的 `recordActiveGraphUse` RPC 被只用于诊断的 `recordActiveGraphAttribution` 取代；静默连接到 v4 会在 Agent 完成时丢失归因，并保留旧的、不安全的训练语义。
`nmg.v6` 另外在 claim 结果事件上保留 `natural|controlled|legacy` 来源。把当前适配器连到 v5 会静默丢弃该可选字段并污染自然维护审计，因此客户端同样失败即关闭，直到一次显式协调的重启。
`nmg.v7` 以成员移除、显式 DAG 边变更、结构化边读取、拓扑顺序与 STG 会话路由补完记忆链边界。v6 daemon 只暴露更早的部分链 API，因此 v7 客户端不会静默降级。
`nmg.v8` 增加 daemon 拥有的 Lab 能力租约与调用。`nmg.v9` 把会话 Active Graph 的归属移入 daemon，并把返回的 Active Graph id 从持久化的检索轨迹 id 改为不可变的运行时投影 id。v8 daemon 无法保留该归属或反馈身份，因此该 epoch 变更是有意的不兼容。进一步的增量特性仍留在 v9 内，并按能力协商，除非它们改变了既定语义、归属、安全或持久解释。增量 RPC 可以携带旧的同 epoch daemon 会忽略的可选字段，但只有当客户端能从 `hello.methods` 发现支持并据此对字段加闸门时才安全。运行面遵循这条规则：只有 daemon 通告 `taskRun` 时，客户端才在看板 `put` 中发送可选的 `adopt`。否则旧 v9 daemon 会创建条目却忽略运行绑定，调用方会误以为该条目受此运行管理。
