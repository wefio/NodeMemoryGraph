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
| Kimi Code hook | `kimi-plugin/nmg-hook.mjs` | [Hook 配置](../../kimi-plugin/README.zh-CN.md)，工具另经 MCP 连接 |
| DeepSeek Harness | `dsh/dsh-nmg/src/plugin/index.ts` | 当前[宿主包](../../dsh/dsh-nmg/README.md)与[安装指南](../../skills/nmg-memory/references/harness-adapters.zh-CN.md#deepseek-harness仓库内的包) |

这里 DSH 只有一个当前集成目标，即宿主包。较早的 `dsh/nmg-plugin.mjs` preset 是历史集成代码，不是第二个当前适配目标，不纳入对照与 Magpie 功能对齐计划。

[Codex 插件包](../../codex-plugin/README.zh-CN.md)将原生 hook 与 MCP 组成一个适配器。
[原生联调](../experiments/runtime/codex-plugin-capabilities-2026-11-13.zh-CN.md)记录安装分发包与多会话证据。

Codex 承载完整 Owner 状态，使用原生传输会话元数据。黑板批次在用户 prompt 时到达，
Stop 报告处理状态未知。工具观察只接受已识别的最终结果标志。
答案归因、空闲唤醒、交互控制台及 CLI 兜底尚未接入。


## 矩阵

| 能力 | Pi | OpenCode | WorkBuddy | MCP | DSH | Kimi | Codex |
|---|---|---|---|---|---|---|---|
| 自动召回（按准入回合暂存头行） | full | full | full | none | full | none | full |
| 记忆工具（`nmg_search`/`get`/`remember`，共享 Agent Surface） | full | full | none | partial | full | none | partial |
| 工作状态（`space=ag`，带调用栅栏） | full | full | none | full | full | none | full |
| 工具结果观察 + 弱完成提醒 | full | full | partial | none | full | partial | partial |
| 归因落盘 + 代理身份心跳 | full | full | partial | partial | full | partial | partial |
| Board 唤醒（轮询 → 定向/世界投递） | full | partial | partial | none | partial | partial | partial |
| 交互控制台（`/nmg`） | full | partial | none | none | none | none | none |
| 传输：lease 快路径、CLI 兜底、共享 daemon 不接管 | full | full | partial | partial | full | partial | partial |

Pi、OpenCode、DSH 与 Codex 的工作状态承载复用完整正文 InformationView 投影。准备始终未确认，各宿主通过原生通道承载。

## 协调能力扩展

WorkBuddy 和 Kimi 列只描述各自 hook，连接 MCP 后另加 MCP 列的工具面。
Kimi hook 没有自动记忆搜索或状态承载，执行前提醒不是工具成功观察。

两表的 DSH 都指同一宿主包。单元格只描述源码接线，不代表已部署、真实空闲 Agent
唤醒或模型理解。`board-events` 为新增事件／通知字段提供
兼容门槛，旧 owner 应拒绝，不能静默丢弃字段。

| 能力 | Pi | OpenCode | WorkBuddy | MCP | DSH | Kimi | Codex |
|---|---|---|---|---|---|---|---|
| 事件记录与公开任务状态 | full | full | none | full | full | none | full |
| 点名／频道／事件通知载荷及受邀自动订阅频道 | full | full | none | full | full | none | full |
| 讨论／事件主动唤醒与入队后记收据 | full | partial | none | none | partial | none | partial |
| `nmg_state` 统一工作状态 | full | full | none | full | full | none | full |

OpenCode 与 DSH 宿主包有私有 HTTP 注册／透传 fixture；共享唤醒测试覆盖入队成功与失败、
不重复广播世界频道及不自动认领。这不证明真实桌面空闲唤醒或模型理解。
MCP／CLI 提供显式读取，不提供主动唤醒；订阅边界由[事件契约](board-event-records.md)维护。

## 各适配器部分项

- **OpenCode** — 首回合召回前通过原生 `session.get` 查询会话目录和子会话身份，回退到 `ctx.location.directory`，`NMG_PROJECT_DIR` 显式覆盖。查询失败且没有任何目录时，作用域保持不可用。归因落盘粒度为每次执行（
  `session.execution.succeeded`）而非真正的空闲信号；当前 NMG 绑定尚未建立
  `claim_outcome` 见证路径（缺见证时以 `provenance_degraded` 降级，不证明宿主限制）；wake 循环
  经共享 `board-wake.ts` 接线（最近会话池投递）但未做 live smoke；客户端
  侧 TUI 模块仅在客户端注册。
- **WorkBuddy** — 钩子是被动的：按用户回合注入提示（compact 召回头行，带
  披露账本去重）、每次回合做 `registerAgent` 在场登记、每次钩子调用轮询
  board 返回至多条未投递唤醒通知之一、git commit 提醒。工具结果观察、工作
  状态、记忆工具（留给 CLI/Skill 路径）、归因与控制台均未接线；传输无 CLI
  兜底。
- **Kimi** — 事件 hook 在用户输入时报告在场并轮询黑板通知，另提供完成关键词／提交前提醒；不搜索记忆、不暴露记忆／状态工具、不观察最终工具结果，也不落盘答案归因。显式工具来自独立 MCP 连接，prompt 时轮询不是空闲唤醒。这些是 hook 未实现项，不是 Kimi 平台能力限制。
- **MCP** — 服务器在无 daemon 时启动自有子进程，复用已有 daemon，且只停止
  自己启动的进程。没有 CLI 兜底（服务器保证 lease 存在）；也不做回合级观
  察、归因、唤醒循环或控制台。remember 动作枚举包含反馈，但当前 NMG 服务器实现缺少
  标签参数与处理分支，属于实现缺口，不是 MCP 协议限制。
  工作状态沿共享带栅栏 state API；board 使用即心跳，读取写入投递回
  执。
- **DSH** — 宿主包在原生请求准入时准备状态与召回，经 `systemPrompt.context` 承载。`tools/result` 接共享 AG 观察和 commit 提醒。已提交 `assistant/message` 与完成的 `turn/end` 每回合落一次诊断答案重合，取消、外部和重复事件不产生归因。桌面生命周期边界与真实唤醒单独保留验证门槛。

## 维护

将未接线单元格当成宿主限制前，先看[原生宿主核实](#原生宿主能力核实)。

共享层新增能力（[流转模块](../decisions/implemented/2026-10-16-shared-session-flows.zh-CN.md)），
或某适配器首次接线某项能力时，在这里移动单元格，而不是增长各适配器的散
文清单。单元格变动与其接线变动不同步（或反之）无法通过评审；行定义保持
低判断密度，理由由链接的决策记录承载。

## 原生宿主能力核实

[OpenCode 适配器决策](../decisions/implemented/2026-10-17-opencode-adapter.zh-CN.md)已提供本矩阵最初的运行证据。[原生插件核实记录](../experiments/runtime/native-plugin-capabilities-2026-11-12.zh-CN.md)补充固定 DSH 合同、已安装核心包探测和 OpenCode 私有 API 结果，分别记录源码／包版本，不用 API 存在覆盖历史 smoke 证据。已安装核心包及本地模拟模型验证下表的有界原生接线，未覆盖全部生命周期边界或生产部署。

| NMG 行为 | DSH 原生路径与分类 | OpenCode 原生路径与分类 |
| --- | --- | --- |
| 维护状态承载 | **可原生接线。** 已有 `systemPrompt.context` 和准入刷新，已安装 prompt 刷新／撤销探测通过，NMG 在准入时准备完整 owner 状态并经该通道承载。 | **已接线并运行验证。** Prompt 准入准备完整 owner 状态，`context` 独立于召回承载。真实已安装宿主已向本地模拟模型发送状态。 |
| 工具结果观察／提醒 | **可原生接线。** `tools/result` 通知最终成功／错误结果，已安装服务探测通过，NMG 使用共享筛选、AG 写入与弱完成提醒。 | **已接线。** `ctx.tool.hook("execute.after")` 进入共享观察／提醒逻辑。 |
| 诊断归因 | **已接线到提交后的回合完成。** `session/event` 提供已提交答案与完成的 `turn/end`。已安装核心包运行与取消／去重 fixture 验证该有界路径。 | **已按 execution 完成接线。** 原始 smoke 验证该路径，不证明真正空闲或正确性。 |
| 首回合作用域 | 当前包绑定真实 Agent／会话身份，进一步作用域变化需要原生映射检查。 | **已接线并运行验证。** 原生 SDK `session.get` 在召回前返回 location。已安装宿主运行验证首回合作用域，截止时间测试拒绝迟到准备。 |
| 黑板唤醒与忙碌 | **原生路径存在且部分接线。** Agent status 与 `send`／`followup`／`steer`，私有 fixture 覆盖 NMG 投递，真实宿主入队／子会话恢复仍需运行验证。 | **原生投递路径已接线，真实行为待验证。** 已有 `ctx.session.prompt` 和 execution 事件，队列／空闲语义待测试，网关流量不替代它们。 |
| fork／reset／压缩隔离 | **集成待验证。** 生命周期创建来源区分 startup／resume／clear／compact，需映射 NMG incarnation／frame fence。 | **集成待验证。** 已安装宿主与本地模拟模型验证手动压缩及后续状态承载。fork／重连代次和中断／自动压缩仍待验证。 |
| Claim outcome 见证 | **语义／lineage 待验证。** 已有原生工具身份，但结果不因此自动成为合格 claim 见证。 | **实现／验证待完成。** NMG handler 缺见证映射，已有工具／日志 API 是候选，不证明宿主做不到。 |
| 最终 provider 输入收据 | **待验证。** Prompt 投影和日志提交不建立最终 provider 接收。 | **待验证。** 可变 context 与执行成功不建立最终 provider 接收。 |

以下是具体入口的明确限制，不证明整个 NMG 功能做不到：

- DSH context text provider 是同步的，应在其他入口异步准备，经受支持上下文通道提供有界快照。
- DSH `agent/request` 替换调用配置，不修改 messages；内容使用有日志的上下文通道。`tools/result` 只观察不否决，执行门禁属于前执行策略路径。
- 历史 OpenCode 2.0.32 运行不发出 `session.created` 或 `session.idle`，不能依赖这两个名字；会话查询和 execution 事件提供原生替代，精确生命周期等价性仍需测试。

现有证据未建立必须交给 Magpie 才能完成的 DSH／OpenCode 核心 NMG 功能。完整 Magpie 插件保持独立提供方，验证共享合同和交接后，组合可以选择原生或网关提供方。
