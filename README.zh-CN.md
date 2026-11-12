# Node Memory Graph（NMG）

[English](README.md) | 简体中文 · [术语](README.terms.yaml)

**让 Agent 换了会话，也能接着了解你和你的项目。**

NMG 是一个本地优先的 AI Agent 记忆层。它保存有用的事实、偏好、决策及其来源，
让 Agent 在之后的会话中按需找回。记忆存放在你机器上的 SQLite 中，也可以供
支持的不同 Agent 工具共同使用。

[先试一次记忆](#试试) · [连接你的 Agent](#连接你的-agent) · [了解工作方式](#架构)

## 它有什么用？

- **接着做事。** 留住项目决策和约束，换一个会话也不必从头解释。
- **记住你的工作习惯。** 保存你明确说过的偏好，需要时再由 Agent 找回。
- **找到依据。** 搜索先给出精简候选，Agent 可以展开选中的记忆和来源再使用。
- **协调任务。** 多个 Agent 可以通过临时任务板交换有归属的任务和交付信息，
  同时使用长期记忆。

NMG 是记忆组件，不是 Agent 或模型。它不能保证 Agent 记住或找回每一条有用信息，
也不能保证记忆中的陈述一定正确。接入需要配置；见[安全边界](#安全边界)。

## 用起来是什么样？

下面是根据可运行教程整理的一个小例子：

```text
记住：  用户偏好简洁的技术回答。
搜索：  回答应该怎么写？
候选：  用户偏好简洁的技术回答。  [记忆 ID]
展开：  用户偏好简洁的技术回答。  [精确记录与证据]
```

候选是帮助定位的线索，不是证明。`get` 会展开选中的记录和证据。连接 Agent 后，
这些操作由工具完成；你也可以通过 CLI 自己体验。每次运行的 ID 和输出会不同。

## 试试

需要 **Node.js 22.19 或更新版本**，以及此仓库的本地检出。在仓库根目录运行：

```sh
npm ci
npm run tutorial:first-recall
```

教程会创建一个私有临时 SQLite 库，保存一条偏好、搜索它，再展开精确记录。
退出时会清理临时数据；它不会调用 LLM 或 embedding 服务，也不会读写你的正常
NMG 记忆。交互终端会在步骤之间暂停；非交互运行使用
`npm run tutorial:first-recall -- --non-interactive`。
[查看完整演练](docs/guides/first-recall.zh-CN.md)，了解每一步的命令和含义。

### 连接你的 Agent

把下面这段发给你正在使用的 Agent，让它根据当前环境完成接入：

```text
请帮我安装并接入 Node Memory Graph（NMG）：
https://github.com/wefio/NodeMemoryGraph

先识别你当前使用的 Agent、操作系统和已有配置。使用已有的持久仓库检出；
如果没有，请克隆到合适的持久目录。阅读仓库 README、对应适配器说明和
skills/nmg-memory/SKILL.md，再选择当前环境支持的最佳接入方式。

请完成必要的依赖安装、构建和配置，保留已有配置与数据。能使用原生
适配器或 MCP 时按对应说明接入；否则使用 CLI 加 Skill。不要覆盖已有
配置，也不要停止或重启不属于本次安装的共享 daemon。

完成后请验证：先用仓库的临时库教程检查记忆闭环，再检查当前宿主能否
发现或调用所配置的工具。明确告诉我安装位置、启用的能力、验证结果，
以及是否需要重启或由我完成某一步。不要把教程通过当作宿主接入已验证。
```

如果 Agent 无法访问网络或确定你的宿主，它会需要你提供仓库或环境信息。
下面的能力表可以帮助你选择使用哪种接入方式。

### 扩展与适配情况

| 环境 | 可以使用什么 | 需要知道的限制 |
| --- | --- | --- |
| [Pi](#pi) | 记忆的保存、搜索与证据展开；自动召回；工作状态、任务板和可选 Lab | 自动写入与召回受集成策略约束 |
| [OpenCode v2](opencode-plugin/README.md) | 记忆工具、自动召回、工作状态与任务板 | 可用时由原生查询提供首回合作用域；部分唤醒能力仍有限制 |
| [Claude Code / MCP](#claude-code-插件) | 记忆工具、工作状态、任务板和可选 Lab | 通过 MCP 显式调用；没有自动逐轮召回或推送唤醒 |
| [DeepSeek Harness](dsh/dsh-nmg/README.md) | 记忆工具、自动召回、工作状态承载和任务板 | 使用当前宿主包；生命周期与真实唤醒验证范围有限 |
| [Codex](skills/nmg-memory/references/adapter-usage.zh-CN.md#codex) | 可复用 NMG MCP 工具与 Skill，Codex 本身也支持插件包 | 专用 NMG Codex 打包与 hook 尚未交付 |
| [WorkBuddy](workbuddy-plugin/README.zh-CN.md) | Hook 自动召回；可组合 MCP 工具与 Skill | Hook 自身不提供记忆工具；Hook 与 MCP 的会话状态不同 |
| [Kimi Code CLI](kimi-plugin/README.zh-CN.md) | MCP 工具加可选提醒、在场登记和 prompt 时黑板轮询 | 只装 hook 没有记忆工具、自动召回或状态承载 |
| 其他可调用工具的 Agent | [CLI + Skill](#agent-无关-cli) 保存、搜索并展开记忆 | 需要 Agent 能执行 CLI 并读取 Skill；自动召回取决于宿主 |

适配器负责宿主工具和传输。Pi、Claude MCP、DSH 和 benchmark 桥共用 Agent Surface，
提供精简搜索、精确证据、remember 后续操作、任务板输出、脱敏和逻辑链投影；
宿主特定的生命周期、工具 schema 和传输回退仍属于各自适配器。更多边界见
[适配能力矩阵](docs/design/harness-capability-matrix.zh-CN.md)。各连接的安装和日常操作见
[适配器使用指南](skills/nmg-memory/references/adapter-usage.zh-CN.md)。

### Pi

如需手动接入，安装 [Pi](https://github.com/earendil-works/pi) 后，在 NMG 检出目录运行：

```sh
npm run build
pi install ./
pi
```

请在检出根目录执行 `pi install ./`。扩展提供 `nmg_remember`、`nmg_search`、
`nmg_get`、`nmg_state` 和 `nmg_lab`。你可以让 Agent 记住一条偏好或项目约束，
再在之后的会话中询问。自动回忆和写入受对应集成的规则约束；请检查结果，
不要假设每一轮对话都会被保存。

## Claude Code 插件

仓库包含本地 MCP 服务。安装依赖后，按照 [Claude / MCP 配置说明](claude-plugins/nmg-memory/CLAUDE.zh-CN.md#接入任意-mcp-客户端)
配置客户端。Claude Code 使用的项目 `.mcp.json` 需要按说明创建，干净检出中
不应假定它已经存在。配置后启动新的客户端会话。

## Agent 无关 CLI

没有原生插件时，能使用工具的 Agent 可以通过 CLI 使用 NMG。在仓库检出中，
`npm run cli -- <command>` 运行源码 CLI；安装后的包也提供 `nmg` 命令。

```sh
npm run cli -- status
npm run cli -- remember "The user prefers concise technical answers." --node "Response preferences" --type preference
npm run cli -- search "How should answers be written?" --compact-json
```

搜索返回候选 ID。对选中的 ID 使用 `get`；如果搜索返回 `activeGraphId`，
将它传给 `get`，以保留披露归因。[第一次回忆教程](docs/guides/first-recall.zh-CN.md)
展示完整流程。运行 `npm run cli -- <command> --help` 查看当前参数。
如果想看看图的形状，运行 `npm run cli -- graph --out memory-graph.html`，
可导出本地节点和关系视图。

## Agent Skill

[NMG Skill](skills/nmg-memory/SKILL.md)告诉兼容的 Agent 何时搜索、展开证据和
保存长期信息。按其中的安装说明，把整个 Skill 目录链接到 Agent 配置的 skills
目录。通用 Agent 走 CLI 加 Skill 的接入路径，可能需要配置。

## 架构

```text
Agent / 适配器
    │  search · get · remember · state
    │  本地 HTTP 上的 JSON-RPC
    ▼
NMG daemon ── 会话工作状态
    │
    └── SQLite：记忆、证据、图与任务板
```

适配器中的客户端代码通过 HTTP 向 daemon 发送 JSON-RPC；HTTP 处理器和记忆服务
运行在 daemon 内。Pi 默认使用 `~/.nmg/nmg.sqlite`；`NMG_DATA_DIR` 可选择其他
目录。项目本地 STG 数据另有位置。[概念地图](docs/guides/concept-map.zh-CN.md)
解释长期记忆、会话状态和证据路径；完整契约见[设计基线](docs/design/design.md)。

### 语义记忆契约

事实、偏好、约束、状态和事件各有不同含义。NMG 保留来源并使用作用域，避免把
偏好当作事实或全局规则。显式写入可用；自动写入取决于集成及其策略。细节由
[设计文档](docs/design/design.md)定义。

## 无头 Pi 控制

仓库提供用于开发和评测的本地无头 Pi 工具：`npm run pi:state` 查看配置的模型，
`npm run pi:prompt -- "Your prompt"` 启动一次新会话。Pi QPP 控制和不同调用方的
默认值见[控制器设计](docs/design/retrieval-confidence-controller/confidence-and-trigger-design.md#caller-specific-activation)
和[可选能力](skills/nmg-memory/references/optional-capabilities.zh-CN.md)。这些工具
独立于首次回忆教程，可能需要配置模型。

## 评测结果

评测记录与复现方法见 [benchmark 结果](docs/experiments/benchmark-results.zh-CN.md)
和[评测指南](evals/README.zh-CN.md)。请结合每项结果的数据集、评判和环境限制阅读；
benchmark 不保证在你的任务上得到同样结果。

## 安全边界

本地记忆库存放在你的机器上。如果配置外部 embedding 服务，选作 embedding 的文本
会发送给该服务；见 [embedding 配置](skills/nmg-memory/references/embedding.zh-CN.md)。
NMG 不提供沙箱，也不负责隔离 Agent 执行；请单独配置 Agent 和运行环境。

## 了解更多

- [第一次回忆教程](docs/guides/first-recall.zh-CN.md) · [概念地图](docs/guides/concept-map.zh-CN.md)
- [系统设计](docs/design/design.md) · [文档索引](docs/README.zh-CN.md)
- [评测指南](evals/README.zh-CN.md) · [许可证](LICENSE)
