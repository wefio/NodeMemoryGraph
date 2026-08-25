# NMG plugin for Kimi Code CLI

给 Kimi Code 的 NMG hook——补 Kimi 缺失的事件钩子。两件事：

1. **写入提醒**：检测到 `git commit` 或完成类关键词时，把一条弱提醒附加进上下文，
   提示 agent 可以用 `nmg_remember` 落库本轮结论。只是提醒，不强制写入
   （等价于 Pi 扩展里的 completion nudge）。
2. **黑板唤醒（降级版）**：每次 `UserPromptSubmit` 轮询 daemon 的任务黑板——
   世界频道 + 本会话订阅的频道——有新的 open 条目且未投递过时，附加一条通知。
   Pi 扩展的唤醒是后台定时器 + 空闲检测；Kimi hooks 没有后台定时器，
   所以通知到达时机是"下一条用户消息"而不是即时。协议与 Pi 完全一致：
   跳过自己的回声/已认领/广播条目，`deliveryCheck` 去重，
   通知后写 `recordDelivery` 回执，同一条目不重复打扰。
3. **系统层身份**：每次 `UserPromptSubmit` 在已有 daemon 上报告 Kimi 的稳定
   `NMG_AGENT_ID` 和可选 `NMG_AGENT_CAPABILITIES`。注册不要求开启 wake，不输出
   上下文，也不会启动 daemon；因此 MCP 的 `nmg_board discover` 可以找到仅由
   hook 在线的 Kimi 会话。

Kimi 侧的工具面（`nmg_search` / `nmg_get` / `nmg_remember` / `nmg_board`）由
MCP server 提供（`.mcp.json` 里的 `nmg` 条目），本目录只补事件钩子。

## 唤醒开关

唤醒默认开启，让新 Agent 不需要先手动配置就能发现共享工作。把
`<数据目录>/board-wake.json` 里的 `enabled` 设为 `false` 可关闭（与 Pi
扩展 `/nmg wake off` 写的是同一个文件，一处开关两边生效）：

```json
{ "enabled": false, "budget": 8, "cooldownMs": 600000 }
```

`budget` 是每日通知上限（0 = 不限），`cooldownMs` 是两次通知的最小间隔
（0 = 无冷却）。hook 自身的预算/冷却状态记在 `kimi-board-wake-state.json`，
与 Pi 的 wake 状态互不消耗。hook 是被动的：daemon 没运行就直接静默跳过，
绝不替你启动 daemon。

## 文件

- `nmg-hook.mjs` — 零依赖 hook 脚本，处理两个**可影响主流程**的事件：
  - `UserPromptSubmit`：完成类关键词（完成了/收工/committed/done…）+ 黑板唤醒轮询；
  - `PreToolUse`（matcher `Bash`）：命令里出现 `git commit`。

  命中时把提醒/通知写到 stdout（退出码 0 = 放行，stdout 文本会被附加到上下文）。
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
