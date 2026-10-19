# Controlled code reload

[English](controlled-code-reload.md) · [术语](controlled-code-reload.terms.yaml)

**Authority:** [Parent scope](../daemon-lifecycle-design.zh-CN.md#controlled-code-reload).

## Controlled code reload

`nmg daemon reload [--db FILE | --data-dir DIR] [--json]` 是显式管理操作，不是
代码监听器、进程内模块热加载或旧 restart 的别名。它加载当前已构建的 CLI 入口，
不自动 build。用户接受清空 AG、writer 租约与其他进程内状态；持久记忆和黑板保留。

1. 控制器独占 `<db>.reload.json` 交接门禁。原 `<db>.server.json` 仍拥有 daemon
   端点身份；交接文件不是第二 daemon 描述符或状态库。
2. 旧 owner 必须经认证握手发布 `controlled-reload`。缺少能力时拒绝，不发送关闭请求；
   首次升级需要由 owner 协调安全窗口。
3. 受控 `shutdown(reload=true, ticket)` 验证当前交接票据，再关闭领域请求准入并等待
   已接受调用完成。drain 超时重新开放旧服务，控制器不启动替代进程，也不强杀。
4. 旧进程确实退出后，控制器启动持票子进程；只有该票据可在门禁期间获取 daemon
   租约。成功要求对应子进程的端点及认证 hello 就绪，不接受其他进程代答。
5. 客户端在连接、调用和 CLI 本地降级前等待交接；端点变化刷新能力缓存与 ownership，
   不把控制器的替代进程归为模型客户端所有。任何换代后的旧 AG binding 仍须被 owner 拒绝。

读取可在连接级失败后重连一次；已发出的变更操作遇到结果不确定的连接失败，
只刷新连接并明确报告未重放，不能以自动 retry 重复发布、认领或写入。
协议/领域拒绝不会触发自动升级。参与交接的客户端及启动二进制必须支持门禁；
不能把当前机制宣称为任意旧版本的热迁移。

drain 为 5 秒，旧 owner 退出为 5 秒，新进程端点就绪为 10 秒；
hello 为 5 秒，客户端门禁等待为 30 秒。超时不记作成功，不回退为强杀或旧 CLI。
正常失败释放自己的门禁；控制器被杀、门禁损坏或 owner 身份不可靠时 fail closed，
保留文件并报告需要 operator recovery，不自动删门禁抢启。恢复前须确认旧 owner、
控制器及候选子进程均已退出或明确选定唯一 owner。

[接口决定](../../decisions/implemented/2026-10-13-daemon-controlled-reload.zh-CN.md)
记录本切片与进程内热加载的区别。单元/HTTP 与隔离真实进程测试覆盖 drain 拒绝后恢复、
真实 CLI 换代、记忆和黑板保留、临时状态清空、旧 binding 拒绝、争抢与孤儿门禁、
旧 daemon 不被隐式升级、结果不确定的写入不重放。它们不证明共享生产 daemon 已部署。
