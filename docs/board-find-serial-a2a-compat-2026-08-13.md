# NMG 黑板「先广播后定向 + 串行交接 + 系统层身份」设计与 A2A 兼容

日期：2026-08-13 · 状态：Stage 1 已实现，身份自动注册与外部 A2A 网关待定 · 范围：task board（nmg_board）/ 扩展 / kimi-hook / claude adapter

## 1. 目标

解决 4+ 个在线 pi + claude/kimi 适配器共享黑板时的三个真实痛点：

1. **没商量同时并行**：多个 handoff 同时 wake 所有订阅者，各自开工导致重复劳动/冲突。
2. **指名道姓找不到人**：想定向"请 claude/kimi 作者认领"只能广播给全世界，收不到的人也被打扰。
3. **广播噪音打穿 LLM**：广播/交接直接 wake 每个 agent 的 LLM，身份信息（谁在线/谁能做）也占用 LLM 上下文。

设计原则（延续既有纪律）：
- **系统层身份，LLM 零打扰**：身份注册和心跳不进 LLM 上下文；串行放行采用可审计的 claim/resolve/expiry，不把“已投递”误当作“已接手”。
- **广播找人 → 定向做事**：先广播发现"谁在线/谁能做"（不 wake 任何 LLM），再 `to=<agent>` 定向唤醒指定 LLM。
- **命名操作非意外默认**：`to=` 是显式指定，不猜谁该收；串行是机制默认但定向天然豁免。
- **接手 = claim**：delivery/ack 只表示到达或已读，不能释放串行槽；claim 才表示某个 Agent 已接手。

## 2. A2A 协议研究结论（2026-08-13，官方文档核实）

A2A（Agent2Agent，Google 发起、Linux Foundation）用于**跨网络/跨厂商 agent 互操作**。核心三件套：

### 2.1 Agent Card（agent 自描述名片）
- 托管于 `/.well-known/agent-card.json`，HTTP GET 发现。
- 必填：`name`（<60 字符）、`description`、`version`（semver）、`url`（A2A JSON-RPC endpoint）。
- 可选：`capabilities`（对象）、`skills`（数组，每个 skill 有 `id`/`name`/`description`/`tags`、`input`/`output_modes`、`security_requirements`）、`supportedInterfaces`（列表，首项客户端优先）。
- Agent Registry 收录时 payload <10KB。

### 2.2 Message / Part（通信回合）
- **Message** = 一次通信回合：`role`（user/agent）、唯一 `messageId`、一个或多个 `Part`。
- **Part** = 最小内容单元，v1.0 oneof 判别：
  - `Text`：string
  - `File`：`raw`（base64）或 `url`
  - `Data`：任意结构化 JSON
  - 可选 `metadata` / `filename` / `mediaType`。

### 2.3 Task（长时任务生命周期）
- 状态机：非终态 `submitted / working / input-required`；终态 `completed / canceled / failed / rejected`。
- Task 含 `id`、`status`、`messages[]`、`artifacts[]`。

### 2.4 操作与绑定
- 6 核心操作：Send Message、Send Streaming Message、Get Task、List Tasks、Cancel Task、Get Agent Card。
- 三层架构：Data Model（Task/Message/AgentCard/Part/Artifact/Extension）、Operations、Protocol Bindings。
- Bindings：JSON-RPC 2.0（我们 daemon 已是 JSON-RPC 2.0，天然同构）、gRPC、HTTP/REST。

### 2.5 结论
A2A 解决跨网络互操作，**没有**黑板语义（订阅成员制/live claim/静默 kind/串行/定向/ack）。完整引入 = 每 agent 挂 HTTP server + 重写核心结构，纯开销。**取 A2A 的"名片与发现"设计，保留黑板"协作"语义。**

## 3. 兼容策略：借名片，不借邮局

| A2A 设计 | 本地兼容版 | 兼容方式 |
|---|---|---|
| Agent Card（name/description/version/url/skills/capabilities/supportedInterfaces） | `task_board_agents` 表 | **字段直接对齐**（照搬 Agent Card schema） |
| discovery（按 Agent Card skills 匹配） | `discover` 找人（按 capabilities 匹配） | 语义一致 |
| task-status（submitted/working/completed/canceled/failed/rejected） | entry（open/claimed/resolved + ack） | **语义映射**，不强改核心表 |
| Message/Part（role/messageId/Text/File/Data） | 黑板 entry（content + kind + 附件字段） | 语义映射（kind≈role 意图） |
| JSON-RPC 2.0 | daemon RpcClient | 天然一致 |
| HTTP/SSE 传输 + `.well-known` 托管 | 本地 daemon SQLite | **不采用**（本地不需要网络层） |
| 完整 task/message 结构 | 黑板 entry 保持（kind/claim/receipt 更丰富） | **不替换** |

**未来 A2A 迁移路径**：字段已对齐 → 若接入外部 agent（另一机器/厂商），只需加 HTTP 网关做格式转换，数据模型零改动。

## 4. 设计详述

### 4.1 身份注册表（Agent Card 本地版）

```
表 task_board_agents:
  agent_name       TEXT PRIMARY KEY   -- A2A name（稳定标识：codex/kimi/observer...）
  description      TEXT               -- A2A description
  version          TEXT               -- A2A version（semver）
  url              TEXT               -- A2A url（本地可空，未来外部 endpoint）
  capabilities     TEXT               -- A2A capabilities 的 JSON（能力标签，找人匹配用）
  skills           TEXT               -- A2A skills[] 的 JSON（可选）
  supported_interfaces TEXT           -- pi / kimi / claude / mcp（A2A supportedInterfaces）
  last_seen_at     INTEGER            -- hook 心跳，判在线（在线状态 = last_seen 未超时）
  created_at       INTEGER
```

- hook/扩展**启动时 + 周期心跳** upsert（A2A Agent Card 自描述思想，本地无 HTTP）。
- **LLM 不参与**：不 wake、不进上下文。

### 4.2 广播找人（discover）——不 wake 任何 LLM

```
nmg_board discover taskId="default" need="stg 隔离审计" [capabilities="stg,audit"]
```

- 系统层把"找人通告"推给各 agent 的 **hook**（非 LLM）。
- 各 hook 用注册表身份**自动回执**"我在线、我能做 stg"——**系统自动回复，先于 claim**。
- 发起人（或系统按 capabilities 自动匹配）得到"谁在线、谁能做"清单。
- A2A discovery 语义本地化。

### 4.3 定向投递（direct delivery）——才 wake 指定 LLM

```
nmg_board put taskId="..." kind="handoff" content="..." to="codex"
```

- `to=<agent_name>`：**只有指定 agent 的 LLM 被 wake**（wake 过滤 `entry.to === myAgentName`）。
- 其他订阅者 read 可见（透明）但静默——对应 A2A direct delivery（投递存 agent 而非 channel，参考 MACP：direct 投递存 NULL）。
- **匹配用稳定 agent_name**（A2A name），不用 sessionId（reload 会变）。
- 定向条目标记 `to` 字段；`discover` 之后定向，先广播找人再点对点分工。

### 4.4 串行交接（reply-gated，一次一个）

- 每个频道**同时最多一个 outstanding actionable**（handoff/question/blocker，未定向的）。
- 新 actionable 进 **pending**（read 可见、状态 pending、不 wake）。
- **放行条件** = 前驱被 **claim**、**resolve**，或条目自身 TTL 到期后被清理。
- 当前不另设 serial timeout；队列复用 entry TTL，避免同时维护两个易冲突的过期时钟。
- **定向交接豁免串行**（`to=<agent>` 是点对点分工，天然并行安全）。

### 4.5 投递回执与接手的边界

- hook 收到 wake 可以记录 delivery receipt；Agent 明确已读时可以 ack。
- delivery/ack 均不代表任务已被承担，不驱动串行放行。
- claim 是明确接手动作；claim/resolve/TTL expiry 才驱动串行队列。

## 5. 时序全景

```
身份注册(hook 自动, Agent Card 字段)
  → 广播找人 discover(系统身份回执, 零 LLM 打扰)
  → 身份汇总(谁在线/谁能做)
  → 定向 to=<agent>(wake 指定 LLM)
  → delivery/ack 记录到达或已读（不放行）
  → claim 接手（放行下一个）→ resolve 完成
```

## 6. 数据模型变更

| 变更 | 位置 | 说明 |
|---|---|---|
| 新表 `task_board_agents` | `src/core/store/schema.ts`（现 435 task_board_entries / 704 task_board_acks 旁） | Agent Card 本地版 |
| `task_board_entries` 加列 `to TEXT` | `schema.ts` migration | 定向投递目标 |
| `task_board_entries` 加列 `serial_state TEXT`（outstanding/pending/stale/null） | `schema.ts` migration | 串行队列状态 |
| `task_board_acks` 加 `auto INTEGER` | `schema.ts` | 区分系统自动 ack / 显式 ack |
| daemon RPC：`agent/register`、`agent/heartbeat`、`board/discover` | `src/cli/protocol.ts` + `src/cli/service.ts` | 身份注册 + 找人 |

## 7. 实现计划（分步）

1. **schema**：`task_board_agents` 表 + `task_board_entries.to` / `serial_state` 列（migration，`schema.ts`）。
2. **daemon**：`agent/register` + `agent/heartbeat` + `board/discover` RPC（`src/cli/protocol.ts` / `service.ts`）。
3. **扩展 index.ts**：
   - nmg_board 工具加 `to` 参数（`index.ts:1122` 工具定义处）。
   - wake collect 过滤 `entry.to`（`index.ts:1345` collect）。
   - `discover` action（新 action，复用 put/read 路径）。
   - 串行队列逻辑（`isBoardWakeCandidate` 附近加 outstanding/pending/stale 判定）。
   - 收到自动 ack（hook 侧）。
4. **kimi-hook / claude adapter**：定向与 pending 唤醒过滤已接；身份自动注册/心跳仍待接线（`kimi-plugin/nmg-hook.mjs` / `claude-plugins/nmg-memory/agents/memory-copilot.ts`）。
5. **prompts**：nmg_board 参数描述加 `to` / discover / 串行语义（`src/prompts/nmg-prompts.yaml` board_action_parameter_description）。
6. **测试**：身份注册/定向 wake/串行放行/自动 ack 的纯函数测试（`tests/extensions/nmg/index.test.ts` 风格）。

## 8. 参考

- A2A Protocol Specification — https://github.com/a2aproject/A2A (docs/specification.md)
- A2A Agent Discovery — https://a2a-protocol.org/latest/topics/agent-discovery/
- A2A Agent Card Schema — https://www.agentcard.net/agent-card-schema
- MACP Protocol（broadcast 存 channel / direct 存 NULL）— https://github.com/multiagentcognition/macp
- Microsoft Multi-Agent Reference Architecture（Agent Registry）— https://microsoft.github.io/multi-agent-reference-architecture/docs/agent-registry/Agent-Registry.html
- Atomic Task Claiming（SQLite CAS，= 我们 live claim）— https://amux.io/demos/atomic-task-claiming/
