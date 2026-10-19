# NMG WorkBuddy 插件

[English](README.md) · [术语](README.terms.yaml)

将 NMG（Node Memory Graph）接入 WorkBuddy（兼容 Claude Code 的宿主）的界面分为三层：

| 层 | 实现 |
|---|---|
| 工具层 | MCP connector，复用 `claude-plugins/nmg-memory`（注册方式见其 `CLAUDE.md`）。 |
| 知识层 | Skill 同步：`npm run skill:nmg:sync -- --target ~/.workbuddy/skills/nmg-memory`。 |
| 事件层 | 本目录的 `nmg-hook.ts`，注册到 `~/.workbuddy/settings.json` 的 `hooks` 字段。 |

## Hook 行为

- **UserPromptSubmit**：自动召回提示（小预算搜索：`limit 13`、`maxTier 1`、`graphHops 1`；注入共享 Agent Surface 的精简标题，并按 session 折叠重复 ID）、Agent 身份注册和 Task Board 唤醒轮询。Hook 与 MCP 不共享宿主 session。Hook 使用命名空间身份 `workbuddy-hook:<sessionId>`；注入的 `activeGraphId` 属于独立 AG，不能传给 MCP 工具侧 `nmg_get`。模型需要加载精确证据时，必须先调用 MCP 工具侧 `nmg_search`，为当前工具 session 创建投影，再调用 `nmg_get`。
- **PreToolUse(Bash)**：执行 `git commit` 后提醒调用 `remember`。

Hook 是被动的：仅在存在有效 HTTP lease（`<dataDir>/nmg.sqlite.server.json` 且 PID 存活）时调用 daemon，从不启动 daemon；只接受 `127.0.0.1`，先发送 `hello` 并检查兼容纪元，静默处理失败，且始终以 0 退出。自动召回使用独立的命名空间 hook session。当前 hook 路径不会发送 `release` RPC，因此不要声称渲染后会立即释放内存态 AG。候选渲染使用 `src/integration/agent-surface.ts` 中的共享 surface，不手工拼接字符串。接入配方见 `skills/nmg-memory/references/harness-adapters.md`。

召回函数的 hello、搜索与披露共用五秒总等待预算，后续阶段到期保留及时返回的候选。身份登记与 wake 轮询不计入该函数预算，显式 MCP 搜索不受自动期限约束。[等待预算契约](../docs/design/session-memory-lifecycle-hooks-2026-08-10/automatic-recall-budget.zh-CN.md)拥有取消与同步工作的限制。

## 注册

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node --experimental-strip-types <repo>/workbuddy-plugin/nmg-hook.ts", "timeout": 10 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node --experimental-strip-types <repo>/workbuddy-plugin/nmg-hook.ts", "timeout": 10 }] }
    ]
  }
}
```

可选环境变量：`NMG_DATA_DIR`（默认 `~/.nmg`）、`NMG_AGENT_ID`／`NMG_AGENT_CAPABILITIES`（board 身份）、`NMG_ENABLE_COORDINATION=0`（只关闭身份注册与 board 协作，不关闭自动召回）。Board wake 开关与 Pi/Kimi 共用 `<dataDir>/board-wake.json`。

## 已知问题

- WorkBuddy 托管环境中的 `skill:nmg:sync` 删除锁文件时可能被 safe-delete shim 拦截，尽管 Skill 文件已同步成功。手动清理遗留的 `.nmg-memory.sync-*`；可用 `--check` 验证一致性。
- 沙箱隔离可能阻止读取／写入 `~/.nmg` 状态文件。去重状态失效不影响正确性，但可能导致重复注入。
