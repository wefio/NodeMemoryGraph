# NMG plugin for Kimi Code CLI

给 Kimi Code 的 NMG 写入提醒 hook——等价于 Pi 扩展（`.pi/extensions/nmg`）里的
completion nudge：检测到 `git commit` 或完成类关键词时，把一条弱提醒附加进上下文，
提示 agent 可以用 `nmg_remember` 落库本轮结论。只是提醒，不强制写入。

Kimi 侧的工具面（`nmg_search` / `nmg_get` / `nmg_remember`）由 MCP server 提供
（`.mcp.json` 里的 `nmg` 条目），本目录只补 Kimi 缺失的事件钩子。

## 文件

- `nmg-hook.mjs` — 零依赖 hook 脚本，处理两个**可影响主流程**的事件：
  - `UserPromptSubmit`：完成类关键词（完成了/收工/committed/done…）；
  - `PreToolUse`（matcher `Bash`）：命令里出现 `git commit`。
  
  命中时把提醒写到 stdout（退出码 0 = 放行，stdout 文本会被附加到上下文）。
  注意 `PostToolUse` 是观察型事件，输出会被丢弃，所以 git commit 提醒挂的是
  `PreToolUse` 而不是它。

## 安装

把 `config.example.toml` 里的两个 `[[hooks]]` 段落追加到
`~/.kimi-code/config.toml`，并把命令里的路径改成本仓库的绝对路径
（Windows 路径用引号包住，Kimi 在 Windows 上经 `cmd.exe` 执行 hook 命令）。
改完重开会话生效。

## 验证

```bash
# 应输出 <nmg_nudge> 提醒文本
echo '{"hook_event_name":"UserPromptSubmit","prompt":"完成了"}' | node kimi-plugin/nmg-hook.mjs
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | node kimi-plugin/nmg-hook.mjs
# 应无输出（退出码仍为 0，fail-open）
echo '{"hook_event_name":"UserPromptSubmit","prompt":"继续"}' | node kimi-plugin/nmg-hook.mjs
```

## 备注

- hook 永远以退出码 0 结束，不阻断任何操作；脚本异常时 Kimi 也是 fail-open。
- 事件名、`matcher`、退出码语义依据官方 hooks 文档；`[[hooks]]` 只接受
  `event` / `matcher` / `command` / `timeout` 四个字段，多写会导致配置加载失败。
