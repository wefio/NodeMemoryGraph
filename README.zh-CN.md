# Node Memory Graph (NMG)

> **Agent 会换，记忆不必换。**
>
> English version: [README.md](README.md)

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
  文件。检索零配置即可用（SQLite FTS5）；可选的语义层可以跑本地嵌入模型，
  也可以用免费额度的云端嵌入——只有待嵌入的文本会离开本机，记忆库本身
  永远不会。
- **免费。** 没有任何计费面：FTS5 检索内置，本地嵌入路径零成本，也没有
  可以升级的账号。
- **真实可用，不是概念。** CLI、JSON-RPC daemon、MCP server、三个 harness
  的可用 adapter、900+ 全绿测试。NMG 正作为自己的开发记忆被跨会话日常使用。

**诚实的边界：** NMG 还不是开箱即用。原生集成需要安装配置，通用 agent 走
CLI + Skill 路径。但它刻意做到了**对 agent 友好、易于集成**：只要你的
agent 会用 CLI，它大概率就能用 NMG；如果它会写插件，它甚至能基于稳定的
JSON-RPC 边界自己完成集成。

| 你的环境 | 接入路径 |
|---|---|
| [Pi](https://github.com/earendil-works/pi) | 原生扩展（[Try it](#try-it)） |
| Claude Code | 本地 MCP 插件（英文版 [Claude Code plugin](README.md#claude-code-plugin)） |
| DeepSeek Harness | Cordis 插件（[dsh/](dsh/README.md)） |
| 其他任意 agent | CLI + [Skill](skills/nmg-memory/SKILL.md)（英文版 [Agent-independent CLI](README.md#agent-independent-cli)、[Agent Skill](README.md#agent-skill)） |
| 自定义 harness | 基于 HTTP JSON-RPC 边界自写 adapter（英文版 [Headless control](README.md#headless-pi-control)） |

## 记忆语义契约

- 事实、偏好、约束、状态、事件、策略、对话证据有各自独立的类型和使用规则。
  类型、作用域、影响权限三者正交：呈现偏好不能改写事实，行为信号始终非强制，
  约束只在生效范围内起作用。
- 用户明确陈述的稳定事实/偏好/约束/状态自动写入；显式写入始终可用。受治理的
  写入按稳定来源身份保留支撑消息或有界精确摘录；普通闲聊、累积转录、临时
  工具输出不会进入 NMG。
- 反复出现的结果关联情节可固化为可迁移经验——情境、结果、适用性、局限、
  反例、证据——但 NMG 绝不创建或静默更新 Skill、prompt、runbook、脚本等
  行为工件。

## 快速体验

要求：Node.js 22.19 或更新版本。

```powershell
npm install
npm test          # 900+ 测试全绿
npm run cli -- status
npm run cli -- remember "User prefers concise answers" --node "Response preferences" --type preference
npm run cli -- search "How should answers be written?"
```

Claude Code 用户在本项目目录内正常启动 Claude Code 即可——根目录 `.mcp.json`
会被自动发现，无需显式安装插件；Pi 用户见英文版 [Try it](README.md#try-it)；
其他 agent 把 [skills/nmg-memory/SKILL.md](skills/nmg-memory/SKILL.md) 交给它读。

## 结果

在官方 OmniMemEval 用户记忆套件上，NMG 在 BEAM 100K 得分 66.57 nugget
（LongMemEval / LoCoMo / PersonaMem v2 / HaluMem 进行中），含 judge 模型差异
说明，按官方快照格式记录于
[docs/benchmark-results.md](docs/benchmark-results.md)。

复现随评测代码走，不在 README：数据放置、matched-arm 协议、打分与各套件
命令见 [evals/README.md](evals/README.md) 及 `evals/` 下各 adapter 的 README。

## 更多文档

架构图、四工具面、CLI 全量命令、Skill 说明与安全边界见
[英文版 README](README.md)；设计决策见
[docs/design/design.md](docs/design/design.md)。

## License

[MIT](LICENSE)
