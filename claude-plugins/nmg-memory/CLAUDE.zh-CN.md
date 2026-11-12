# NMG Memory MCP server

[English](CLAUDE.md) · [术语](CLAUDE.terms.yaml)

持久记忆工具加上任务板，通过 MCP stdio 提供：

- `nmg_search` — 紧凑的记忆头（mid/node/type/tier/preview）
- `nmg_get` — 精确的记忆陈述与来源证据
- `nmg_remember` — 保存事实/偏好/约束/状态/事件
  （`boardSource` 标明该记忆是从某条看板条目提炼而来）
- `nmg_state` — 通过 `space=ag|board` 提供显式 AG 工作状态和 Task Board；
  黑板操作负责发现、订阅与回复。
- `nmg_lab` — 已列出的可选能力，不用于普通状态更新。

看板身份：`NMG_AGENT_ID` / `NMG_SESSION_ID` 环境变量优先；否则该 server
用自己的 pid（`mcp:<pid>`），它在同一宿主会话内稳定。
该 server 在连接时注册这个身份，并在使用看板时刷新自己的心跳。
`NMG_AGENT_CAPABILITIES` 是可选的、逗号分隔的发现提示。
读取 open 条目会写入投递回执，因此唤醒循环绝不会重复推送本会话已经看过的
内容。

MCP server 自动管理本地 daemon（HTTP 上的 JSON-RPC；连接时确保可用，退出时只停止自己启动的进程，复用兼容已有 owner）。

要求：Node.js ≥ 22.19，在项目中跑过 `npm install`。

## 性能反馈（默认关闭）

设置 `NMG_AGENT_PERF=1` 会让 `nmg_search` 在自己的结果后追加一行紧凑的
分阶段计时（`[perf search.direct=..ms relations=..ms total=..ms]`）。
agent 可以用它做自我维护——例如在大型记忆库上 `search.direct` 扫描很慢，
说明该裁剪或合并低层级节点。这个开关是每个 MCP server 进程各自的：共享
daemon 保持它们自己的计时行为。

```bash
NMG_AGENT_PERF=1 node --experimental-strip-types claude-plugins/nmg-memory/agents/memory-copilot.ts
```

## 接入任意 MCP 客户端

把该 server 注册为 stdio 传输：

```json
{
  "mcpServers": {
    "nmg": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-strip-types", "claude-plugins/nmg-memory/agents/memory-copilot.ts"]
    }
  }
}
```

- **Claude Code**：把上面的块放进项目根目录的 `.mcp.json`。会话启动时自动
  发现。
- **Claude Desktop**：加到 `claude_desktop_config.json` 的 `mcpServers` 下。
- **VS Code / Cursor / Codex**：加到编辑器的 MCP 配置文件。
- **任何兼容 MCP 的客户端**：同样的 JSON 块，同样的 stdio 协议。

重新加载客户端连接，再检查实际工具列表。首次连接可能需要客户端批准。单独 MCP 不增加自动召回、状态承载或空闲唤醒。

客户端可能从不同工作目录启动时，在 `args` 数组使用 `agents/memory-copilot.ts` 的绝对路径，并保留 `--experimental-strip-types` 为独立参数。其他客户端可以为同一 stdio 字段采用不同配置格式。

日常工具、状态和 hook 组合见[适配器使用指南](../../skills/nmg-memory/references/adapter-usage.zh-CN.md#claude-code-与其他-mcp-客户端)。

## 故障排查

- 工具缺失时，检查 Node 版本、依赖、绝对脚本路径与客户端日志，再检查 daemon 兼容性；不删除存活 lease 或替换共享 owner。
- 搜索为空是合法结果。先检查存储选择和查询，不为让测试返回数据而编造记忆。
- 使用客户端连接日志，并在 checkout 中执行 `node bin/nmg.mjs daemon status --json` 检查实际连接与 daemon 健康。
