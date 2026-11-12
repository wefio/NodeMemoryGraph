# Magpie 接口与适配器联动

[English](magpie-capabilities.md) · [术语](magpie-capabilities.terms.yaml)

**Status:** draft
**Authority:** [Magpie 集成](magpie-integration.zh-CN.md)

## 接入选择

将 Magpie 与客户端完整的已连接能力集合组合，包括原生适配器、MCP、hook 和 CLI／Skill 访问。共享[组合模型](harness-integration.zh-CN.md#组合各接入点的能力)按操作选择提供方。网关召回与 MCP 工具可组合成无需原生插件的记忆流程候选。Pi 则是通过显式 trace 关联验证原生召回到网关路由追踪的另一候选。

接口核对以 2026-11-12 本机观察到的 Magpie `0.1.3545` 为目标。下列固定版本源码证明接口存在，不表示 NMG 集成可用。本次没有验证插件加载、collector 导出、真实模型请求或 NMG／Magpie 联合会话。NMG 源码链接表示接线，不表示部署。[管理计划](magpie-operations.zh-CN.md)拥有交付切片。

## 按观测目标选择接口

| 需求 | 固定版本上游来源与接口 | 接入含义 |
| --- | --- | --- |
| 读取／修改模型上下文 | [网关 hook](https://github.com/yetone/magpie/blob/v0.1.3545/docs/subsystems/gateway-request-hooks.md)、[上下文定义](https://github.com/yetone/magpie/blob/v0.1.3545/internal/plugin/gateway.go) | 异步 Bun `onRequest` 可以等待有界 NMG 读取，接收 origin、protocol、请求模型、stream、path、agent、session、cwd、query。它在路由前运行，请求模型不等于最终供应商／模型。工具与工具选择仍归客户端。 |
| 观察已完成回复 | 同一请求 hook 合同 | `onResponse` 接收重建的客户端回复和完成状态，不能改写已交付回复，通知可能丢失，不提供原生工具执行或 Agent 空闲状态。 |
| 展示聚合用量 | [页面 bridge](https://github.com/yetone/magpie/blob/v0.1.3545/internal/gui/pluginpage.go) | 声明过的 `usage:summary` 读取支持 today／7d／30d 的调用、错误、输入／输出、缓存读取、成本和有界模型摘要，不提供会话归因。`usage:day` 有独立按日视图。 |
| 观察用量行 | [Middleware 扩展](https://github.com/yetone/magpie/blob/v0.1.3545/internal/middleware/points.go) | `onUsage` 在 moejs 中同步运行，与 Bun 不同。行包含供应商／账号、调用方／供应商 key 的 ID 和名称、请求／实际模型、token 分类、耗时、尝试、状态和成本，不含 session、请求 ID、prompt 或原始凭据。 |
| 关联单次模型请求 | [OTLP 请求 span](https://github.com/yetone/magpie/blob/v0.1.3545/internal/otlp/request.go) 与[参考文档](https://github.com/yetone/magpie/blob/v0.1.3545/docs/reference.md) | 合法的 W3C version-00 `traceparent` 接入调用方 trace。网关父 span 包含路由尝试子 span，覆盖失败尝试和 fallback，用量记在子 span。原生工具执行需要调用方独立 span。 |
| 将 NMG GUI 放进现有窗口 | [页面／面板声明](https://github.com/yetone/magpie/blob/v0.1.3545/internal/plugin/page.go) | 独立页面可以带 host service，面板可放入 agents／usage／settings／provider，供应商／Agent 菜单动作带 ID／名称打开插件页。面板传输仍需独立验证。 |
| 复用向量和重排供应商 | [检索 API 参考](https://github.com/yetone/magpie/blob/v0.1.3545/docs/reference.md) | `/v1/embeddings` 接收 OpenAI 形状输入，`/v1/rerank` 接收支持的检索供应商格式。两者使用网关 key，模型可为 provider/model 或裸 ID，供应商兼容性与 NMG 索引身份需要测试。 |
| 分发显式工具 | [插件工具](https://github.com/yetone/magpie/blob/v0.1.3545/docs/subsystems/plugin-tools.md) | Streamable HTTP `/mcp/magpie/tools` 提供带插件前缀的工具。执行上下文提供网关识别的 agent、abort 和宿主目录，不建立原生 Harness 会话绑定。 |

`onUsage` 是可选的有界观察器。队列容纳 1,024 行，单次回调限时 250 ms，可能丢弃。它不适合作为唯一持久用量账本，也不能关联某次召回。不能假设这个运行环境支持任意 Node 导入或异步 NMG RPC，持久传输需要受支持的导出或 bridge。

OTLP 导出需要配置 collector。当原生 transcript 追踪已覆盖某 agent／session 时，exporter 可能抑制网关 span。承诺完整瀑布图前需要验证这条去重路径。`traceparent` 用于观测关联，不用于会话认证。

静态插件 frame 不能访问任意网络端点，bridge 读取需要声明。`providers:list` 只提供供应商 ID／名称，不提供 key 或向量模型目录。插件 options 不是秘密存储。自定义 NMG 指标和管理写入经受支持的 host service。使用 `magpie web` 时，经宿主反向代理访问 service，不能把查看者的 localhost 当成宿主。

## 与现有 NMG 适配器互补

下表所有网关贡献都要求客户端模型流量实际经过 Magpie，直连流量和只切换配置的用法不在覆盖内。仅匹配显示名不能关联会话。

| 适配器与源码入口 | 已有原生贡献 | Magpie 补充及边界 |
| --- | --- | --- |
| [Pi](../../../.pi/extensions/nmg/index.ts)、[耗时观测](../../../.pi/extensions/nmg/first-response-timing.ts) | 召回准备、工具结果观察、压缩、完成和会话生命周期。Pi 已观察 Assistant usage 及 provider／首响应耗时。 | 补充网关内部供应商／账号选择、路由尝试、fallback 和计费／缓存观测。通过 `before_provider_headers` 与 OTLP 验证 `traceparent` 传递，原生层保留召回所有权。 |
| [DSH 宿主包](../../../dsh/dsh-nmg/src/plugin/index.ts) | Inbox 触发召回、真实原生 Agent／会话身份、忙碌声明、销毁、子任务恢复和唤醒投递。召回 token 总量是估算。 | 补充上游实际用量、路由结果和跨 Harness 管理视图。网关无流量不能替代原生忙碌／销毁／子任务生命周期。 |
| [DSH 旧适配器](../../../dsh/nmg-plugin.mjs) | `agent/pre-step` 调用 `onPreStep`，准入召回回合，将新候选追加到进入执行的 decision，同时提供记忆工具。 | 它已有自动召回，应配合网关观测，避免再次注入。与宿主包的 inbox／会话集成分开表达。 |
| [OpenCode v2](../../../opencode-plugin/index.ts) | Prompt／context 召回、工具观察、压缩和事件映射会话。完成使用 execution 事件，不是保证存在的 idle 事件。 | 补充请求／路由结果和上游实际用量。HTTP 成功不等于原生执行结束。当前适配器宿主合同尚未证明 provider-header 传递能力。 |
| [WorkBuddy hook](../../../workbuddy-plugin/nmg-hook.ts) 与 [MCP 分离](../../../workbuddy-plugin/README.md) | UserPromptSubmit 准备、独立命名空间的 hook 会话及有限工具提醒。Hook 输出本身不确认已交付模型。 | 网关 hook 可以检查提交的模型请求中是否有准备好的披露，观察完成／用量，最多证明网关收到。它不合并 hook 和 MCP 的独立 AG 会话，也不证明使用过记忆。 |
| [仅 MCP 客户端](../../../claude-plugins/nmg-memory/agents/memory-copilot.ts)，包括从 Codex 或 Claude Code 使用此服务器的客户端 | 显式 search／get／remember 与带栅栏 state 工具，没有原生用户回合或自动召回 hook。 | 获准且稳定的客户端／会话绑定可以增加网关自动召回，MCP 保留显式工具。缺少绑定时，只做授权无状态召回或跳过，不虚构空闲唤醒和工具执行观察。 |

Pi SDK 依赖在 [package.json](../../../package.json) 中声明，已检查的 SDK `BeforeProviderHeadersEvent` 允许修改出站请求头。NMG 现有耗时 handler 只观察此 hook，trace 传递仍需针对受支持 SDK／provider 路径实现并测试。

拟议的 [pi durable 绑定](harness-integration.zh-CN.md)是独立云端执行设计，不是另一个已交付适配器。检查点、休眠和持久任务执行仍归该宿主，网关不能提供这些语义。

## MCP 与 Magpie 组成同一会话

本草案在共享服务处组合提供方，无须先让网关通过 MCP 推送事件，也不要求先有原生插件。

| 能力 | 对组合会话的贡献 | 剩余条件或缺口 |
| --- | --- | --- |
| 自动召回 | Magpie 请求准入触发共享召回与上下文注入 | 验证协议及新回合、续接、重试的区分 |
| 精确证据和记忆写入 | 现有 MCP search／get／remember 工具 | 工具连接绑定到同一获准对话代次 |
| 披露与预算接续 | 共享 InformationView、服务拥有的披露状态和访问校验 | 建立跨入口交接，独立 AG ID 不能互换 |
| 工作状态和协作 | MCP state 工具提供显式读写，网关可准备获准的待处理上下文 | 遵守端点能力和本地黑板边界，模型读取是拉取，不是空闲主动推送 |
| 工具观察 | MCP 服务器知道自身工具执行，网关可能看到提交的工具结果消息 | 其他工具需要原生见证，协议内容本身不证明真实执行 |
| 完成与反馈 | 网关观察完成回复，显式 MCP 操作可提交获准反馈 | 完成通知尽力而为，不等于正向反馈或事实确认 |
| 用量与 GUI | 网关 usage／trace 加上展示 NMG 指标的 Magpie 面板 | 只按验证过的关联组合，保留统计作用域 |
| 空闲唤醒、reset 与持久恢复 | 可用时由其他已连接提供方补充 | 单靠 MCP 和模型请求 hook 尚不能建立这些能力 |

候选交接流程如下：

1. 通过宿主配置或认证服务握手，将网关与 MCP 连接绑定到相同作用域的对话代次。模型填写 session ID 本身不能建立绑定。绑定签发、过期和重连处理需要实现及隔离测试。
2. 获准模型请求到达时，网关调用共享召回。服务准备 InformationView 上下文与获准的后续引用，保留披露状态，区分准备与已确认投递。
3. 模型需要全文时使用现有 MCP `get` 界面。服务按该绑定解析获准投影，检查当前权限、来源修订和预算。跨入口解析属于待实现设计，当前独立 MCP 与 hook AG 会话尚不具备此能力。缺少交接时，使用自足网关上下文或重新做 MCP search。
4. MCP 写入返回正常服务回执，后续网关请求在当前授权下看到共享状态。操作身份与效果核对避免重试或切换提供方造成重复效果。

这些提供方组成覆盖更广的记忆流程，同时保留明确的生命周期缺口。宣告覆盖前测试并发客户端、fork、reset／重连、撤回、并发状态写入、预算接续和重复注入。其他提供方能够补上缺口时，将其纳入同一集合并验证交接，不再增加一套平行会话系统。

## 优先复用向量传输

NMG 的 [OpenAI provider](../../../src/core/embedding-providers/openai.ts)已接受 base URL、key 和模型，可用 Magpie embeddings 路由及受限网关凭据测试，上游供应商凭据继续归 Magpie。不支持或不兼容时保留直连 NMG provider，GUI 区分两种凭据归属。

逐索引固定 provider/model 和兼容的路由配置。裸模型自动分组或跨不兼容模型 fallback 可能混入不同向量空间。检查维度、文档／查询 profile、模板与[索引命名空间](../../../src/core/openai-embedding.ts)，包括换端点是否需要新 namespace，不能假设改 URL 会自动形成不同索引身份。

Magpie rerank 端点是可用上游传输，不表示 NMG 已有 reranker，也不证明 Recall@20 提升。采用时在共享检索的目标候选选择阶段接入，分别测量质量、延迟、成本和失败行为。

## 首批联调证据

保留 GUI 优先的顺序。初始用量面板使用聚合 bridge 读取，库指标使用 NMG 服务快照，不承诺通过 `onUsage` 分摊每次召回费用。

随后分别验证两条有界路径：

1. Pi 保留原生召回所有权，将调用方 trace 接到网关尝试 span，验证 SDK 请求头传递、collector 导出和 transcript 去重，标明耗时与 token 报告来自哪一段。
2. 一个明确绑定的仅 MCP 客户端通过共享 InformationView 获得网关召回，扩大覆盖前验证协议格式、会话隔离、披露去重与精确 get 所有权。

向量传输可在面板工作期间通过协议样例测试。真实供应商请求、启用 collector 和部署各自需要明确执行范围，接受本接口映射不要求开展这些操作。
