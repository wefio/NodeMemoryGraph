# Harness 适配器能力矩阵

[English](harness-capability-matrix.md) · [术语](harness-capability-matrix.terms.yaml)

**Status:** current

**Related:**
[适配器边界规则](design.md#42-modular-harness-adapters),
[共享会话流转](../decisions/implemented/2026-10-16-shared-session-flows.zh-CN.md),
[OpenCode 适配器决策](../decisions/implemented/2026-10-17-opencode-adapter.zh-CN.md),
[适配器配方](../../skills/nmg-memory/references/harness-adapters.md)

## 行与列

每行是一项 harness 能从 NMG 获得的能力；每列是一个已随仓库交付的适配器。
`full`、`partial`、`none` 描述的是该适配器接线到共享层与 daemon RPC 的覆盖
程度 —— design 基线中的边界规则决定接线允许分叉什么，因此本页评估的是覆盖
面，不是实现质量。

`none` 表示 NMG 未接线，不表示 Harness 做不到。缺口分析区分尚未实现、宿主路径待验证、宿主明确限制。只有最后一类才能判断做不到，且需要固定版本宿主合同或有范围的复现。DSH 与 OpenCode 已有上下文／工具／事件 hook，说明存在可用扩展路径，未接入的 NMG 行为仍属于实现或验证工作。

参评适配器：

| 适配器 | 代码 | 契约归属 |
|---|---|---|
| Pi | `.pi/extensions/nmg/` | 参照适配器 —— 基准行 |
| OpenCode v2 | `opencode-plugin/` | [适配器决策](../decisions/implemented/2026-10-17-opencode-adapter.zh-CN.md) |
| WorkBuddy 钩子 | `workbuddy-plugin/nmg-hook.ts` | 可安装钩子，见 `workbuddy-plugin/README.md` |
| Claude Code（MCP stdio） | `claude-plugins/nmg-memory/agents/memory-copilot.ts` | [MCP 插件卡](../../claude-plugins/nmg-memory/CLAUDE.md) |
| DeepSeek Harness | `dsh/dsh-nmg/src/plugin/index.ts` | 当前[宿主包](../../dsh/dsh-nmg/README.md)与[安装指南](../../skills/nmg-memory/references/harness-adapters.zh-CN.md#deepseek-harness仓库内的包) |

这里 DSH 只有一个当前集成目标，即宿主包。较早的 `dsh/nmg-plugin.mjs` preset 是历史集成代码，不是第二个当前适配目标，不纳入对照与 Magpie 功能对齐计划。

## 矩阵

| 能力 | Pi | OpenCode | WorkBuddy | MCP | DSH |
|---|---|---|---|---|---|
| 自动召回（按准入回合暂存头行） | full | full* | full | none | full |
| 记忆工具（`nmg_search`/`get`/`remember`，共享 Agent Surface） | full | full | none | partial | full |
| 工作状态（`space=ag`，带调用栅栏） | full | full | none | full | full |
| 工具结果观察 + 弱完成提醒 | full | full | partial | none | none |
| 归因落盘 + 代理身份心跳 | full | full | partial | partial | partial |
| Board 唤醒（轮询 → 定向/世界投递） | full | partial | partial | none | partial |
| 交互控制台（`/nmg`） | full | partial | none | none | none |
| 传输：lease 快路径、CLI 兜底、共享 daemon 不接管 | full | full | partial | partial | full |

`*` 语义可用，无附加限定；限定说明列在该行对应的全量语义之下。

## 协调能力扩展

两表的 DSH 都指同一宿主包。单元格只描述源码接线，不代表已部署、真实空闲 Agent
唤醒或模型理解。`board-events` 为新增事件／通知字段提供
兼容门槛，旧 owner 应拒绝，不能静默丢弃字段。

| 能力 | Pi | OpenCode | WorkBuddy | MCP | DSH |
|---|---|---|---|---|---|
| 事件记录与公开任务状态 | full | full | none | full | full |
| 点名／频道／事件通知载荷及受邀自动订阅频道 | full | full | none | full | full |
| 讨论／事件主动唤醒与入队后记收据 | full | partial | none | none | partial |
| `nmg_state` 统一工作状态 | full | full | none | full | full |

OpenCode 与 DSH 宿主包有私有 HTTP 注册／透传 fixture；共享唤醒测试覆盖入队成功与失败、
不重复广播世界频道及不自动认领。这不证明真实桌面空闲唤醒或模型理解。
MCP／CLI 提供显式读取，不提供主动唤醒；订阅边界由[事件契约](board-event-records.md)维护。

## 各适配器部分项

- **OpenCode** — `*`：新起进程的首回合在第一个映射事件提供项目目录前，
  召回搜索不限项目（次回合起精确）；归因落盘粒度为每次执行（
  `session.execution.succeeded`）而非真正的空闲信号；当前 NMG 绑定尚未建立
  `claim_outcome` 见证路径（缺见证时以 `provenance_degraded` 降级，不证明宿主限制）；wake 循环
  经共享 `board-wake.ts` 接线（最近会话池投递）但未做 live smoke；客户端
  侧 TUI 模块仅在客户端注册。
- **WorkBuddy** — 钩子是被动的：按用户回合注入提示（compact 召回头行，带
  披露账本去重）、每次回合做 `registerAgent` 在场登记、每次钩子调用轮询
  board 返回至多条未投递唤醒通知之一、git commit 提醒。工具结果观察、工作
  状态、记忆工具（留给 CLI/Skill 路径）、归因与控制台均未接线；传输无 CLI
  兜底。
- **MCP** — 服务器在无 daemon 时启动自有子进程，复用已有 daemon，且只停止
  自己启动的进程。没有 CLI 兜底（服务器保证 lease 存在）；也不做回合级观
  察、归因、唤醒循环或控制台。remember 动作枚举包含反馈，但当前 NMG 服务器实现缺少
  标签参数与处理分支，属于实现缺口，不是 MCP 协议限制。
  工作状态沿共享带栅栏 state API；board 使用即心跳，读取写入投递回
  执。
- **DSH** — 宿主包注册共享记忆／state 工具，通过 inbox 事件与
  `systemPrompt.context` 召回，登记真实会话并定向唤醒。专用工作状态承载、
  通用工具结果观察及答案归因落盘尚未在 NMG 实现中接线。宿主已有上下文与
  生命周期入口，先评估并测试原生实现，再判断这些功能是否需要 Magpie。

## 维护

将未接线单元格当成宿主限制前，先看[原生宿主核实](#原生宿主能力核实)。

共享层新增能力（[流转模块](../decisions/implemented/2026-10-16-shared-session-flows.zh-CN.md)），
或某适配器首次接线某项能力时，在这里移动单元格，而不是增长各适配器的散
文清单。单元格变动与其接线变动不同步（或反之）无法通过评审；行定义保持
低判断密度，理由由链接的决策记录承载。

## 原生宿主能力核实

[OpenCode 适配器决策](../decisions/implemented/2026-10-17-opencode-adapter.zh-CN.md)已提供本矩阵最初的运行证据。[原生插件核实记录](../experiments/runtime/native-plugin-capabilities-2026-11-12.zh-CN.md)补充固定 DSH 合同、已安装核心包探测和 OpenCode 私有 API 结果，分别记录源码／包版本，不用 API 存在覆盖历史 smoke 证据。这些结论用于分类实现工作，不提升上表已交付单元格。

| NMG 行为 | DSH 原生路径与分类 | OpenCode 原生路径与分类 |
| --- | --- | --- |
| 维护状态承载 | **可原生接线。** 已有 `systemPrompt.context` 和准入刷新，已安装 prompt 刷新／撤销探测通过，NMG 专用状态承载未接线。 | **可原生接线。** 既有 `ctx.session.hook("context")` 已承载暂存召回，将共享状态准备接入并测试独立承载规则。 |
| 工具结果观察／提醒 | **可原生接线。** `tools/result` 通知最终成功／错误结果，已安装服务探测通过，NMG 筛选／AG 写入仍需接线。 | **已接线。** `ctx.tool.hook("execute.after")` 进入共享观察／提醒逻辑。 |
| 诊断归因 | **原生入口已确认，集成待验证。** `agent/turn-stopping`、`agent/status`、已提交会话事件和 assistant stream 提供边界，测试最终事件选择、取消和去重。 | **已按 execution 完成接线。** 原始 smoke 验证该路径，不证明真正空闲或正确性。 |
| 首回合作用域 | 当前包绑定真实 Agent／会话身份，进一步作用域变化需要原生映射检查。 | **原生查询可用。** 私有 `session.get` 在 prompt 前返回 location。召回前调用对应授权路径属于 NMG 集成工作，SDK 映射／截止时间行为待验证。 |
| 黑板唤醒与忙碌 | **原生路径存在且部分接线。** Agent status 与 `send`／`followup`／`steer`，私有 fixture 覆盖 NMG 投递，真实宿主入队／子会话恢复仍需运行验证。 | **原生投递路径已接线，真实行为待验证。** 已有 `ctx.session.prompt` 和 execution 事件，队列／空闲语义待测试，网关流量不替代它们。 |
| fork／reset／压缩隔离 | **集成待验证。** 生命周期创建来源区分 startup／resume／clear／compact，需映射 NMG incarnation／frame fence。 | **集成待验证。** 已有 fork／compact／session API，压缩已接线，API 列表不建立事件时序、重连与代次映射。 |
| Claim outcome 见证 | **语义／lineage 待验证。** 已有原生工具身份，但结果不因此自动成为合格 claim 见证。 | **实现／验证待完成。** NMG handler 缺见证映射，已有工具／日志 API 是候选，不证明宿主做不到。 |
| 最终 provider 输入收据 | **待验证。** Prompt 投影和日志提交不建立最终 provider 接收。 | **待验证。** 可变 context 与执行成功不建立最终 provider 接收。 |

以下是具体入口的明确限制，不证明整个 NMG 功能做不到：

- DSH context text provider 是同步的，应在其他入口异步准备，经受支持上下文通道提供有界快照。
- DSH `agent/request` 替换调用配置，不修改 messages；内容使用有日志的上下文通道。`tools/result` 只观察不否决，执行门禁属于前执行策略路径。
- 历史 OpenCode 2.0.32 运行不发出 `session.created` 或 `session.idle`，不能依赖这两个名字；会话查询和 execution 事件提供原生替代，精确生命周期等价性仍需测试。

现有证据未建立必须交给 Magpie 才能完成的 DSH／OpenCode 核心 NMG 功能。完整 Magpie 插件保持独立提供方，验证共享合同和交接后，组合可以选择原生或网关提供方。
