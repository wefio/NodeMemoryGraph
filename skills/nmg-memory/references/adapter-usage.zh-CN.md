# 通过适配器或 CLI 使用 NMG

[English](adapter-usage.md) · [术语](adapter-usage.terms.yaml)

选择、安装和使用任何已交付 NMG 宿主连接时阅读本文。开发实现见[适配器合同](harness-adapters.zh-CN.md)。
[能力矩阵](../../../docs/design/harness-capability-matrix.zh-CN.md)负责源码覆盖情况，各宿主 README 负责详细安装设置。

## 选择接入方式

安装 Skill 提供操作指引；工具、自动召回和状态承载取决于当前对话连接的适配器。

| 环境 | 安装或配置 | 使用方式与仍需显式操作的部分 |
| --- | --- | --- |
| [Pi](#pi) | 安装根目录 Pi 包 | 原生记忆／状态工具、自动召回、状态承载和黑板唤醒 |
| [Claude Code 与其他 MCP 客户端](#claude-code-与其他-mcp-客户端) | 注册 stdio MCP 服务 | 显式记忆／状态／黑板工具；单独 MCP 不提供自动召回、状态承载或空闲唤醒 |
| [Codex](#codex) | 安装生成的 Codex 插件包 | 原生会话绑定工具、自动召回、状态承载及 prompt 时黑板投递 |
| [WorkBuddy](#workbuddy) | MCP 工具，加可选事件 hook 与 Skill | Hook 增加自动召回和 prompt 时黑板轮询；hook 与 MCP 的 AG 会话不同 |
| [Kimi Code CLI](#kimi-code-cli) | MCP 工具，加可选 Kimi hook 与 Skill | Hook 增加提醒、在场登记和 prompt 时黑板轮询，不搜索记忆或承载工作状态 |
| [DeepSeek Harness](#deepseek-harness) | 构建并安装 `dsh/dsh-nmg/` 到指定 profile | 原生工具、自动召回、状态承载和面向实际会话的协作 |
| [OpenCode v2](#opencode-v2) | 在新服务中加载 `opencode-plugin/` | 原生工具、自动召回与状态承载；部分生命周期边界仍待验证 |
| [其他可使用 shell 的 Agent](#cli-与-skill) | Skill 加 NMG CLI | 显式记忆／状态／黑板操作；安装 Skill 不会增加宿主 hook |

使用持久 checkout 和兼容的插件／daemon 版本。新 checkout 先在根目录执行 `npm ci`
和 `npm run build`，再配置宿主。将客户端配置合并到既有项，保留无关设置。复用已有工具，
不要经 MCP 和 CLI 重复同一操作。Hook 可以补充工具服务，但不因此共享会话身份。

安装或故障诊断时检查 `nmg daemon status --json`，按[daemon 操作](operations.zh-CN.md)处理。
Pi 和 MCP 只管理自己启动的 daemon 生命周期；OpenCode、WorkBuddy／Kimi hook 不启动 daemon。
DSH 可以确保 daemon 可用，但不暴露生命周期所有权。复用运行中且兼容的共享 owner；
不兼容时在安全时机协调升级，不通过删除 lease 文件或停止共享服务测试插件。具体功能还可能要求声明相应能力。

## 日常使用

使用选定连接实际暴露的操作。原生和 MCP 工具在模型参数之外提供会话／writer binding。
CLI 则需要显式选择本次对话自己的 `--session-id` 并保持稳定，不能借用其他 Agent 会话绕过所有权错误。

| 需要 | 操作 |
| --- | --- |
| 找回既有决策 | 使用当前相关召回头行，或聚焦调用 `nmg_search`／CLI `search`。头行仍是候选。 |
| 查看证据 | 经 `nmg_get`／CLI `get` 读取选定 ID，并在可用时传对应 `activeGraphId`；保持连接和会话一致。 |
| 保存或更新持久记忆 | 使用 `nmg_remember`／CLI `remember`；支持动作、来源与遗忘见[写入参考](writes.zh-CN.md)。 |
| 维护进度 | 已连接 state 工具时，启用 AG writer，再通过 `nmg_state` 替换完整当前文本。CLI 也提供常驻 owner 的显式状态操作。 |
| 协调 Agent | 使用 `nmg_state space=board` 或 CLI board 操作；发现、订阅、批量读取与回复见[board 使用](board.zh-CN.md)。Hook 通知提示检查工作，不自动认领。 |

例如，依次使用以下参数对象调用 `nmg_state`：

```json
{"space":"ag","action":"write","operation":"enable","reason":"继续当前任务"}
```

```json
{"space":"ag","action":"write","operation":"replace","text":"目标：完成适配器。\n已验证：工具可以运行。\n下一步：验证剩余边界。"}
```

`updated` 和 `unchanged` 是正常简短回执。Pi、DSH、OpenCode 的下一个准入用户回合可以
独立于可选召回携带完整当前状态。MCP／CLI 的显式状态读写本身不增加自动承载，
WorkBuddy／Kimi hook 也不补上该能力。连接缺少承载路径时，应显式读取当前状态。
写入回执或模型复述不确认最终 provider 输入。

状态改变时才更新。`operation=clear` 丢弃状态；`operation=disable` 结束 writer 租约并保留可读文本。
租约过期、内容上限和恢复见[日常工作状态](optional-capabilities.zh-CN.md#日常工作状态)。
不要用 Lab 或伪造 binding 绕过缺失租约。临时进度不是持久记忆。

只有已接线的适配器才有工具观察和诊断答案归因。提醒、执行前 hook、工具成功或完成回复
都不能确认记忆中的声明。只有连接的操作支持所需标签且自己能够判断时才提交反馈，
不能为弥补反馈功能缺失而编造正向结果。

## Pi

在准备好的 checkout 根目录安装包并启动 Pi：

```text
pi install ./
pi
```

根清单选择 `extensions/nmg.ts`，由它加载共享 Pi 扩展。扩展提供记忆工具、`nmg_state`
和可选 `nmg_lab`。宿主控制台使用 `/nmg`；`/nmg state` 读取完整获准状态，其 on／off
只控制预览。唤醒控制也在 `/nmg` 中。安装细节见 [Pi 指引](../../../README.zh-CN.md#pi)。

自动召回与工作状态走持久化的每用户回合 `nmg-context` 路径，同回合后续推理不再次插入状态。
原生工具结果提供观察和弱 commit 提醒，Agent 结束归因是诊断信号。自动写入策略不表示
每条消息都会保存。扩展复用兼容共享 daemon，只停止自己启动的进程。

## Claude Code 与其他 MCP 客户端

仓库 stdio 服务为 `claude-plugins/nmg-memory/agents/memory-copilot.ts`。
Claude Code、Claude Desktop、Cursor 等 MCP 客户端可使用同一服务传输，配置格式由客户端决定。
兼容 Claude 的 JSON 配置示例：

```json
{
  "mcpServers": {
    "nmg": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-strip-types", "C:/path/to/NodeMemoryGraph/claude-plugins/nmg-memory/agents/memory-copilot.ts"]
    }
  }
}
```

Claude Code 使用项目 `.mcp.json`；其他客户端将这些 stdio 字段映射到其受支持配置。
使用绝对脚本路径，在安全边界重新加载客户端连接，并检查实际工具列表。
[MCP 配置 owner](../../../claude-plugins/nmg-memory/CLAUDE.zh-CN.md#接入任意-mcp-客户端)有客户端示例。
不能假设 Claude 插件清单本身会在所有客户端注册服务。

服务暴露 `nmg_search`、`nmg_get`、`nmg_remember`、`nmg_state` 和 `nmg_lab`。
普通 AG／黑板操作使用 `nmg_state`，不走独立 board 或 Lab 工具。连接时服务确保 daemon 可用，
复用兼容已有进程，退出时只停止自己启动的进程。会话身份属于该服务连接，
不要给互不相关的并发客户端配置同一个固定 session ID。

单独 MCP 提供显式操作，不提供逐轮召回、自动状态承载、通用宿主工具观察、答案结束归因
或空闲唤醒。部分 remember 动作也有适配器实现缺口，以矩阵为准。使用独立 hook 连接中的 ID
前，应经本 MCP 会话重新搜索／读取。Agent 名称相同不表示 AG 投影已关联。

显式检索反馈使用 `nmg_remember action=feedback`，提供被评价召回的 `activeGraphId`，
以及至少一个布尔标签或 `feedbackNote`。`false` 也是有效标签，读取回执中的 `trained` 状态。
完成回复或诊断重合不构成填写正向标签的授权。

## Codex

构建并安装生成的独立 Codex 插件包。打包、Node 要求、hook 信任和加载说明由 README 维护。
[Codex 安装指南](../../../codex-plugin/README.zh-CN.md)

适配器通过共享能力装配提供五个工具、自动召回、完整工作状态承载、工具最终结果观察，
以及 prompt／结束时批量黑板投递和答案重合诊断。原生 MCP 元数据与 hook 准入将工具绑定到相同聊天和项目。
恢复保留绑定，分叉获得独立 AG，原生 clear 开启新代次并要求新轮次准入。

使用上述 search/get 和 state enable/replace 操作。Hook 需要显式启用和信任。
禁用 hook 时仍可使用工具，项目范围在准入后确定。Stop 可携带有预算的黑板批次续接一次，
完全空闲的聊天等待原生事件。需要预先运行兼容 daemon，诊断归因要求 versioned-answer-attribution。

## WorkBuddy

连接上述 MCP 服务提供工具，安装本 Skill 提供指引。可选事件 hook 为
`workbuddy-plugin/nmg-hook.ts`。按[WorkBuddy 注册示例](../../../workbuddy-plugin/README.zh-CN.md#注册)
将 `UserPromptSubmit` 和 `PreToolUse` 项合并到 `~/.workbuddy/settings.json`，使用绝对 checkout 路径，
保留已有 hook，并按 WorkBuddy 支持的加载流程生效。

Hook 增加有预算的自动召回、在场登记、prompt 时黑板轮询和提交前提醒。它需要已运行且兼容的
本地 daemon，不会自行启动。它不提供记忆工具、state writer、自动状态承载、通用工具结果观察
或答案结束归因。连接 MCP 后，由 MCP 提供显式工具与状态读写。

Hook 使用 `workbuddy-hook:<sessionId>`，MCP 使用自己的会话。不能把 hook 创建的
`activeGraphId` 传给 MCP `nmg_get`；应先经 MCP 搜索，再在同一工具会话读取选定证据。
黑板通知在 hook 调用时到达，不是在 Agent 空闲时主动推送。Hook 配置与限制由
[WorkBuddy 指南](../../../workbuddy-plugin/README.zh-CN.md)负责。

## Kimi Code CLI

连接 MCP 提供记忆／状态工具，Skill 提供指引。Kimi 的可选 hook 为 `kimi-plugin/nmg-hook.mjs`。
将 [`config.example.toml`](../../../kimi-plugin/config.example.toml) 的两个 `[[hooks]]` 块合并到
`~/.kimi-code/config.toml`，替换为本 checkout 的绝对路径，再启动新会话。Windows 上保留模板中的
命令路径引号。Hook 支持字段为 `event`、`matcher`、`command`、`timeout`。

`UserPromptSubmit` 提供完成关键词提醒、在场登记和黑板轮询；Bash matcher 的 `PreToolUse`
提供 git commit 提醒。Hook 不执行自动记忆召回、工作状态承载或工具执行后观察。
提交前提醒不证明提交成功，因此只装 hook 不能提供记忆／状态工具。

Daemon 不可用时 hook 被动跳过。黑板通知在下一条用户 prompt 出现，不通过后台空闲唤醒。
通过已连接黑板工具订阅／读取，不把 hook／MCP 显示名相同当成共享会话。
通知控制和 hook 自测示例见 [Kimi 指南](../../../kimi-plugin/README.zh-CN.md)。

## DeepSeek Harness

使用 `dsh/dsh-nmg/` 双面宿主包，在该目录中执行：

```text
pnpm install --frozen-lockfile
pnpm run build
```

首次安装到 web profile：

```text
dsh plugin --profile web add "link:<checkout>/dsh/dsh-nmg"
```

在协调后的重启或受支持安全加载边界加载构建。`lib/index.js` 和 `lib/client.js` 必须存在，
只构建不会更新运行中的宿主。Profile 配置见[包 README](../../../dsh/dsh-nmg/README.md)。
历史 `dsh/nmg-plugin.mjs` preset 不是另一个当前目标。

原生工具包括记忆、状态、可选 Lab 和健康检查。召回在 inbox 到达时启动，请求准入准备完整状态
并等待有界召回，原生循环随后刷新 `systemPrompt.context`。新 inbox 代次排除旧自动片段。
最终工具结果接 AG 观察和弱 commit 提醒；已提交答案只在完成的 `turn/end` 上归因，
取消和重复结束被排除。发现列表代表实际 Agent 会话，不代表空适配器宿主。

## OpenCode v2

从持久 checkout 加载 `opencode-plugin/`。它直接导出 `index.ts`，没有单独适配器构建步骤。
在 `opencode.json` 中配置：

```json
{"plugins":["C:/path/to/NodeMemoryGraph/opencode-plugin"]}
```

也支持目录链接到 `.opencode/plugins/`，选择一种注册方式。在安全会话边界使用新服务，
模块缓存意味着修改 checkout 不会更新已有进程。OpenCode 的 NMG 插件不启动或停止 daemon。
详见[适配器 README](../../../opencode-plugin/README.md)。

Code Mode 使用显式 `nmg_` 名称，例如
`await tools.nmg_search({query: "Atlas 决定使用哪个数据库？"})`。原生会话查询提供首回合作用域，
插件 location 回退，`NMG_PROJECT_DIR` 显式覆盖；两者都没有目录时，召回缺少项目作用域。
Prompt 准备共用 1.5 秒总预算，迟到结果不能改变当前作用域。原生 prompt／context hook
暂存完整状态和召回，重建请求复用准备片段。新 prompt、压缩和执行完成按各自边界使旧准备失效。
手动压缩后的新回合状态承载有受控运行证据，其他生命周期时序保留独立验证门槛。

## CLI 与 Skill

宿主可使用 shell 但没有连接 NMG 工具服务时使用 CLI。安装后的包提供 `nmg`，
checkout 中可用 `node bin/nmg.mjs`：

```text
node bin/nmg.mjs daemon status --json
node bin/nmg.mjs search "Atlas 决定使用哪个数据库？" --project-dir . --session-id <SESSION> --limit 8 --compact-json
node bin/nmg.mjs get <MEMORY_ID> --active-graph-id <GRAPH_FROM_SEARCH> --project-dir . --session-id <SESSION> --json
node bin/nmg.mjs remember "Atlas 使用 SQLite。" --node Atlas --project-dir . --session-id <SESSION> --json
```

保持数据存储、项目和对话 ID 一致。显式状态与协作使用常驻 owner 的 `nmg state`／board 命令，
生命周期形式由[操作参考](operations.zh-CN.md)和[日常状态](optional-capabilities.zh-CN.md#日常工作状态)负责。
CLI 加 Skill 不会安装自动召回、状态承载或后台唤醒 hook，不能仅为复用 `activeGraphId`
而借用另一个服务的 session ID。

## 检查激活与排查故障

检查使用无敏感内容的一次性数据和私有会话。聚焦搜索后精确 get 验证工具连接；
空结果合法，不证明加载失败。宿主有自动状态承载时，可写完整状态后发送下一条 prompt。
显式读写不建立自动承载或最终 provider 投递。

| 表现 | 下一步 |
| --- | --- |
| Skill 可用但工具缺失 | 检查插件／MCP 注册、进程日志与实际工具目录。只安装操作指引不会连接工具。 |
| Pi 控制台或原生工具缺失 | 检查根包安装与扩展加载。只读 `/nmg state` 显示控制不会启用 writer。 |
| MCP 工具连接失败 | 检查 Node 版本、依赖、绝对脚本路径和客户端 stdio 配置；检查 daemon 兼容性，不删除 lease。 |
| WorkBuddy／Kimi 静默 | 检查事件注册与已运行本地 daemon。静默是失败放行行为，不证明召回成功或具备空闲唤醒。 |
| DSH 无法加载 `lib/index.js` | 构建源码包并协调加载，不编辑生成的部署文件。 |
| OpenCode 仍显示旧名称或行为 | 确认新服务只加载一次目标 checkout，核实 SDK 的 `options.namespace` 不会加名称前缀。 |
| 状态返回 `updated` 后仍缺失 | 先确认该连接是否支持自动承载，再查会话、租约和下一回合边界，并显式读取当前 AG。 |
| 图属于另一会话 | 经即将执行 get 的工具连接重新搜索，不借用身份或假定 hook／MCP 已交接。 |

每种安装分别记录验证范围。保留的[DSH／OpenCode 探测](../../../docs/experiments/runtime/native-plugin-capabilities-2026-11-12.zh-CN.md#复现)
使用私有存储和本地模拟模型，不能验证所有适配器。Pi、hook、MCP 检查分别由其源码和测试套件负责。
没有激活过程的 API-only 查询不能建立插件支持结论。真实空闲唤醒、fork／reset／重连和桌面加载
需要各宿主自己的运行证据。

## 与 Magpie 组合

Magpie 在[集成设计](../../../docs/design/unified-architecture/magpie-integration.zh-CN.md)中保持完整独立 NMG 插件目标。
本文不为尚未交付的绑定编造安装命令。经过验证的组合按操作选择一个效果所有者，接续获准会话／披露上下文，
保留各插件完整能力，同时避免重复效果。名称相同不表示会话已关联；GUI、用量与追踪属于独立增强。
拟议的 pi durable 云端绑定同样是设计目标，不是已安装的本地适配器。
