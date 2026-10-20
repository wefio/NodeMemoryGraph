# 产品边界：NMG Lite

[English](product-boundary.md) · [使用的术语](product-boundary.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## 产品边界：NMG Lite

作为目标的默认插件应当作为一个普通 Pi 包安装，并且只需要 Node.js、Pi 与 SQLite。FTS 检索必须在没有 embedding 服务器的情况下可用。语义 embedding provider 可以通过配置启用，但本地 Qwen、vLLM、CUDA、USearch、通用 ML 框架与 Cloudflare 都不是默认依赖。

默认面向模型的表面是三个持久记忆工具、一个 state 入口与一个 Lab 能力入口：

```text
nmg_search(query, filters, budget)
  -> compact result headers, IDs, dates, types, sources, and retrieval costs

nmg_get(ids)
  -> exact selected memories and bounded raw evidence

nmg_remember(statement, type?, scope?)
  -> explicit/hot-path durable write through the same governed write policy

nmg_state(action, space, operation?, ...)
  -> read/write private AG or shared board state through its existing owner

nmg_lab(action, capability?, ...)
  -> discover and explicitly lease optional experimental session capabilities
```

以上签名均为简写。`nmg_remember` 还接受显式 `forget` 与 `feedback` 动作；其可选字段 `recallTriggers` 最多接受 16 个短语。受治理写入的详情见[会话捕获与写入路径](session-capture-and-write-path.zh-CN.md)。

跨 Agent 协调是一项独立能力，但其发现表面默认启用：除非把 `NMG_ENABLE_COORDINATION` 显式设为 `0`、`false`、`off` 或 `no`，适配器通过 `nmg_state` 暴露 board 操作，并启用 wake 轮询。这使新接入的 Agent 能够发现并加入共享工作，而不必每个对端先手动启用一步。当该面向模型的表面被禁用时，daemon RPC 与 CLI board 操作仍可用。

自动抽取可以使用同一写入路径。物理隐私擦除、重建索引、图编辑、反馈检视与维护属于 CLI／UI／后台操作，而不是普通模型工具。显式的 `nmg_remember action=forget` 仅执行逻辑撤回，不声称完成物理擦除。另一个例外是通过 `nmg_remember action=feedback` 提交的显式、归会话所有的校准标签；它记录适配器拥有的评测元数据，且永不改变记忆真值或排序。该反馈动作目前是 Pi 的 shadow 控制器集成，不是 NMG Core/RPC 方法。

默认 Pi 包只暴露这个表面。图编辑、再平衡、合并、QPP 与实验性推理仍是后台、CLI、benchmark 或管理关注点。显式检索反馈是既有 remember 边界上的一个动作，而不是另一个工具，也不是从用户沉默中做出的自动推断。

### 与 Agent 无关的 CLI 与常驻服务

请阅读完整职责说明：[与 Agent 无关的 CLI 与常驻服务](product-boundary/agent-cli-and-resident-service.md)。

### 模块化宿主适配器

TypeScript 原型在 HTTP 客户端／服务器进程边界上按职责切分：

```text
Agent-specific adapter
  |- native message -> AgentHistorySnapshot
  |- native lifecycle -> recall/write/feedback calls
  |- native tool schema and host-only actions
  `- prompt/context injection
                |
                v
Agent-independent integration modules
  |- config: environment and feature-mode parsing
  |- evidence: selective source-message retention
  |- search: lexical/hybrid retrieval with explicit degradation
  `- Agent Surface: shared DTO projection, budgets, redaction and default rendering
                |
                v
NMG core + SQLite
```

适配器必须提供稳定的会话与消息 ID、规范化后的 actor 与文本、可选来源引用，以及用于 turn 前召回、turn 后反馈与关闭的生命周期钩子。它不得解析 SQLite 行、更新图拓扑、实现 QPP，或构建 embedding 索引。Pi 是第一个适配器，不属于 NMG 数据模型。[首次响应计时决策](../../decisions/implemented/2026-10-04-first-response-timing-is-opt-in.zh-CN.md)
记录了显式启用的、仅元数据的观测与慢速输入到召回的保留策略。历史性的[会话钩子索引](../session-memory-lifecycle-hooks-2026-08-10.zh-CN.md#当前-owner-索引)
指向当前所有者；事件级接线应查阅当前扩展源码。观测不改变召回等待策略，也不发起 provider 探针。

面向 Agent 的结果语义有一个集成层所有者。共享 `Agent Surface` 投影并渲染紧凑 search header、精确证据、有界 remember 后续候选、Task Board 条目与逻辑链结构。它拥有稳定字段名、撤回脱敏、证据／结构预算、链标签与默认下一步放置。适配器可以把该文本包进原生内容块，或添加宿主生命周期提示；它不得重建候选 DTO、证据布局、board 约定或语义后续规则。存储层级、排序分数、QPP 内部、计时与 token 估计留在 Core trace 或诊断输出中，永不进入面向 Agent 的候选 DTO。结构化 daemon 结果仍是规范的，而 Agent Surface 是可替换的呈现边界，绝不是另一个 store 或协议版本。降级检索在候选输出与空结果输出中都保留其模式与有界原因码。已知 embedding HTTP 失败暴露 `embedding_http_<status>`；已准入的 embedding／索引码不变；未识别的诊断暴露 `unknown`。Provider 响应正文留在原始结构化结果与 daemon 诊断中，而不是紧凑候选 DTO 或其渲染中。

共享服务 search 为符合条件的可见文本 header 派生 `ref:<hex-prefix>|<quote>` 选择器。前缀从四位十六进制数字起、每次加两位，直到该组合在原始可读候选集合中唯一；引文使用空白归一化后的前六个 Unicode 码点，不做大小写折叠或 NFKC。Get 接受整段选择器及其原始 `activeGraphId` 与读取作用域。原始 ID／引文见证存在于既有的不可变私有 AG 投影内部。解析先确定原始规范 ID，再用该 ID 对照当前可读内容检查；引文迁移到另一条记录不会重新绑定选择器。缺失／外来／过期投影、畸形选择器、零匹配与歧义都 fail closed，不做 latest-graph 推断或重试。仅持久 trace 没有内容见证，无法解析组合 RPC 选择器。共享库 helper 接受一个原始捕获作用域与一个当前内容守卫；Core 精确查找仍基于规范 ID。

完整 ID 在没有图的情况下仍可用，并在精确输出、紧凑 JSON、生命周期动作与归因中标识记录。派生文本引用映射是呈现数据，不是独立存储。撤回、不可用引文与过长碰撞保留完整 ID。deferred／folded 的仅 ID 行保留 UUID，而不是披露一条新引文。这些选择器是临时定位符，不是持久 ID、认证或不可变的整记录版本哈希。

既有 status RPC 暴露 `getReferenceUsage`（`fullIds`、`compoundRefs`），可通过 `nmg status --json` 查看。每个通过验证的 get 输入数组条目在解析之前计一次：非 `ref:` ID（包括旧 ID）与 `ref:` 尝试分别统计。重复项、缺失 ID 与被拒绝的选择器计入；非法 RPC 参数与内部读取不计入。计数器按服务实例从零开始、重启后重置，且 status 返回一份不打开存储的副本。它们测量输入用量，而非成功读取或引用质量。

共享 search/get 披露文案位于 `src/prompts/nmg-prompts.yaml`，并通过生成到达运行时消费者。命名候选／证据字段携带记录数据；周边文案解释预览与证据的区别、语义节点／时间／链标签、外部与未解决标记，以及排序的非保证性。计数与条件式的精确读取／撤回指引结束正文而不重复其字段模板。包装变更不缩短预览或已保存陈述、不改变结构化结果或候选选择、不替换历史注入，也不移除反馈／完成义务。裸 renderer 与调用方提供的包装仍可用。一个反馈提示位在可操作调用处点名其完整图 ID 一次；其伴随的 search header 独立保留图 ID 以供精确读取归因。单独与空结果的反馈在没有更早 header 的情况下仍可归因。

包依赖边界遵循该架构。NMG Core、daemon 与非交互 CLI 路径不导入 Pi。Pi 适配器以 `@earendil-works/pi-coding-agent` 作为开发依赖进行类型检查，并把它声明为由宿主提供的可选 peer；仅为 CLI 使用安装 NMG 不得把 Pi 宿主拉进运行时依赖图。`@earendil-works/pi-tui` 之所以仍是运行时依赖，仅因为适配器 UI 与独立惰性加载的 `nmg inspect` 命令都要执行它。其版本线必须与 Pi 宿主保持一致，以避免重复或不兼容的 TUI 组件实例。若将来安装成本变得可观，适配器或 inspect TUI 可以成为独立包，但 Core 不需要包拆分来保持这条边界。

Pi 适配器现在是一个薄 HTTP 生命周期／工具适配器。它惰性启动 daemon，通过共享 `http-client` 复用一条连接服务自动召回与默认稳定工具面，并且只有在该适配器调用拥有 daemon 时才停止它。它不打开 SQLite、不维护索引，也不导入图／QPP 实现。除非将来 profile 指出某个组件无法在 TypeScript 中满足其预算，否则不计划 Rust/Python 实现。

实现复用遵循语义所有权而非文本相似性。作用域规范化与 embedding 索引生命周期是单条 Core 规则；适配器不得重新实现它们。Pi、MCP 与 DSH 消费一份宿主中立的常见 remember/board 动作清单，同时保留原生 TypeBox、Zod 或 JSON schema 编码以及宿主专属动作。同一批适配器与 benchmark 桥消费共享 Agent Surface 处理 search/get/remember/board 或直接精确证据投影；只有宿主注册、生命周期、传输兜底、宿主专属动作，以及官方 benchmark 封装或审计字段留在本地。Leaf 与节点 summary 器共享 OpenAI 兼容的完成客户端与有界排空 runner，同时保留各自不同的 prompt、待处理任务规则与陈旧写入语义。宿主特定的消息投递与进程生命周期钩子仍是薄的本地适配器，因为 Pi、MCP、Kimi 与 DSH 暴露不同的事件循环。生成产物不是第二份实现，而真实进程 daemon 测试与快速进程内 fixture 保持分离，因为它们验证的是不同边界。

其他 Agent 可以使用打包的 `nmg-memory` Skill。其入口文档是一张很小的首次使用卡片；详细的写入、召回与 daemon 操作位于链接的 references 中，只在 Agent 忘记某个操作或遇到特殊情况时才加载。
