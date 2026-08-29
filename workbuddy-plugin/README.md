# NMG plugin for WorkBuddy

把 NMG 接入 WorkBuddy（Claude Code 兼容宿主）的接入面，共三层：

| 层 | 实现 |
|---|---|
| 工具层 | MCP connector，复用 `claude-plugins/nmg-memory`（注册方式见其 CLAUDE.md） |
| 知识层 | skill 同步：`npm run skill:nmg:sync -- --target ~/.workbuddy/skills/nmg-memory` |
| 事件层 | 本目录 `nmg-hook.ts`，注册到 `~/.workbuddy/settings.json` 的 `hooks` 字段 |

## Hook 行为

- **UserPromptSubmit**：自动召回提示（小预算 search：limit 13 / maxTier 1 / graphHops 1，注入共享 Agent Surface 的 compact 头，按 session 折叠重复 id）+ agent 身份注册 + 任务板 wake 轮询。Hook 和 MCP 不共享宿主 session，因此 hook 不泄漏自己的 `activeGraphId`；模型需要精确证据时，先通过 MCP 的 `nmg_search` 建立当前工具 session 的投影，再调用 `nmg_get`。
- **PreToolUse(Bash)**：`git commit` → remember 提醒

Hook 完全被动：只在存在活 HTTP lease（`<dataDir>/nmg.sqlite.server.json` 且 pid 存活）时调用 daemon，从不启动 daemon；它只接受 `127.0.0.1`，先执行 `hello` 并校验兼容纪元，所有失败静默，恒 exit 0。自动召回使用一次性 hook session，渲染后立即释放内存态 AG，不会与 MCP 的 session 所有权混淆。候选渲染全部走 `src/integration/agent-surface.ts` 共享面，不手拼字符串（配方出处：`skills/nmg-memory/references/harness-adapters.md`）。

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

env 可选：`NMG_DATA_DIR`（默认 `~/.nmg`）、`NMG_AGENT_ID` / `NMG_AGENT_CAPABILITIES`（板身份）、`NMG_ENABLE_COORDINATION=0`（只关闭身份注册与板协作，不关闭自动召回）。板 wake 开关与 Pi/Kimi 共用 `<dataDir>/board-wake.json`。

## 已知坑

- `skill:nmg:sync` 在 WorkBuddy 托管环境里删锁文件会被 safe-delete shim 拦截报错，但文件本体同步成功；残留 `.nmg-memory.sync-*` 手动清理即可，`--check` 可验证一致性。
- 沙箱内运行时 `~/.nmg` 状态文件读写可能被隔离，去重状态失效不影响正确性（顶多重复注入）。
