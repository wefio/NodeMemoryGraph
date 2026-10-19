# Session-memory lifecycle hooks：历史设计索引

[English](session-memory-lifecycle-hooks-2026-08-10.md) | [简体中文](session-memory-lifecycle-hooks-2026-08-10.zh-CN.md) · [术语](session-memory-lifecycle-hooks-2026-08-10.terms.yaml)

始于 2026-08-10、后续加入实现观察的历史设计记录。本文是当前 owner 的索引，不是当前 Pi extension API 参考，也不是实现清单。旧事件清单、测试标签和 commit 引用都有时间范围，不是新的验证结果。

## 保留的设计边界

本文区分 session 工作上下文与持久记忆。工具输出可以帮助 Agent 继续工作，但仅仅执行工具并不使其具备持久记忆资格。压缩同样不是把原始对话片段复制到 LTG 的理由；Pi 负责自己的对话摘要，而 NMG 工作状态及任何持久化 `nmg_remember` 决策遵循各自的契约。

Session reasoning workspace 是可选的 Lab scratch surface，与 LTG memory 分开。不得把它与 Agent working-state projection、共享 Task Board 或自动记忆写入路径混为一谈。首次响应计时也是独立的 opt-in 观测功能，不是会改变检索行为的 memory lifecycle hook。

## 当前 owner 索引

- 自动召回总期限、取消与诊断：[当前等待预算契约](session-memory-lifecycle-hooks-2026-08-10/automatic-recall-budget.zh-CN.md)。

- Capture、recall 与 session working-state 边界：[Memory loop 设计](memory-loop-design.md)和[session active-graph runtime](session-active-graph-runtime-design.md)。
- Agent 可见的信息视图：[context-information 决策](../decisions/implemented/2026-10-13-context-information-views.md)。
- Working-state admission 与日常使用：[working-state 决策](../decisions/implemented/2026-10-08-ag-working-state.md)和[日常使用决策](../decisions/implemented/2026-10-12-working-state-daily-use.md)。
- Session reasoning scratch 与压缩检查点：[reasoning workspace 设计](design/session-reasoning-workspace-and-compaction-checkpoint.md)。
- 首次响应计时：[opt-in 观测决策](../decisions/implemented/2026-10-04-first-response-timing-is-opt-in.md)。
- 当前 hook 接线与生命周期 payload 处理：[Pi NMG extension](../../.pi/extensions/nmg/index.ts)、[reasoning-workspace service](../../src/integration/reasoning-workspaces.ts)和[daemon service](../../src/cli/service.ts)。

## 证据边界

原始记录包含 33 个 Pi lifecycle event 的清单和详细实现观察。Extension event 名称与 payload 可能变化；依赖 event 级主张前，应核对当前安装的 Pi API 与当前 extension 源码。旧稿中的“已实现”或“测试通过”只描述当时报告的状态。本索引不声称本次文档审计重新测试了所有列出的行为。

通过[实现沿革](implementation-lineage.md)查找当前源码 owner。保留这份历史设计，是为了说明 temporary session context、显式持久记忆、可选 reasoning scratch 和测量 instrumentation 为什么属于不同关注点。

## 自动召回等待预算

读[当前等待预算契约](session-memory-lifecycle-hooks-2026-08-10/automatic-recall-budget.zh-CN.md)；本页保留历史索引职责。

## 首次输出计时

读[可选观测决策](../decisions/implemented/2026-10-04-first-response-timing-is-opt-in.zh-CN.md)及其实现 owner。
