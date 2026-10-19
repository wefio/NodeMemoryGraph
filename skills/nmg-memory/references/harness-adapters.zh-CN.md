# Harness 适配器

[English](harness-adapters.md) · [术语](harness-adapters.terms.yaml)

NMG 为各类 Harness 提供轻量适配器（Pi、Claude Code MCP、DeepSeek Harness，以及可安装的 WorkBuddy hook）。本文说明如何编写适配器；在将 NMG 接入新的工具型 Harness，或排查现有适配器行为时阅读。

## 稳定合同

适配器应保持**轻量**：不得导入 NMG 核心存储（`src/core`、`src/cli/service.ts`）。它通过 HTTP JSON-RPC 与运行中的 daemon 通信：读取 `<data-dir>/nmg.sqlite.server.json`，再携带 `Authorization: Bearer <token>` 发送 `{ jsonrpc: '2.0', method, params, id }`。仅对宿主合同明确支持的操作，才可在 daemon 不可用时回退到一次性 CLI（`node bin/nmg.mjs`）。适配器不自行接管 daemon 生命周期；daemon 运行时，应避免每次调用都启动进程（Node 启动约需 180 ms）。

以精简结果暴露共享的模型侧操作：

| 工具 | Daemon RPC（仅在支持时 CLI 回退） |
|------|----------------------------------|
| `nmg_search(query, limit?, maxTier?, nodeName?, scope?, ...)` | RPC `search` · 回退 `nmg search "<q>" --compact-json` |
| `nmg_get(memoryIds[], activeGraphId?)` | RPC `get` · 回退 `nmg get <ids...> --json` |
| `nmg_remember(statement, nodeName, ...)` | RPC `remember` · 回退 `nmg remember "<s>" --node "<n>" --json` |
| `nmg_state(action, space, operation?, ...)` | RPC `state`；`space="ag"` 是会话私有状态，`space="board"` 是共享协作。状态写入需要常驻 owner；若宿主合同未提供 CLI 回退，不要自行假设存在。 |
| `nmg_lab(action, capability?, ...)`（可选） | RPC `lab` · 仅用于已列出的可选能力，不用于日常工作状态写入 |
| `nmg_daemon(status)`（可选） | RPC `status` · 回退 `nmg daemon status --json` |

不要在适配器中手工拼装共享的搜索、证据或 remember 结果字符串。应使用 `src/integration/agent-surface.ts` 的纯函数：

- `renderSearchSurface`：精简候选项和 `activeGraphId`；
- `renderEvidenceSurface`：精确记录及有界逻辑结构；
- `renderRememberSurface`：有界语义后续候选项；
- 只有维护独立的旧版 board 工具时才使用 `renderTaskBoardSurface`。

统一的 `nmg_state` 接口拥有当前 AG 与 Task Board 操作。通过 `src/integration/state.ts` 的 `renderStateOutput` 或宿主共享状态包装器渲染结果；不要分叉字段名称、权限或状态机。

`compactSearchContext` 仍是 shell／自动召回路径使用的结构化精简 DTO。它含语义候选标题和操作所需的续接句柄，不含存储层级、分数、QPP 内部值、耗时或 token 估算。原生 TypeBox、Zod 或 JSON Schema 定义留在宿主；共享操作枚举来自 `tool-contract.ts`。宿主代码可以添加生命周期通知或宿主专属操作，但不得分叉字段名称、撤回信息的脱敏、链渲染或 remember／board 语义。因此新增工具应先有一个共享 surface 实现和合同测试，再添加轻量宿主注册包装。

基准适配器也遵守同一边界。可以保留官方请求／响应封装及结构化审计字段，但模型可见的记忆文本必须来自共享 Agent Surface，而不是评测专用的排序／渲染模式。

所有适配器都必须保留以下规则：

- `search` 返回精简标题和 `activeGraphId`；精确陈述与证据只能通过 `get` 获取。
- 日常状态操作使用 `nmg_state` 的 `ag` 和 `board` 空间。不要把独立 board 工具或 Lab 调用作为常规状态入口。旧版 `nmg_board` 可为兼容而保留；新适配器应通过 `nmg_state` 路由 board 操作。
- `get` 传入 `activeGraphId`，以记录实际使用，而非仅暴露候选项。
- 搜索标题按候选项暴露逻辑链名称及所表示的链数量。精确 `get` 使用共享 Agent Surface，并由其委托 `src/integration/chain-projection`：每条证据陈述只渲染一次，为记录添加本次响应返回的局部标签，并追加有界的仅标签 DAG。不要在宿主中实现专属边分组，也不要把这些标签当稳定 ID。
- 仅 shell 的适配器可用 `search --compact-json` 获取链名称／数量、用 `get --json` 获取规范的 `chainMemberships`／`chainEdges`。基准渲染器可以保留官方输出格式，但不能重新定义产品合同。
- board 是临时跨 Agent 协作，不是持久记忆。
- 适配器不得拥有或停止共享 daemon；一次性 CLI 会复用 daemon。

## 临时 AG 状态与 Task Board

临时状态使用统一的 `nmg_state` 入口。通过 `action="write", space="ag", operation="enable"` 启用 AG 写入租约，再整体替换当前文本或清除它。Task Board 使用同一入口并将 `space="board"` 与领域操作配对。这些是不同的 owner 和状态机，并非同一张共享图。操作枚举、各空间权限、输入字段和结果形状以 `src/integration/state.ts` 与公开的[状态空间合同](../../../docs/design/state-spaces.md)为准。

AG 替换或清除必须携带该租约所捕获的 binding，且该元数据不能由模型输入提供。传输前使用 `src/integration/state.ts` 的 `captureStateInvocation`（或等价的宿主共享 helper）。重试时保留已提供的 fence；不得重新读取状态以借用更新的激活。binding 用于隔离上下文变化，不是身份认证。状态变更已捕获后，不得悄悄改由另一个写入方回退。日常入口是 `nmg_state`，不是 Lab。日常工作状态维护见[可选能力指南](optional-capabilities.md#daily-work-status)；可选实验和管理兼容路径见其中的 [Lab 章节](optional-capabilities.md#optional-session-lab-capabilities)。

将状态携带到模型输入是独立且依赖宿主的合同。只有宿主确实实现了相应携带路径时，才使用 `integration/working-state-input.ts`。Pi 在每个用户回合只通过持久化的 `nmg-context` 消息携带一次带标签的状态块；它不会在每次推理时通过 `context` hook 重复注入状态。最终 provider 输入确认仍不受支持。不得根据状态写入成功、准备好的视图或工具结果推断状态已进入模型输入，也不要删除混合召回内容或工具历史。其他宿主应说明自身实际输入行为，不得继承 Pi 的合同。共享准备过程不写入披露记录。运行时输入合同说明[保护、预算与压缩边界](../../../docs/design/session-active-graph-runtime-design.md#dedicated-state-carriage)。

## 自动召回（可选）

只有工具接口并不能保证模型会搜索记忆。在宿主提供合适生命周期接入点时，适配器可以在每个新用户回合执行有界搜索，并通过宿主支持的上下文机制暴露 **Active-Graph header projection**（精简标题及 `activeGraphId`）。精确陈述和证据仍应由 `get(activeGraphId)` 获取；它会在 AG trace 上记录实际使用。仅显示注入的标题不算使用。限制搜索预算，按照共享披露合同折叠重复 ID；召回失败时也应让用户回合继续。

具体注入机制因宿主而异。本仓库的 DSH 包在用户消息进入 inbox 时启动召回，通过 DSH 的 `systemPrompt.context` 提供结果；Pi 使用其自身持久化的 `nmg-context` 消息路径。宿主有受支持的上下文 API 时，不要自行伪造用户消息。只有 hook 与模型侧工具共享同一宿主 session identity 时，projection handle 才有效。独立的 WorkBuddy hook 使用命名空间身份 `workbuddy-hook:<sessionId>`，发出的 projection handle 属于独立 AG；不要把该 handle 传给工具侧 `nmg_get`。当前 hook 路径没有发送 `release` RPC，因此不能声称 AG 会立即清理。Agent 必须先调用工具侧 `nmg_search` 再调用 `nmg_get`；不得为了复用 hook 创建的句柄而削弱 session 所有权边界。

对合同支持 JSON-RPC 的操作使用常驻 daemon，并为自动召回设置有界等待。CLI 回退取决于具体操作和宿主；不要承诺每种状态变更都能回退到新进程。记忆层缓慢或不可用时，不得阻塞用户回合。

## DeepSeek Harness（仓库内的包）

本仓库的 DSH 适配器是双面包 [`dsh/dsh-nmg/`](../../../dsh/dsh-nmg/README.md)。宿主侧注册 NMG 工具并执行自动召回；浏览器侧渲染可持久化的工具卡片。该包通过 DSH 的 host plugin 机制组合，因此仓库中较早的 agent-preset 配方不是本包的安装路径。

启动宿主前，在 `dsh/dsh-nmg/` 中构建：

```sh
pnpm install --frozen-lockfile
pnpm run build
```

然后将本地包安装到 web profile 并重启 DSH：

```text
dsh plugin --profile web add link:<path-to-this-repository>/dsh/dsh-nmg
```

构建产物为 `lib/index.js` 和 `lib/client.js`；`lib/` 是不入库的生成产物。`cordis.patch.yml` 将包插入 web host composition。不要编辑部署目录下的安装副本，也不要假设构建或重载会自动更新运行中的 host。当前安装与行为以该包的 README 和源码为准。

DSH host adapter 注册 `nmg_search`、`nmg_get`、`nmg_remember`、`nmg_state`、`nmg_lab` 和可选的 daemon 健康检查工具。Board 操作通过 `nmg_state` 的 `space="board"` 执行；工作状态操作使用 `space="ag"`。包在本回合首次上下文组装前执行有界自动召回，并通过 DSH 的 `systemPrompt.context` 暴露结果。这条召回路径不能证明 DSH 也会把维护中的 AG 工作状态携带进模型输入。不得把 Pi 每用户回合携带合同套用到 DSH。

不要将已移除的 preset 指令、`harness-adapters/deepseek-harness/` 模块路径、动态 `cordis_define` 试用配方或手工构造 `createUserMessage` 的方式当成本仓库当前 DSH 配置。这些指令属于已被替代的集成方式，也不是受支持的回退路径。

## 手动 CLI 路径

对 CLI 支持的操作，可让拥有 shell 的 Harness 直接调用 CLI（Windows 上的 DSH 使用 `pwsh`）：

```powershell
node bin/nmg.mjs daemon status --json
node bin/nmg.mjs search "How should answers be written?" --limit 8 --compact-json
node bin/nmg.mjs get <mid> --active-graph-id <id> --json
node bin/nmg.mjs remember "User prefers concise answers" --node "Response preferences" --type preference
```
