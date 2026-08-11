# Session Memory 生命周期钩子（v2 · 2026-08 第一性原理重审）

> 从第一性原理重审：NMG 需要什么 → 每个需要挂哪个钩子 → 对照 Pi 实际 API 落地。
> 上一版把 PostToolUse 写成 `tool_call_end`、把 compact 抢救写成读 `event.messages + compactThreshold`——都已核对真实 API 后修正（见「二、Pi 实际 API」）。

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
| 用户**隐式**偏好/决定 | 高 | （缺口，见「五.2 未实现」） | 无自动路径 |
| **工具执行结果** | 中 | `tool_result` | 唯一：只有它同时有 input + content + isError + 按工具 details |
| **轮/会话结局** | 高 | `agent_settled`（语义） | 唯一；但无 messages payload，需 `agent_end` 缓存 |
| **会话归档** | 中 | `session_shutdown` | 唯一：daemon 死前必须归档 |
| staging 补刷 | — | `session_start` | 唯一：上次会话后首次唤醒 |
| **compact 前丢失片段** | 高 | `session_before_compact` | 唯一拦截点 |

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
| 会话 | `session_before_compact` | **preparation, branchEntries, reason, willRetry, signal**；可取消/自定义摘要 | ✅ 清理 + 抢救 |
| 会话 | `session_compact` | compact 后 | ❌ |
| 会话 | `session_shutdown` | 会话 teardown 前 | ✅ 归档 + 清理 |
| 会话 | `session_before_tree` / `session_tree` | /tree 导航 | ❌ |
| Agent | `before_agent_start` | prompt, systemPrompt(+Options)；可注入 | ✅ recall + nudge |
| Agent | `agent_start` | run 开始 | ❌ |
| Agent | `agent_end` | **messages: AgentMessage[]** | ✅ shadow outcome |
| Agent | `agent_settled` | 完全落定（无 retry/compact/续跑）；**无 payload** | ❌（未实现，见五.1） |
| Turn/消息 | `turn_start` / `turn_end` | turnIndex / message + toolResults | ❌ |
| Turn/消息 | `message_start` / `message_update` / `message_end` | token 级热路径 | ❌ |
| 工具 | `tool_execution_start` / `tool_execution_update` | 开始 / 流式部分输出 | ❌ |
| 工具 | `tool_call` | 执行前，**可拦截**，input 可变 | ❌（已并入 tool_result） |
| 工具 | `tool_result` | 执行后，**可改**；input + content + isError + details | ✅ PostToolUse 捕获 + nudge |
| 工具 | `tool_execution_end` | 完成；result + isError，**无 input** | ❌ |
| Provider | `context` | 每次 LLM 调用前，可改 messages | ❌ |
| Provider | `before_provider_request` / `before_provider_headers` / `after_provider_response` | 请求/响应层 | ❌ |
| 配置/交互 | `model_select` / `thinking_level_select` / `user_bash` / `input` | 换模型/级别、!/!! 命令、原始输入 | ❌ |

### 两个关键 API 事实

**1. 没有 `tool_call_end`。** 工具生命周期是
`tool_execution_start → tool_call(可拦截) → tool_execution_update → tool_result(可改) → tool_execution_end`。
PostToolUse 的正确挂点是 `tool_result`：

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

**`extractDoomedMessages` 整个不需要写**——Pi 已经算好边界，直接消费 `preparation.messagesToSummarize`。

## 三、最终实现布局

```
tool_result ────────────  git commit 成功检测(nudge) + PostToolUse 记忆捕获   ← 取代 tool_call
before_agent_start ─────  recall 注入 + nudge 消费（唯一正确）
session_start ──────────  staging archive 刷写（唯一）
session_before_compact ─  injection clear + compact 抢救（唯一拦截点）
agent_end ──────────────  controller shadow outcome（需 messages）
session_shutdown ───────  archive + daemon teardown + 捕获缓存清理（唯一）
```

### 1. `tool_result` —— 取代 `tool_call`（nudge 合并 + PostToolUse 捕获）

- **nudge 从「命令匹配」改为「成功感知」**：`isError === false` 且输出不含 `nothing to commit` / `no changes added to commit` 才设标志（`isSuccessfulCommit`）。
- **捕获过滤 `isMemorableToolResult`**：
  - ✅ bash 输出含 error/warning/fatal/exception/✗，或命令是测试运行（npm/pnpm/yarn/bun/npx test、vitest/jest/pytest/go test/cargo test）
  - ✅ edit / write（路径）
  - ✅ grep 有匹配
  - ❌ read、成功 ls/find、无匹配 grep
- **去重 `SessionToolTraceCapture`**：按 (tool, statement-hash) 每 session 至多写一次（NMG 自身 exact-duplicate skip 兜底）。
- **写入 fire-and-forget**（`.catch()` 吞错），绝不阻塞工具结果热路径。
- 参数：`tier: 3` / `importance: 0.1` / marker `tool_trace` / `writeReason: "post_tool_use"`。

### 2. `session_before_compact` —— 加抢救

- 保留 injection window 清理。
- 新增：消费 `preparation.messagesToSummarize` → `summarizeSessionFragment` 拼接 → `compactRescueStatement` 截断 4KB（无 LLM 依赖）→ fire-and-forget 写入。
- 参数：`tier: 2` / `importance: 0.3` / marker `compact_rescue`（含 reason）/ `writeReason: "pre_compact_rescue"`。

### 3. 不变的钩子

`before_agent_start`（recall + nudge 消费）、`session_start`（staging 补刷）、`agent_end`（controller shadow outcome）、`session_shutdown`（归档 + daemon teardown + `toolTraceCapture.clear`）。

## 四、刻意不做（设计决定，非缺陷）

这些是明确的「不做」决策，不是待办：

- ❌ **不做 SessionStart / UserPromptSubmit / Stop 钩子**：session_start 已刷 staging、用户 prompt 已在 before_agent_start、agent_end + session_shutdown 已覆盖 Stop。

## 五、未实现 / 待办（❌ 明确未做）

> 以下为本轮从第一性原理识别出但**尚未实现**的项，按优先级排序。每项都标注了触发点、原因和落地方式，需要时直接照此实现。

### 1. `agent_settled` 迁移轮结局记忆 —— ❌ 未实现

- **需要**：轮/会话「真结局」记忆（任务完成/失败、最终决策）。
- **现状**：`agent_end` 之后 Pi 还可能 retry / auto-compact / 续跑，`agent_end` 记下的结局可能是半截的；但 `agent_settled`（真落定）**没有 messages payload**。
- **阻塞点**：需 `agent_end` 先缓存 messages，`agent_settled` 消费。
- **当前取舍**：controller shadow 是遥测而非用户记忆，暂留 `agent_end`，不动。未来做「对话结局记忆」时迁到 `agent_settled`。

### 2. 用户隐式偏好/决定自动捕获 —— ❌ 未实现

- **需要**：价值最高的记忆来源（用户偏好/决定）目前只能靠显式 `nmg_remember`，没有自动路径。
- **落地方式**：`before_agent_start`（用户 prompt 已在此）或 `agent_settled`（对话结局）做 LLM 判断式摘要。
- **阻塞点**：需要 LLM 调用，成本高、噪声控制难。
- **提醒**：别让 tool trace（tier 3）喧宾夺主，这个缺口优先级更高。

### 3. strict「同工具连发只记最后一次」 —— ❌ 未实现

- **需要**：同一工具同一 session 连续调用（fail→fix→pass），当前 exact-dedupe 会各记一条。
- **现状**：`SessionToolTraceCapture` 只做 exact-dedupe（(tool, statement-hash) 至多一次）。
- **落地方式**：延迟 flush——挂起待写结果，下轮 `before_agent_start` / 出现不同工具 / `session_shutdown` 时冲刷，只写同工具最后一次结果。
- **阻塞点**：需跨钩子状态与冲刷边界，当前为保持确定性未做。

## 六、实现清单（含未做项）

| 项 | 改动 | 状态 |
|---|---|---|
| `tool_result` 钩子（合并 nudge + 捕获） | 取代 `tool_call` | ✅ 已实现 |
| `isSuccessfulCommit` | 纯函数（成功感知 nudge） | ✅ 已实现，已测 |
| `isMemorableToolResult` / `summarizeToolResult` | 纯函数过滤 + 摘要 | ✅ 已实现，已测 |
| `toolTraceRememberParams` | 精确写入 payload | ✅ 已实现，已测 |
| `SessionToolTraceCapture` | 按 session exact-dedupe | ✅ 已实现，已测 |
| `session_before_compact` 抢救 | 消费 `messagesToSummarize` | ✅ 已实现 |
| `summarizeSessionFragment` / `compactRescueStatement` / `compactRescueRememberParams` | 拼接截断 4KB，无 LLM | ✅ 已实现，已测 |
| 测试 | 纯函数 + 注册 + nudge 端到端 | ✅ 已实现（28 通过） |
| `agent_settled` 轮结局记忆 | 需 `agent_end` 缓存 messages | ❌ 未实现（见五.1） |
| 用户隐式偏好/决定自动捕获 | LLM 判断式摘要 | ❌ 未实现（见五.2） |
| strict「同工具连发只记最后一次」 | 延迟 flush | ❌ 未实现（见五.3） |

**前置已全部解决**：`tool_result` 事件存在（含所需字段）；`session_before_compact` 直接携带 doomed 消息，无需扩展 ExtensionAPI。
