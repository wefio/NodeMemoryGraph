# Magpie 接口与适配器联动

[English](magpie-capabilities.md) · [术语](magpie-capabilities.terms.yaml)

**Status:** draft
**Authority:** [Magpie 集成](magpie-integration.zh-CN.md)

## 接入选择

将 Magpie 与客户端完整的已连接能力集合组合，包括原生适配器、MCP、hook 和 CLI／Skill 访问。共享[组合模型](harness-integration.zh-CN.md#组合各接入点的能力)按操作选择提供方。目标是让各适配器正常使用 NMG 的记忆操作、自动召回、工作状态、披露、归因／反馈与协作。用量、追踪和 GUI 是 Magpie 的附加特性，本身不补齐 NMG 能力缺口。

目标是 2026-11-12 本机观察到的 Magpie `0.1.3545`。固定版本源码证明接口，不证明集成；插件加载、collector 导出、模型请求和组合会话均未测试。NMG 链接表示接线，不表示部署。[管理计划](magpie-operations.zh-CN.md)拥有交付切片。

## 按观测目标选择接口

| 需求 | 固定版本上游来源与接口 | 接入含义 |
| --- | --- | --- |
| 读取／修改模型上下文 | [网关 hook](https://github.com/yetone/magpie/blob/v0.1.3545/docs/subsystems/gateway-request-hooks.md)、[上下文定义](https://github.com/yetone/magpie/blob/v0.1.3545/internal/plugin/gateway.go) | 异步 Bun `onRequest` 可以等待有界 NMG 读取，接收 origin、protocol、请求模型、stream、path、agent、session、cwd、query。它在路由前运行，请求模型不等于最终供应商／模型。工具与工具选择仍归客户端。 |
| 观察已完成回复 | 同一请求 hook 合同 | `onResponse` 接收重建的客户端回复和完成状态，不能改写已交付回复，通知可能丢失，不提供原生工具执行或 Agent 空闲状态。 |
| 展示聚合用量 | [页面 bridge](https://github.com/yetone/magpie/blob/v0.1.3545/internal/gui/pluginpage.go) | 声明过的 `usage:summary` 读取提供 today／7d／30d 聚合，不提供会话归因，`usage:day` 有独立按日视图。 |
| 观察用量行 | [Middleware 扩展](https://github.com/yetone/magpie/blob/v0.1.3545/internal/middleware/points.go) | `onUsage` 在 moejs 中同步运行，与 Bun 不同。行包含供应商／账号、调用方／供应商 key 的 ID 和名称、请求／实际模型、token 分类、耗时、尝试、状态和成本，不含 session、请求 ID、prompt 或原始凭据。 |
| 关联模型请求 | [OTLP span](https://github.com/yetone/magpie/blob/v0.1.3545/internal/otlp/request.go) | W3C version-00 `traceparent` 接入调用方 trace，路由尝试子 span 包含失败、fallback 与用量，原生工具需要调用方 span。 |
| 放置 NMG GUI | [页面／面板声明](https://github.com/yetone/magpie/blob/v0.1.3545/internal/plugin/page.go) | 独立页面可以带 service，面板可放入 agents／usage／settings／provider，菜单动作带 ID／名称打开页面，面板传输独立验证。 |
| 复用向量和重排供应商 | [检索 API 参考](https://github.com/yetone/magpie/blob/v0.1.3545/docs/reference.md) | `/v1/embeddings` 接收 OpenAI 形状输入，`/v1/rerank` 接收支持的检索供应商格式。两者使用网关 key，模型可为 provider/model 或裸 ID，供应商兼容性与 NMG 索引身份需要测试。 |
| 分发显式工具 | [插件工具](https://github.com/yetone/magpie/blob/v0.1.3545/docs/subsystems/plugin-tools.md) | Streamable HTTP `/mcp/magpie/tools` 提供带插件前缀的工具。执行上下文提供网关识别的 agent、abort 和宿主目录，不建立原生 Harness 会话绑定。 |

`onUsage` 是可选的有界观察器。队列容纳 1,024 行，单次回调限时 250 ms，可能丢弃。它不适合作为唯一持久用量账本，也不能关联某次召回。不能假设这个运行环境支持任意 Node 导入或异步 NMG RPC，持久传输需要受支持的导出或 bridge。

OTLP 导出需要配置 collector。当原生 transcript 追踪已覆盖某 agent／session 时，exporter 可能抑制网关 span。承诺完整瀑布图前需要验证这条去重路径。`traceparent` 用于观测关联，不用于会话认证。

静态插件 frame 不能访问任意网络端点，bridge 读取需要声明。`providers:list` 只提供供应商 ID／名称，不提供 key 或向量模型目录。插件 options 不是秘密存储。自定义 NMG 指标和管理写入经受支持的 host service。使用 `magpie web` 时，经宿主反向代理访问 service，不能把查看者的 localhost 当成宿主。

## 与现有 NMG 适配器互补

下表所有网关贡献都要求客户端模型流量实际经过 Magpie，直连流量和只切换配置的用法不在覆盖内。仅匹配显示名不能关联会话。

缺口描述 NMG 接线，不描述宿主做不到。按[矩阵核实结果](../harness-capability-matrix.zh-CN.md#原生宿主能力核实)区分尚未实现、宿主路径待验证与宿主明确限制。DSH 只指当前宿主包，历史 preset 不作为功能对齐目标。DSH／OpenCode 的现有原生上下文／工具／事件 hook 合适时优先使用。Magpie 保留完整实现，作为可独立使用的提供方，不成为原生接线未完成的必需前提。

| 适配器与源码入口 | 待补齐的 NMG 缺口 | 候选组合行为 |
| --- | --- | --- |
| [Pi](../../../.pi/extensions/nmg/index.ts) | 原生覆盖较完整，但准备好的逐回合工作状态没有最终输入确认。 | 保留原生召回／工具／见证／唤醒，在网关边界检查带标记的当前状态与披露，获准时通过共享准备修复缺失上下文，不把已有工具或召回算成新增能力。 |
| [DSH](../../../dsh/dsh-nmg/src/plugin/index.ts) | NMG 状态承载、通用观察与归因落盘未接线。原生 prompt 刷新和最终工具通知通过核心服务探测，status／turn／session 事件经源码确认。 | 原生接入 `systemPrompt.context`、`tools/result` 和已提交答案归因，测试取消／代次与真实唤醒。Magpie 保留独立请求边界等价路径。 |
| [OpenCode v2](../../../opencode-plugin/index.ts) | 状态承载未接线，私有 API 探测中 `session.get` 在 prompt 前返回目录；见证映射与本轮插件激活仍未验证。 | 扩展 `ctx.session.hook("context")`，经授权原生会话查询取得作用域并验证 SDK 时序，保留已有观察／归因。Magpie 是可选提供方，不是前置条件。 |
| [WorkBuddy hook](../../../workbuddy-plugin/nmg-hook.ts) 与[工具路径](../../../workbuddy-plugin/README.md) | Hook 召回与 MCP 工具的 AG 会话分离，未证明连续状态承载、通用工具观察或自动归因。 | 绑定 hook／MCP／网关状态后，接续召回到 get、维护状态承载、请求可见观察、诊断归因与待处理黑板上下文。没有 MCP 工具时补上；选择 hook 召回时不重复注入。 |
| [仅 MCP 客户端](../../../claude-plugins/nmg-memory/agents/memory-copilot.ts) | 缺召回、状态承载、自动归因与请求时黑板投递，反馈在动作枚举中有名称，但缺标签参数／处理分支。 | 网关补请求触发部分，共享工具接线补完整反馈及读写／state，共用同一授权会话，其他提供方继续补生命周期事件。 |

这里列的是源码支持的缺口与拟议补齐路径，不是已交付组合覆盖。[适配器矩阵](../harness-capability-matrix.zh-CN.md)拥有已交付覆盖，state 读写支持不证明状态承载。[承载合同](../session-active-graph-runtime-design.md#dedicated-state-carriage)区分准备、传输与确认。

### 用于功能对齐的共享机制

各组合使用相同机制：

- 通过客户端实际连接的 MCP 服务器补缺失的记忆／状态／反馈工具，可选 Magpie 工具路径。Hook 不能向请求增加工具 schema，也不能代替客户端调用工具；已有原生等价工具时不重复提供。
- 当前工作状态、召回和待处理通知使用共享 InformationView 预算及各自承载规则，保护状态片段并按披露去重。上下文丢失后只在当前绑定有效时重新准备，不无差别逐请求插入。
- 将请求可见工具结果作为报告证据接入共享 AG 观察／提醒流程，有原生执行见证时优先使用。只对绑定披露与对应完整回复做答案重合诊断，它既不是正确性判定，也不是训练反馈。
- 没有原生投递时，在下一个获准请求承载待处理黑板上下文；批量选择、订阅与收据沿共享黑板流程。请求时投递不等于对空闲 Agent 主动唤醒。

用端到端 NMG 任务衡量对齐：召回后精确 get、写入／更新和遗忘、状态写入后续承载、可归因证据／显式反馈、黑板批量读取与回复。跨适配器使用相同合同用例，各自缺失的生命周期行为单独记录。

拟议的 [pi durable 绑定](harness-integration.zh-CN.md)拥有云端检查点、休眠与持久执行，不是已交付适配器或网关能力。

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

保留 [GUI 优先的交付顺序](magpie-operations.zh-CN.md#交付顺序与验收)。

通过共享合同用例验证表中的 NMG 缺口，优先验证 DSH／OpenCode 的原生状态承载、WorkBuddy 的 hook 到工具接续、部分客户端的缺失工具，以及仅 MCP 客户端的请求触发 NMG 功能。Pi 在已覆盖部分提供参考行为。Trace／用量关联是独立观测任务，不通过 NMG 功能对齐验收。
