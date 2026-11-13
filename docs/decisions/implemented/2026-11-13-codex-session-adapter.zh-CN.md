# Codex 插件会话与独立分发

[English](2026-11-13-codex-session-adapter.md) · [术语](2026-11-13-codex-session-adapter.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [能力装配](../../design/unified-architecture/adapter-capability-assembly.zh-CN.md)

## 问题

Codex 通过不同连接运行 MCP 进程和生命周期 hook。进程级会话覆盖会合并无关聊天，
hook 与 MCP 使用不同身份又会破坏 Owner 状态承载及精确证据访问。
依赖当前 checkout 的插件也无法独立分发。

## 决策

Codex 适配器在可执行目录中声明共享能力。原生 MCP 信封提供 thread 和 turn ID，
hook 准入记录相同 ID 及绝对项目目录。模型参数无法选择会话。
共享 MCP 工具实现通过 AsyncLocalStorage 捕获每次请求的绑定与取消信号。
通用 MCP 通过同一工具工厂保留原有配置会话行为。

路由记录最多保存 128 条原生轮次作用域。恢复保留身份，分叉使用独立 AG。
Clear 改变 AG 代次并拒绝旧轮次。Daemon 已接收的操作仍可能在捕获的旧 AG 完成。
Writer 租约、证据及维护状态由 daemon 管理。没有 hook 准入时，显式工具可用，
项目范围未知。Clear 后要求新轮次完成准入。

Hook 装配共享召回、Owner 状态投影、观察、提醒及 prompt 时黑板批次。
Owner 状态在可选召回之前准备。输出接收后才写黑板回执。Stop 报告处理状态未知。
本绑定的答案归因及空闲唤醒事件尚未接入。

构建将 Node 客户端、Skill 和兼容清单打入本地 marketplace 包，嵌入运行依赖。
依赖闭包检查拒绝导入 Store 和 NmgService。MCP 使用插件相对 cwd，显式传递
NMG 数据目录及协作设置。客户端使用兼容 daemon 租约，RPC 失败后清除缓存租约，
供下次请求重新读取。安装指南维护命令和信任要求。
[Codex 插件包](../../../codex-plugin/README.zh-CN.md)

## 后果

原生元数据支持与已审阅 hook 是宿主前提。每次 hook 调用加载客户端及路由记录。
宿主突然终止时，注册表通过心跳过期处理。路由文件为恢复而保留，含标识与项目路径，
不含记忆正文或凭据。

契约测试覆盖共享连接隔离、外来投影拒绝、代次栅栏、完整状态承载及独立包启动。
保留的原生探针将解压后的分发包安装到私有 Codex home，通过本地确定性模型运行
并发聊天、恢复和分叉。已验证 Windows CLI 执行。桌面 GUI 交互、其他操作系统及
自然模型行为仍在该探针范围之外。
[运行证据](../../experiments/runtime/codex-plugin-capabilities-2026-11-13.zh-CN.md)

## 考虑过的替代方案

进程级身份无法区分复用连接的多个原生聊天。独立 hook 和 MCP 身份需要额外的跨会话投影协议。
源码绑定安装要求每个接收者维护当前 checkout。原生请求元数据与打包客户端符合已验证的
Codex 接入入口。
