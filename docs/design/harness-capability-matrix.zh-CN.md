# Harness 适配器能力矩阵

[English](harness-capability-matrix.md)

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

参评适配器：

| 适配器 | 代码 | 契约归属 |
|---|---|---|
| Pi | `.pi/extensions/nmg/` | 参照适配器 —— 基准行 |
| OpenCode v2 | `opencode-plugin/` | [适配器决策](../decisions/implemented/2026-10-17-opencode-adapter.zh-CN.md) |
| WorkBuddy 钩子 | `workbuddy-plugin/nmg-hook.ts` | 可安装钩子，见 `workbuddy-plugin/README.md` |
| Claude Code（MCP stdio） | `claude-plugins/nmg-memory/agents/memory-copilot.ts` | [MCP 插件卡](../../claude-plugins/nmg-memory/CLAUDE.md) |
| DeepSeek Harness（旧适配器） | `dsh/nmg-plugin.mjs` | [dsh README](../../dsh/README.md) |
| DeepSeek Harness 宿主包 | `dsh/dsh-nmg/src/plugin/index.ts` | [宿主包](../../dsh/dsh-nmg/README.md)；见下方扩展表 |

## 矩阵

| 能力 | Pi | OpenCode | WorkBuddy | MCP | DSH |
|---|---|---|---|---|---|
| 自动召回（按准入回合暂存头行） | full | full* | full | none | none |
| 记忆工具（`nmg_search`/`get`/`remember`，共享 Agent Surface） | full | full | none | full | full |
| 工作状态（`space=ag`，带调用栅栏） | full | full | none | full | none |
| 工具结果观察 + 弱完成提醒 | full | full | partial | none | none |
| 归因落盘 + 代理身份心跳 | full | full | partial | partial | none |
| Board 唤醒（轮询 → 定向/世界投递） | full | partial | partial | none | none |
| 交互控制台（`/nmg`） | full | partial | none | none | none |
| 传输：lease 快路径、CLI 兜底、共享 daemon 不接管 | full | full | partial | partial | full |

`*` 语义可用，无附加限定；限定说明列在该行对应的全量语义之下。

## 协调能力扩展

上表 DSH 列是旧适配器，不是独立宿主包。以下分开列出；单元格只描述源码接线，
不代表已部署、真实空闲 Agent 唤醒或模型理解。`board-events` 为新增事件／通知字段提供
兼容门槛，旧 owner 应拒绝，不能静默丢弃字段。

| 能力 | Pi | OpenCode | WorkBuddy | MCP | DSH 旧适配器 | DSH 宿主包 |
|---|---|---|---|---|---|---|
| 事件记录与公开任务状态 | full | full | none | full | none | full |
| 点名／频道／事件通知载荷及受邀自动订阅频道 | full | full | none | full | none | full |
| 讨论／事件主动唤醒与入队后记收据 | full | partial | none | none | none | partial |
| `nmg_state` 统一工作状态 | full | full | none | full | none | full |

OpenCode 与 DSH 宿主包有私有 HTTP 注册／透传 fixture；共享唤醒测试覆盖入队成功与失败、
不重复广播世界频道及不自动认领。这不证明真实桌面空闲唤醒或模型理解。
MCP／CLI 提供显式读取，不提供主动唤醒；订阅边界由[事件契约](board-event-records.md)维护。

## 各适配器部分项

- **OpenCode** — `*`：新起进程的首回合在第一个映射事件提供项目目录前，
  召回搜索不限项目（次回合起精确）；归因落盘粒度为每次执行（
  `session.execution.succeeded`）而非真正的空闲信号，且不支持
  `claim_outcome`（缺见证时以 `provenance_degraded` 标记降级）；wake 循环
  经共享 `board-wake.ts` 接线（最近会话池投递）但未做 live smoke；客户端
  侧 TUI 模块仅在客户端注册。
- **WorkBuddy** — 钩子是被动的：按用户回合注入提示（compact 召回头行，带
  披露账本去重）、每次回合做 `registerAgent` 在场登记、每次钩子调用轮询
  board 返回至多条未投递唤醒通知之一、git commit 提醒。工具结果观察、工作
  状态、记忆工具（留给 CLI/Skill 路径）、归因与控制台均未接线；传输无 CLI
  兜底。
- **MCP** — 服务器在无 daemon 时启动自有子进程，复用已有 daemon，且只停止
  自己启动的进程。没有 CLI 兜底（服务器保证 lease 存在）；也不做回合级观
  察、归因、唤醒循环或控制台；工作状态沿共享带栅栏 state API；board 使用即心跳，读取写入投递回
  执。
- **DSH** — 五个模型可见工具（`nmg_search`、`nmg_get`、`nmg_remember`、
  `nmg_board`、`nmg_daemon status`），走共享传输（lease 快路径 + 一次性
  CLI 兜底）。CLI 兜底路径执行普通搜索、不带学习面；按设计没有自动召回、
  在场登记、观察、归因、唤醒或控制台：DSH 暴露显式准备与搜索参数。

## 维护

共享层新增能力（[流转模块](../decisions/implemented/2026-10-16-shared-session-flows.zh-CN.md)），
或某适配器首次接线某项能力时，在这里移动单元格，而不是增长各适配器的散
文清单。单元格变动与其接线变动不同步（或反之）无法通过评审；行定义保持
低判断密度，理由由链接的决策记录承载。
