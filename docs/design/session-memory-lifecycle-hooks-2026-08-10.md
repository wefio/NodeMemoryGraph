# Session Memory 生命周期钩子（v3 · 2026-08 工作记忆边界重审）

> 从第一性原理重审：NMG 需要什么 → 每个需要挂哪个钩子 → 对照 Pi 实际 API 落地。
> v2 已核对真实 Pi API；v3 进一步修正语义边界：工具结果属于会话工作状态，不因工具执行或上下文压缩而自动成为持久记忆。

## 一、第一性原理：NMG 需要什么

NMG 的使命 = 给 coding agent 持久、可检索的记忆。三个动作：

1. **Recall（读）**：何时把记忆放回上下文
2. **Capture（写）**：记忆从哪些事件流来
3. **Maintain（维护）**：去重 / 过期 / 清理（store 内部逻辑，基本不碰钩子）

### Recall —— 唯一 1 个需求

| 需要 | 钩子 | 为什么唯一 |
|---|---|---|
| 每次 agent 思考前注入相关记忆 | `before_agent_start` | 只有它能返回 systemPrompt、且在 LLM 调用前；`turn_start` 无注入能力，`context` 只能改 messages |
| 用户显式搜索 | `nmg_search` 工具 | 无钩子 |

### Capture —— 按信息源拆

| 信息源 | 价值 | 钩子 | 唯一性 |
|---|---|---|---|
| 用户**显式**「记住 X」 | 最高 | `nmg_remember` 工具 | 无钩子 |
| 用户**隐式**事实/偏好/约束/决定 | 高 | 当前 Agent 按 memory policy 主动调用 `nmg_remember` | 不另启后台抽取模型 |
| **工具执行结果** | 会话工作状态 | `tool_result` | 唯一：只有它同时有 input + content + isError + 按工具 details；默认只进运行时 AG |
| **轮/会话结局** | 高 | `agent_settled`（语义） | 唯一；但无 messages payload，需 `agent_end` 缓存 |
| **会话归档** | 中 | `session_shutdown` | 唯一：daemon 死前必须归档 |
| staging 补刷 | — | `session_start` | 唯一：上次会话后首次唤醒 |
| **compact 前状态** | 工作上下文 | `session_before_compact` | 清理注入窗口；Pi 负责摘要，NMG 不自动持久化原始片段 |

## 二、Pi 实际 API（核对 `dist/core/extensions/types.d.ts`）

### 33 个事件全景（按生命周期分组）

| 分组 | 事件 | 触发时机 / payload 要点 | NMG |
|---|---|---|---|
| 会话 | `project_trust` | 信任判定前；仅 user/global/CLI 扩展 | ❌ |
| 会话 | `resources_discover` | 资源发现（startup/new/resume/fork） | ❌ |
| 会话 | `session_start` | reason, previousSessionFile | ✅ staging 补刷 |
| 会话 | `session_info_changed` | /name 改名 | ❌ |
| 会话 | `session_before_switch` | /new /resume 前；可取消 | ❌ |
| 会话 | `session_before_fork` | /fork /clone 前；可取消 | ❌ |
| 会话 | `session_before_compact` | **preparation, branchEntries, reason, willRetry, signal**；可取消/自定义摘要 | ✅ 清理注入窗口；运行时 AG 原样保留 |
| 会话 | `session_compact` | compact 后 | ❌ |
| 会话 | `session_shutdown` | 会话 teardown 前 | ✅ 归档 + 清理 |
| 会话 | `session_before_tree` / `session_tree` | /tree 导航 | ❌ |
| Agent | `before_agent_start` | prompt, systemPrompt(+Options)；可注入 | ✅ recall + nudge |
| Agent | `agent_start` | run 开始 | ❌ |
| Agent | `agent_end` | **messages: AgentMessage[]** | ✅ shadow outcome |
| Agent | `agent_settled` | 完全落定（无 retry/compact/续跑）；**无 payload** | ➖ 明确不用于自动写入 |
| Turn/消息 | `turn_start` / `turn_end` | turnIndex / message + toolResults | ❌ |
| Turn/消息 | `message_start` / `message_update` / `message_end` | token 级热路径 | ❌ |
| 工具 | `tool_execution_start` / `tool_execution_update` | 开始 / 流式部分输出 | ❌ |
| 工具 | `tool_call` | 执行前，**可拦截**，input 可变 | ❌（已并入 tool_result） |
| 工具 | `tool_result` | 执行后，**可改**；input + content + isError + details | ✅ 运行时 AG 捕获 + nudge |
| 工具 | `tool_execution_end` | 完成；result + isError，**无 input** | ❌ |
| Provider | `context` | 每次 LLM 调用前，可改 messages | ❌ |
| Provider | `before_provider_request` / `before_provider_headers` / `after_provider_response` | 请求/响应层 | ❌ |
| 配置/交互 | `model_select` / `thinking_level_select` / `user_bash` / `input` | 换模型/级别、!/!! 命令、原始输入 | ❌ |

### 两个关键 API 事实

**1. 没有 `tool_call_end`。** 工具生命周期是
`tool_execution_start → tool_call(可拦截) → tool_execution_update → tool_result(可改) → tool_execution_end`。
PostToolUse 运行时状态的正确挂点是 `tool_result`：

```ts
pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input, event.content, event.isError, event.usage
  // 按工具 details：Bash { truncation, fullOutputPath } / Edit { diff, patch, firstChangedLine } …
});
```

`tool_execution_end` 也有 result/isError，但**没有 input**（看不到命令/路径），过滤能力弱。

**2. `session_before_compact` payload** 不是 `event.messages + compactThreshold`，而是：

```ts
const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;
// preparation.messagesToSummarize  ← Pi 已算好的 doomed 消息（AgentMessage[]）
// preparation.firstKeptEntryId     ← 保留边界
// preparation.tokensBefore         ← 裁剪前 token
// preparation.previousSummary / fileOps / turnPrefixMessages / isSplitTurn
// branchEntries                    ← 当前分支全部 session entries
// reason: "manual" | "threshold" | "overflow"
```

Pi 已经算好压缩边界；当前实现不复制该消息段。它只清理持久 recall 的注入窗口，并让 session-local runtime AG 继续存在。

## 三、最终实现布局

```
tool_result ────────────  git commit 成功检测(nudge) + 会话运行时 AG 更新   ← 取代 tool_call
before_agent_start ─────  持久 recall + 运行时 AG 注入 + nudge 消费
session_start ──────────  staging archive 刷写（唯一）
session_before_compact ─  injection clear；运行时 AG 保留；不自动持久化原文
agent_end ──────────────  controller shadow outcome（需 messages）
session_shutdown ───────  archive + daemon teardown + 运行时 AG 清理（唯一）
```

### 1. `tool_result` —— 取代 `tool_call`（nudge 合并 + 运行时 AG 更新）

- **nudge 从「命令匹配」改为「成功感知」**：`isError === false` 且输出不含 `nothing to commit` / `no changes added to commit` 才设标志（`isSuccessfulCommit`）。
- **捕获过滤 `isMemorableToolResult`**：
  - ✅ bash 输出含 error/warning/fatal/exception/✗，或命令是测试运行（npm/pnpm/yarn/bun/npx test、vitest/jest/pytest/go test/cargo test）
  - ✅ edit / write（路径）
  - ✅ grep 有匹配
  - ❌ read、成功 ls/find、无匹配 grep
- **`SessionRuntimeAg`**：按 (tool, statement-hash) 去重，以 32 条和 8,000 字符双上限维护 FIFO 小滑窗，并严格按 session 隔离。
- 原工具结果仍在 Pi 上下文时不重复注入；`session_before_compact` 激活投影后，缓冲才通过 `<nmg_runtime_ag>` 注入，并明确标记为 temporary / not durable memory。
- 不调用 daemon、不写 SQLite、不生成 `MemoryRecord`。只有模型或用户随后显式调用 `nmg_remember`，语义结果才可能进入 STG/LTG。

### 2. `session_before_compact` —— 保持边界

- 清理持久 recall 的 injection window，使压缩后需要的记忆可以再次注入。
- `SessionRuntimeAg` 继续留在进程内，因此近期工具状态在下一轮仍可见。
- Pi 负责对话摘要。NMG 不再把 `messagesToSummarize` 原样拼接为 `asserted` 长期事件；上下文压缩本身不是持久化资格。

### 3. 不变的钩子

`before_agent_start`（recall + runtime AG + nudge）、`session_start`（staging 补刷）、`agent_end`（controller shadow outcome）、`session_shutdown`（归档 + daemon teardown + `runtimeAg.clear`）。

## 四、刻意不做（设计决定，非缺陷）

这些是明确的「不做」决策，不是待办：

- ❌ **不做 SessionStart / UserPromptSubmit / Stop 钩子**：session_start 已刷 staging、用户 prompt 已在 before_agent_start、agent_end + session_shutdown 已覆盖 Stop。
- ❌ **不让 `agent_settled` 自动生成结局记忆**：它没有完整消息载荷；缓存整轮消息再自动总结会复制 transcript、增加模型调用，并绕过 `remember` 的可归因语义边界。结局、决定和偏好仍由当前模型在有证据时主动调用 `nmg_remember`。
- ❌ **不增加第二套隐式写入 LLM**：事实、偏好和约束可以由 Agent 自动识别并调用现有 `nmg_remember`，但 harness 不在后台另起一个不可见判断器。这样“自动使用工具”和“系统擅自写库”保持区分。
- ❌ **不实现同工具延迟 flush**：工具状态已经是内存中的 FIFO 运行时投影，不存在持久写入次数需要合并；fail → fix → pass 的顺序本身是当前工作状态。

## 五、后续评估项

- 用真实 Pi 会话测量 runtime AG 在压缩后的任务连续性收益、注入 token 和噪声率。
- 检查 32 条 / 8,000 字符是否足够；调整必须来自实际压缩轨迹，而不是拍脑袋扩容。
- 检查哪些工具结果类型真的具备短期工作价值；无收益的过滤规则应删除。

## 六、实现清单（含未做项）

| 项 | 改动 | 状态 |
|---|---|---|
| `tool_result` 钩子（合并 nudge + 运行时状态） | 取代 `tool_call` | ✅ 已实现 |
| `isSuccessfulCommit` | 纯函数（成功感知 nudge） | ✅ 已实现，已测 |
| `isMemorableToolResult` / `summarizeToolResult` | 纯函数过滤 + 摘要 | ✅ 已实现，已测 |
| `SessionRuntimeAg` | session 隔离、去重、双预算小滑窗 | ✅ 已实现，已测 |
| `<nmg_runtime_ag>` 注入 | 临时工具状态在轮间和压缩后可见 | ✅ 已实现，已测 |
| `session_before_compact` 边界 | 清理 recall window，不自动持久化原文 | ✅ 已实现，已测 |
| 测试 | 纯函数 + 注册 + nudge/运行时 AG 端到端 | ✅ 已实现 |
| `agent_settled` 后台结局写入 | 会复制上下文并绕过语义边界 | ➖ 明确不做 |
| 第二套隐式写入 LLM | Agent 直接调用 `nmg_remember` 即是自动路径 | ➖ 明确不做 |
| strict 同工具延迟 flush | 运行时 FIFO 不写持久层 | ➖ 不再适用 |

**边界已确定**：`tool_result` 提供运行时状态，但不会自动成为记忆；`session_before_compact` 提供 doomed 消息，但 NMG 不因压缩而复制它们。持久化仍以显式 `nmg_remember` 为语义接入点。

## 七、Reasoning scratch 生命周期

可选 Lab scratchpad 与运行时 AG 不同：它是 session-private、原子写入的显式推理工作区。当前实现保证：

- 只有启用 `NMG_ENABLE_LAB_TOOLS=1` 时实例化；
- checkpoint/retry 幂等，重复调用不会复制推理节点；
- shutdown 释放当前 session，陈旧且未持有的 scratch 文件按 30 天窗口清理；
- 推理 claim 必须锚定可归因证据，scratch 内容不会自动提升为 STG/LTG。

## 八、Implementation lineage

- **Introduced — `06d3f8ac`**：接通 PostToolUse capture 与 compact 前 rescue 边界。
- **Introduced — `14cf0e89`**：把 Pi reasoning workspace 接为显式 Lab scratchpad。
- **Hardened — `fd086859`、`d05c3cfd`**：限制 scratch 生命周期并令 retry 幂等。
- **Hardened — `86d80c4e`**：要求 reasoning claim 指向证据，阻止草稿自证为真。

完整历史分类见 [implementation lineage](implementation-lineage.md)。
