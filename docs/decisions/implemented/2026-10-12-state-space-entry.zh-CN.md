# AG 与 board 状态空间的统一 state 入口

[English](2026-10-12-state-space-entry.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [共享信息输出](2026-10-07-shared-information-output.zh-CN.md), [AG 工作状态](2026-10-08-ag-working-state.zh-CN.md), [黑板治理](2026-09-06-board-governance-addressing.zh-CN.md)

## Problem

日常 AG 状态维护经由 Lab 能力，协作状态则使用独立黑板工具。两者都提供状态，
但调用者需要切换入口与操作约定。再增加状态库或专用视图层，会复制 owner，
而不是简化接口。

## Decision

用户认可一个 state 入口，以 `read/write`、`ag/board` 状态空间及空间内具体操作
组成命令。AG 与 board 都是可读写的 state 空间，不再各自作为模型侧的独立状态
工具入口；领域 owner、权威和生命周期保持区别。

state 直接使用现有类型化信息视图与输出准备，不解析旧工具渲染文本，也不建立
另一套 state 视图协议。接口的规范归属是
[状态空间主题文档](../../design/state-spaces.md)，语法、分派、直接视图接入和迁移
边界均由该主题维护。

增量 `state` RPC 与 CLI 实现该入口。Pi、MCP、DSH 注册 `nmg_state` 而非
`nmg_board`；模型侧 Lab 拒绝日常 working-state 操作，旧 RPC/CLI 保留兼容。
普通 AG writer 显式租用已有 authority，并捕获已有 AG fence；统一入口不绕过
启用条件，也不建立第二授权库。

## Alternatives considered

- 保留独立 AG/Lab 与黑板模型入口：不作为目标接口，调用者仍需多套状态操作约定。
- 合并为一个共享状态库：不采用，命名空间统一不合并私有工作状态与协作权威、生命周期。
- 新建 state 视图或解析已有文本输出：不采用，准入的类型化视图与来源绑定输出已提供公共边界。
- 先要求管道或通用脚本引擎：不采用，已认可的命令结构无需这些机制即可提供整合点。

## Consequences

状态空间主题拥有接口定义，已有 AG 与黑板契约拥有变更语义。实现复用原有方法
和投影，不平行维护另一套行为。独立状态工具注册收敛为 state，Lab 保留其他实验能力。

此决定不增加持久层，也不证明 token 或模型连续性收益。操作确认不是协作验收、
事实支持或最终模型输入证明。文档检查只证明结构与链接；契约与隔离宿主整合
测试仅证明所测环境中的运行时行为。

迁移具名 inline 工具注册暴露了复杂度基线的方法身份碰撞。门禁按注册字面名称与
callee 识别方法，不把所有 `execute` 合成一个 owner。回归保护独立基线，复杂度
上限 15 不变。

## Deferred

- Pi 最终 provider 输入确认仍 unsupported。
- DSH 的真实 host contribution 在模拟 Cordis 服务与隔离真实 HTTP owner 上测试；
  该测试不证明生产 DSH GUI 会话已启动。
- 工具入口收敛不证明自然使用连续性或 token 收益。
- 撤下旧管理 RPC/CLI 需另作兼容决定。
