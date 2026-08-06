# NMG plugin for Kimi Code CLI

给 Kimi Code 的 NMG 写入提醒 hook——等价于 Pi 扩展（`.pi/extensions/nmg`）里的
completion nudge：检测到 `git commit` 或完成类关键词时，向上下文注入一条弱提醒，
提示 agent 可以用 `nmg_remember` 落库本轮结论。只是提醒，不强制写入。

Kimi 侧的工具面（`nmg_search` / `nmg_get` / `nmg_remember`）由 MCP server 提供
（`.mcp.json` 里的 `nmg` 条目），本目录只补 Kimi 缺失的事件钩子。

## 文件

- `nmg-hook.mjs` — 零依赖 hook 脚本，处理 `UserPromptSubmit`（完成类关键词）和
  `PostToolUse(Bash)`（git commit）两个事件，输出 `additionalContext`。
- `config.example.toml` — 挂进 `~/.kimi-code/config.toml` 的配置样例。

## 安装

把 `config.example.toml` 里的两个 `[[hooks]]` 段落追加到
`~/.kimi-code/config.toml`，并把命令里的路径改成本仓库的绝对路径
（Windows 路径用引号包住）。Kimi 在 Windows 上经 `cmd.exe` 执行 hook 命令，
用 `node <绝对路径>` 的形式最稳。

## 验证

```bash
# 应输出 additionalContext JSON
echo '{"hook_event_name":"UserPromptSubmit","prompt":"完成了"}' | node kimi-plugin/nmg-hook.mjs
echo '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | node kimi-plugin/nmg-hook.mjs
# 应无输出
echo '{"hook_event_name":"UserPromptSubmit","prompt":"继续"}' | node kimi-plugin/nmg-hook.mjs
```

## 备注

- 官方 hooks 文档（kimi.com/code/docs）在本次开发时无法从本机访问，事件名、
  `matcher` 字段与 `additionalContext` 响应格式依据 Kimi 与 Claude Code 兼容的
  JSON 协议（多个第三方集成的公开实现）编写；若官方 schema 有出入，改
  `nmg-hook.mjs` 顶部的字段读取即可，逻辑不用动。
- hook 出错时脚本保持静默，永远不会阻断会话。
