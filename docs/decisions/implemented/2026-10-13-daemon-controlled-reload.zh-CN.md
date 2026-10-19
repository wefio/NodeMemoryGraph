# 受控 daemon 代码重载

[English](2026-10-13-daemon-controlled-reload.md) · [术语](2026-10-13-daemon-controlled-reload.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [统一状态入口](2026-10-12-state-space-entry.zh-CN.md)

## Problem

宿主扩展的 reload 不替换驻留 daemon 已加载的代码。未协调的 stop/start 会让其他
客户端争抢新进程，也无法证明在途工作完成；丢失响应后重放写入可能重复执行。

## Decision

用户接受显式进程换代，允许清空临时 AG 与 writer 租约。`nmg daemon reload`
获取独占交接门禁，要求旧 owner 发布 `controlled-reload` 能力，等待已接受调用完成、
旧进程退出，再让持票子进程获取 daemon 租约。成功以新进程通过认证的就绪握手为准。

客户端等待交接、刷新端点和能力，不把控制器启动的新进程认作自己的资源。
请求发出后的连接失败只自动重试读取；写入结果不确定时明确报错，不自动重放。
旧管理 restart 与此路径分别保留。

规范边界、恢复条件与验证由
[daemon 生命周期](../../design/daemon-lifecycle-design/controlled-code-reload.zh-CN.md#controlled-code-reload-1)拥有。

## Alternatives considered

- 给 restart 换个 reload 名称：不采用，没有 drain 与交接 fencing。
- 进程内热加载或迁移 AG/租约：本切片不采用，允许清空临时状态的边界避免旧代码、
  旧权限与部分迁移的服务共存。
- 缺能力时自动替换旧 daemon：不采用，共享 owner 不是客户端的可丢弃资源。
- 自动删除损坏或无人持有的交接门禁：不采用，缺少可信 owner 身份不等于可以抢建第二 owner。

## Consequences

命令加载当前已构建的入口，保留 SQLite 持久数据；不自动 build、不保留内存会话，
也不承诺零停顿。交接和就绪有明确期限，失败不记作成功。drain 失败会重新开放旧服务；
新进程失败不被伪称健康，也不自动回滚旧二进制。

不支持 controlled reload 的旧 daemon 首次升级仍需要安全的协调窗口。
隔离的单元、HTTP 和真实进程测试不会停止共享生产 daemon。

## Deferred

- 迁移 AG、writer 租约和其他进程内状态。
- 进程内模块热加载、自动监测代码变化、与不支持门禁的旧启动二进制交接。
- 控制器被杀后自动恢复无人持有的交接门禁。
