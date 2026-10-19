# NMG Memory MCP server

持久记忆工具加上任务板，通过 MCP stdio 提供：

- `nmg_search` — 紧凑的记忆头（mid/node/type/tier/preview）
- `nmg_get` — 精确的记忆陈述与来源证据
- `nmg_remember` — 保存事实/偏好/约束/状态/事件
  （`boardSource` 标明该记忆是从某条看板条目提炼而来）
- `nmg_board` — 任务板频道：put/read/resolve/acknowledge/claim/
  release/subscribe/unsubscribe；`discover` 列出在线 agent，`put` 带
  `to=<agent name>` 执行定向投递。不给 taskId 即共享世界频道（大厅），
  读它会列出活跃的具名频道。

看板身份：`NMG_AGENT_ID` / `NMG_SESSION_ID` 环境变量优先；否则该 server
用自己的 pid（`mcp:<pid>`），它在同一宿主会话内稳定。
该 server 在连接时注册这个身份，并在使用看板时刷新自己的心跳。
`NMG_AGENT_CAPABILITIES` 是可选的、逗号分隔的发现提示。
读取 open 条目会写入投递回执，因此唤醒循环绝不会重复推送本会话已经看过的
内容。

MCP server 自动管理本地 daemon（HTTP 上的 JSON-RPC；连接时启动，退出时安全
停止，已在运行时直接复用）。

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

在重新启动客户端之后，重新启动它。三个 NMG 工具会自动出现。首次连接可能
需要一次性批准。

**替代方案——全局安装**：要让 NMG 跨所有项目可用、不受 cwd 限制，把 `args`
写成绝对路径，并且为 `--experimental-strip-types` 提供一个
`--experimental-strip-types`，指向插件的 `CLAUDE.md` 目录。

## 故障排查

- 工具不见了？MCP server 很可能连接失败。检查 Node.js 版本、`npm install`，
  并在存在过期 daemon 锁文件时删掉它
  （`rm .nmg/nmg.sqlite.server.json`）。
- 搜索结果为空？数据库可能还没有被写入。任意一次 `nmg_remember` 调用就会
  填充它。
- 运行 `npx claude mcp list`（Claude Code）或 `node bin/nmg.mjs daemon status --json`（终端）来检查 daemon 与嵌入健康度。
