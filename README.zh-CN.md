# Node Memory Graph (NMG)

[English](README.md) | 简体中文

> **Agent 会换，记忆不必换。**

NMG 是一个本地优先的 AI agent 长期记忆层。持久记忆保存在你机器上的**一个
SQLite 文件**里——不在任何人的云上。

```text
不要账号。
不要托管记忆服务。
不要订阅。
不要绑定某个 agent 平台。

只有一个你的 agent 能用的本地记忆层。
```

很多记忆产品需要注册账号、申请 API key、连接托管服务，或者绑定特定的
agent 平台——还有一些停留在论文阶段。NMG 走相反的方向：

- **记忆层归你所有。** Agent 会来来去去——今天是 Pi，明天换别的 harness。
  NMG 独立于所有 harness 存在；adapter 可替换，存储不绑定任何产品。这也是
  多 agent 任务黑板只传**记忆 ID** 而不传内容的原因：记忆比任何一个 agent
  的生命周期都长。
- **本地且私有。** 所有持久记忆都在一个 SQLite 文件里，备份就是拷贝这个
  文件。检索零配置即可用（SQLite FTS5）；可选的语义层可以使用镜像内模型、
  独立部署的本地服务或免费额度的云端嵌入——只有待嵌入的文本会离开记忆
  进程，记忆库本身永远不会。
- **免费。** 没有任何计费面：FTS5 检索内置，本地嵌入路径零成本，也没有
  可以升级的账号。
- **真实可用，不是概念。** CLI、JSON-RPC daemon、MCP server、三个 harness
  的可用 adapter——而且 NMG 正作为自己的开发记忆被跨会话日常使用，不是
  demo 里跑一次就完。

**诚实的边界：** NMG 还不是开箱即用。原生集成需要安装配置，通用 agent 走
CLI + Skill 路径。但它刻意做到了**对 agent 友好、易于集成**：只要你的
agent 会用 CLI，它大概率就能用 NMG；如果它会写插件，它甚至能基于稳定的
JSON-RPC 边界自己完成集成。

| 你的环境 | 接入路径 |
|---|---|
| [Pi](https://github.com/earendil-works/pi) | 原生扩展（[试试](#试试)） |
| Claude Code | 本地 MCP 插件（[Claude Code 插件](#claude-code-插件)） |
| DeepSeek Harness | Cordis 插件（[dsh/](dsh/README.md)） |
| 其他任意 agent | CLI + [Skill](skills/nmg-memory/SKILL.md)（[Agent 无关 CLI](#agent-无关-cli)、[Agent Skill](#agent-skill)） |
| 自定义 harness | 基于 HTTP JSON-RPC 边界自写 adapter（[无头 Pi 控制](#无头-pi-控制)） |

## 架构

```text
Pi agent harness
      │
      │ before_agent_start + tools
      ▼
NMG Pi 扩展
      │
      │ 持久本地 HTTP 客户端
      ▼
NMG daemon ── NMG core ── MemoryNode 图 ── 分层 MemoryRecord
      │          │                    │
      │     在线 router        向量嵌入
      │          └──────┬─────────────┘
      └────────────── SQLite ──────────┘
                    │
             不可变 HistoryRecord
```

设计决策与路线图见
[docs/design/design.md](docs/design/design.md)。

### 语义记忆契约

- 事实、偏好、约束、状态、事件、策略、对话证据有各自独立的类型和使用规则。
  类型、作用域、影响权限三者正交：呈现偏好不能改写事实，行为信号始终非强制，
  约束只在生效范围内起作用。
- 用户明确陈述的稳定事实/偏好/约束/状态自动写入；显式写入始终可用。受治理的
  写入按稳定来源身份保留支撑消息或有界精确摘录；普通闲聊、累积转录、临时
  工具输出不会进入 NMG。
- 反复出现的结果关联情节可固化为可迁移经验——情境、结果、适用性、局限、
  反例、证据——但 NMG 绝不创建或静默更新 Skill、prompt、runbook、脚本等
  行为工件。

## Claude Code 插件

仓库自带一个本地 MCP 插件，Claude Code 零配置可用：

```
claude-plugins/nmg-memory/
├── .claude-plugin/plugin.json   # 插件元数据
└── agents/memory-copilot.ts     # MCP server（< 130 行）
```

**工作方式**

根目录 `.mcp.json` 把 `nmg` 注册为本地 MCP server。Claude Code 在会话启动时
自动发现它并暴露三个工具：

| 工具 | 用途 |
|------|------|
| `nmg_search` | 返回紧凑的记忆头（mid/node/type/tier/preview） |
| `nmg_get` | 加载精确的记忆陈述与来源证据 |
| `nmg_remember` | 保存持久的事实/偏好/状态/约束/事件 |

daemon 生命周期自动管理：MCP server 启动时拉起 NMG daemon，退出时安全停止。
如果 daemon 已在运行（比如另一个 Agent 启动的），直接复用且不碰它。

**输出刻意紧凑**——制表符分隔的单行结果头 + 仅摘录的证据——以约束 token
消耗。

**快速开始**

```powershell
npm install
```

在本项目目录内正常启动 Claude Code 即可——根目录 `.mcp.json` 会被自动发现，
无需显式安装插件。首次连接批准之后，本项目下的每个会话都能用 NMG 记忆。

## 试试

要求：Node.js 22.19 或更新版本和 Pi。

```powershell
npm install
npm test
npm run check
pi install <node-memory-graph 路径>
pi
```

默认情况下，扩展把共享 LTG 和任务板数据存在 `~/.nmg/nmg.sqlite`。用
`NMG_DATA_DIR` 换目录。项目本地 `.nmg/` 数据保留给隔离 STG 会话和受控/无头
运行。

Pi adapter 刻意做薄：它通过 JSON-RPC/HTTP 惰性启动本地 daemon，自动回忆和
四个稳定工具复用同一条连接，且只在本次 adapter 调用启动了 daemon 时才在
会话关闭时停掉它。已在运行的共享 daemon 不会被碰。
daemon 是对应 SQLite 数据库唯一的应用层写入者。并发 Agent 轮次可以并行等待
embedding 或摘要；短小的同步 SQLite 阶段由 daemon 事件循环串行执行。客户端
不应再对同一文件打开独立可写 store。
为避免重复注入同一条记忆，adapter 维护一个会话本地内存窗口（最近 12 轮、
至多 128 条记忆引用）。重复未变的内容折叠成稳定 ID；更深披露、证据变化、
窗口过期或不同会话才允许重新注入。这个缓存在会话关闭时丢弃，绝不存为 LTG。

Pi 扩展把权威 LTG 放在 `NMG_DATA_DIR` 或 `~/.nmg/nmg.sqlite`，把当前工作
目录的 STG 放在一个 `<project>/.nmg/stg.sqlite` 中。临时行按 `sessionId`
隔离；没有会话所有者的 LTG 缓存行由项目内会话共享。
只有当项目根目录和 Pi 工作目录不同的时候才需要设置 `NMG_PROJECT_DIR`。

默认情况下，模型拿到四个工具和一套类型化写入/使用策略：

- `nmg_remember`：保存带作用域、真值状态、事件时间、稳定状态身份、证据角色
  和来源的类型化长期记忆。
- `nmg_search`：从匹配节点和图相邻节点检索紧凑头和稳定 ID，带层级、作用域、
  冲突、历史状态控制，以及用于后续归因的会话私有 `activeGraphId`。
- `nmg_get`：把选中的 ID 展开为精确记忆陈述和有界来源证据。传入 `nmg_search`
  返回的 `activeGraphId` 会把选中的 ID 记录为实际使用过；另一个会话读不到
  也更新不了那个 AG。
- `nmg_board`：多个 agent 通过带署名的条目、TTL 过期、增量游标和显式 resolve
  交换临时的任务范围笔记。板面条目不是 LTG 记忆，也永远不进入语义检索。

图维护、QPP、索引和实验性推理组件留在 core/CLI 层，不做成 Pi 工具。adapter
从不直接打开 SQLite 或 import 那些实现。

在仓库内做一次性开发时，禁用自动扩展发现、只加载一次 NMG：

```powershell
pi --no-extensions --extension ./.pi/extensions/nmg/index.ts
```

同时加载包 manifest、项目本地扩展和显式 `--extension` 会注册重复工具并卡死
工具循环。

## Agent 无关 CLI

包里带一个 TypeScript `nmg` 可执行文件。CLI 是 agent 中立的兜底和管理面，
尤其适合没有插件或 adapter 不完整的 harness。内部检索机制不各自发命令；
除非确需管理操作，它们都组合在稳定的 `search/get/remember` 面之后。

仓库开发期用等价的 npm 命令：

```powershell
npm run cli -- status
npm run cli -- remember "User prefers concise answers" --node "Response preferences" --type preference
npm run cli -- search "How should answers be written?"
npm run cli -- get <memory-id>
npm run cli -- retention candidates
npm run cli -- retention archive <memory-id>
npm run cli -- retention quarantine <memory-id> --recovery-days 30
npm run cli -- retention restore <memory-id>
npm run cli -- memory delete <memory-id>
npm run cli -- topology proposals
npm run cli -- topology assess <proposal-id>
npm run cli -- topology review <proposal-id> --decision accept
npm run cli -- topology actuate <proposal-id>
npm run cli -- graph --out memory-graph.html
npm run cli -- stg sync --project-dir . --scope project=nmg --limit 50
npm run cli -- daemon start
npm run cli -- daemon status
npm run cli -- daemon stop
```

安装后的包直接暴露同样的 `nmg` 命令；发布的 CLI 跑预编译 JavaScript，不对
`node_modules` 里的文件做 type-strip。`--json` 给完整结构化结果，`--data-dir`
选 NMG 数据目录，`--db` 选单个 SQLite 文件。`remember` 需要稳定的 `--node`
名；`--scope key=value` 可重复。`remember`/`search`/`get` 可能碰到隔离 STG
时传 `--project-dir`。`stg sync` 把按使用度排序的作用域 LTG 工作集幂等地
拷进那个 STG；LTG 始终是权威。

CLI `remember` 写入默认归属提交渠道 `user`；adapter/RPC 调用方默认 `agent`，
转发其他渠道时应显式设置 `writeSource`。这与 `sourceActor` 无关——后者声明
证据内容是谁写的。`nmg claim outcome` 可用 `--evidence`、`--session-id` 和
`--source-lineage` 保留精确的 user/tool 摘录；即使原 harness 转录消失，事件
仍可审计。

项目 STG 也是会话私有的。Pi 自动提供会话 ID；CLI 调用方可加 `--session-id
ID`。不给的话，CLI 使用独立的 `cli` 管理会话，不读任何 Pi 会话的 STG。

`nmg graph` 把节点/关系投影导出为单个自包含 HTML 文件（默认
`nmg-graph.html`，`--out FILE` 覆盖）。它只读数据库——对运行中的 daemon
安全——页面不需要服务器：力导向 canvas 布局、拖拽/缩放、按关系类型的图例
开关、孤立节点高亮，以及每个节点顶部陈述的详情面板。`src/cli/graph/assets/`
下的视图资产是普通模板（`template.html`、`graph.css`、暴露 `NmgGraph.mount`
的 `graph.js`），渲染器可复用于任何 `{nodes, edges}` 载荷。

外部证据是可选加入且带可见标记的：

```text
nmg remember "The upstream docs list version 2" --node "Upstream version" \
  --external-source web:https://example.com/docs --content-hash sha256:... --json
```

外部写入默认 `truth=unverified`；Pi 渲染 `[external]` 和来源，让 Agent 自己
判断当前任务是否需要复查。

用 `--tiered-disclosure` 先搜 L0，只在 QPP 报告证据不足时才打开更深层级。Pi
自动回忆默认启用这个门。AG 结果报告 `tiersOpened`、`deepestTier` 和
`deepEvidence`。

`nmg daemon start` 在 OS 分配的环回端口上启动语言中立的 JSON-RPC-over-HTTP
边界。请求和响应是 JSON-RPC 2.0，走 Node 内置 `http`/`fetch`（无第三方传输
依赖）；端点和一个随机本地 bearer token 记录在所选 SQLite 数据库旁边。同一
实现跑在 Windows、macOS、Linux 上。

服务还带管理性的保留、删除、合并、拆分 RPC，以及可复查的拓扑提案
列表/评估/审查/执行，运行中的 daemon 始终是唯一的数据库写入者。这些是
CLI/管理能力，不是额外的模型侧 Pi 工具。保留候选筛选是 dry run；把记忆移到
L4/L5 或删除其语义解释需要显式命令。`memory delete` 保留不可变来源历史。

服务拒绝同库的第二个 daemon，惰性打开 SQLite，并清理过期的进程租约。daemon
和客户端命令要用同一个 `--data-dir` 或 `--db`。

节点身份维护在写入时自动启动：同一节点种类的精确规范名和仅大小写/空格/标点
差异的变体复用现有节点。更大范围的语义合并不靠嵌入相似度单独触发；它们需要
累积证据并使用可逆的 transform/redirect 记录；底层 merge/split RPC 是管理
恢复面，不是日常用户操作。

Pi 独立于 AG 内容预算，对每用户轮的 agent 主导回忆设限：最多三次 search、
共五次 search/get 调用、连续两次没有精确证据进展就必须 get、连续两次 search
无新候选 ID 即终止。新用户轮重置守卫。这些限制防止紧凑 AG 通过无界工具循环
被撑出来。

## Agent Skill

[`skills/nmg-memory/SKILL.md`](skills/nmg-memory/SKILL.md) 让其他有工具能力
的 Agent 使用同样的生命周期和渐进回忆工作流。它是一张小的首用卡片加按需
参考页：详细的写入、回忆和操作指引只在 Agent 忘了操作或遇到点名特例时才读。
正常路径始终是
`status → 需要则 start → search → 选中的 get → 所有权安全的 stop`。

SQLite FTS5 是零配置的 Pi 检索路径。设置 `NMG_EMBED_BASE_URL` 和
`NMG_EMBED_MODEL` 可把外部节点/叶子语义信号加进同一个预算化 Active Graph
管线。端点失败或超时时，Pi 报告降级检索并继续用 FTS5；哈希向量只留作评测
基线。`NMG_EMBED_TIMEOUT_MS` 控制请求超时（默认 10 秒）。可断点续跑的
`npm run index:embeddings` 构建该模型的索引。

显式设置 `NMG_EMBED_PROFILE` 为 `qwen3`、`bge-en` 或 `plain`。profile 定义
独立的查询和文档模板，NMG 绝不从模型名推断编码契约。自定义 provider 可改为
设置 `NMG_EMBED_QUERY_TEMPLATE` 和 `NMG_EMBED_DOCUMENT_TEMPLATE`；每个模板
必须含 `{text}`。

预处理契约是持久化嵌入索引身份的一部分。改 profile、模板、维度或相关查询
指令会创建新索引，而不是静默复用不兼容的向量。批量索引器用 SQLite 的
缺失/过期行做持久队列，报告待处理 node/leaf/record 数、脏节点、上次成功和
可重试失败。用同样的嵌入环境变量跑 `npm run index:status` 可在不联系
provider 的情况下检查状态。Pi 只在新的语义索引首次完整构建成功后才激活它；
在那之前保持 FTS5 并报告 `reason=embedding_index_not_ready`，防止半成品的
profile/模型切换。

自动写入规则刻意收窄：

- 保存清晰的、稳定的、用户陈述的事实/偏好/约束/状态，且它们可能帮到以后的
  会话。
- 模糊的、推断的、不确定的、仅限当前任务的信息先问再存。
- 绝不把闲聊、重复、未验证的模型断言、凭据、秘密或敏感个人数据存为语义记忆。
- 给每个可替换属性一个稳定 `stateKey`；同一规范作用域里的新值自动取代旧
  状态，不删其证据。`nodeName` 用于语义分组，`scope` 用于适用性；不要把一个
  宽泛 state key 复用在多个相关事实上。
- 可分开计数的行为分开存，并保留精确来源摘录：陈述是检索摘要，不是证据
  本身。
- assistant 写的对话证据视为未验证，除非用户或工具确认过。
- 遵守约束、适应偏好、只用最新活跃状态、保留事件时间，并把对话证据描述为
  "说过的内容"而非独立验证过的事实。

prompt 引导语义筛选，而扩展独立拦截高置信度凭据模式、明确的不要保留请求和
仅限当前轮的指令。这条边界不依赖模型质量。

## 无头 Pi 控制

NMG 用 Pi 原生 RPC 模式做自动化的 Agent 对 Agent 式测试。控制器保持本地，
在需要跨机互操作之前不引入 A2A server。

不发模型请求检查配置的模型：

```powershell
npm run pi:state
```

通过全新无头 Pi 会话发一条 prompt：

```powershell
npm run pi:prompt -- "Remember that the RPC controller is used for NMG tests."
```

有界的同会话生命周期测试，直接用重复 `--turn` 标志调 helper（整段对话一个
Pi 子进程和一个自有 daemon）：

```powershell
node --experimental-strip-types scripts/pi-control.ts prompt `
  --turn "Recall one durable decision and load its exact evidence." `
  --turn "Review the preceding retrieval if all feedback labels are observable."
```

每次调用都是新 Pi 会话但共享项目的 `.nmg/nmg.sqlite`，跨会话记忆测试因此
很直接。无头 helper 还把 Pi 设置隔离在 `.nmg/pi-agent` 下，只从被 git 忽略
的仓库 `.env` 加载白名单里的 benchmark 凭据，默认 90 秒 prompt 超时加 12 次
工具调用。用 `NMG_PI_AGENT_DIR`、`NMG_PI_TIMEOUT_MS`、`NMG_PI_MAX_TOOL_CALLS`
覆盖。这些是测试运行器安全限制，不是 NMG 检索限制。控制器默认
`deepseek/deepseek-v4-flash` 且关闭 thinking，用 `--no-extensions`，只显式
加载 NMG 扩展及其四个稳定工具，防止无关的全局权限扩展阻塞非交互 RPC 工具
调用。需要时设 `NMG_PI_MODEL` 覆盖测试模型。

QPP 执行拆成三个独立控制：

- `NMG_QPP1_MODE=off|shadow|active` 控制学习到的首候选池分配。默认 `shadow`；
  `active` 只能放宽一个没有调用方 limit 的显式 `nmg_search`。在控制器有可
  归因训练之前它是 fail-safe 的：规划探针不持久化，未训练的 0.5 先验改变不了
  检索。
- `NMG_QPP2_MODE=off|shadow|active` 控制该候选池内的 Fibonacci 渐进检视和
  学习到的 listwise 折叠。默认 `off`；`shadow` 保留 QPP 遥测但不改可见结果；
  `active` 可以继续下探更深的证据层级，并动态暴露足够的学习到的必要头部以
  保住配置的 listwise 概率质量。`NMG_QPP2_RETAINED_MASS` 默认 `0.98`。平坦
  的分数分布因此保持宽；陡峭的分布折叠更多。低必要性候选折叠成分组目录而非
  删除；调用方显式 `limit` 会禁用学习折叠。完整候选集仍在 Active Graph 里
  供精确 `nmg_get`；top-1 是唯一固定安全锚。学习折叠在存在可归因控制器训练
  之前是惰性的。
- `NMG_SEARCH_RECOMMENDATION=off|advisory|guardrail` 控制自动回忆不足时是否
  向模型推荐一次深思熟虑的 `nmg_search`。默认 `off`；`guardrail` 只对硬失败
  （空、仅回退、极弱回忆）发推荐。

NMG 报告每个模块的分数、质量和成本，但不替运营者选策略、也不搜索偏好组合。
启用 QPP1、QPP2 或推荐——以及组合它们——是显式的用户/运营者决策。

QPP1 常规层级封顶 20 条 / 约 6,000 token；学习到的 `expand` 决策可把 Active
Graph 提升到 50 条 / 约 10,000 token 以做聚合或多跳工作。自动回忆保持小的
固定预算。提交的 search 仍是唯一检索 trace，仍可用 `nmg_get` 读。旧的
`NMG_CONTROLLER_SEARCH=1|0` 在 `NMG_QPP1_MODE` 未设时继续映射到 QPP1
`active|shadow`。shadow 事件本地写入
`.nmg/evaluation/controller-shadow.jsonl`（或在 `NMG_DATA_DIR` 下），有界
大小和轮转。它们记录确定性与学习到的节点顺序、候选曝光、显式 `nmg_get`
使用、检索/控制器延迟、估计上下文 token 和完整运行的 token 用量。这些运行时
文件被 git 忽略。

可选的人工标注反馈可附加到最近一次检索：

```text
/nmg-shadow-feedback last success uncorrected
```

按需用 `failure`、`corrected` 或 `unknown`。NMG 不从流畅的模型输出推断
正确性。

## 结果

在官方 OmniMemEval 用户记忆套件上，NMG 在 BEAM 100K 得分 66.57 nugget
（LongMemEval / LoCoMo / PersonaMem v2 / HaluMem 进行中），含 judge 模型差异
说明，按官方快照格式记录于
[docs/benchmark-results.md](docs/benchmark-results.md)。

复现随评测代码走，不在 README：数据放置、matched-arm 协议、打分与各套件
命令见 [evals/README.md](evals/README.md) 及 `evals/` 下各 adapter 的 README。

快速 agent 级回归（`npm run eval:agents`）用全新进程的 Writer/Reader Pi 对
跑隔离 NMG 数据库，当前 6/6 通过；报告在被 git 忽略的 `evals/results/` 下。

## 安全边界

NMG 是记忆组件，不是沙箱。它不执行任意代码，也不提供执行后端。需要隔离时，
单独安装配置 Pi 沙箱插件；NMG 只记录 Pi 选择提交为记忆证据的来源和结果。

## License

[MIT](LICENSE)
