# 事务参与与连接生命周期

[English](transactions-and-connections.md) · [术语](transactions-and-connections.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../run-record-ownership.zh-CN.md).

### 事务参与与连接生命周期

同一个连接不等于已经处于同一个事务。Store 拥有边界；运行协调器加入某一次同步状态转移，不能把整个 run 或异步 RPC 包进数据库事务。以下契约建立在现有的 `writeTransaction`、`withPort`、`TransactionPort` 与 `coordinateRunWrite` 上；`BoardAdmission` 和 managed `taskRun` 写入已有加入事务的路径，但不表示每个研究 runner 都接入了 daemon namespace。

| 能力 | 持有者 | 责任 |
| --- | --- | --- |
| 连接创建、schema migration、checkpoint、close | daemon 的 Store owner；离线 fixture 则由创建它的外层宿主拥有 | 启动时完成初始化；关闭前停止并收束所有使用者；创建者负责异常清理 |
| 同步写事务入口 | Store | 唯一执行 `BEGIN IMMEDIATE/COMMIT/ROLLBACK`；无外层事务时建立事务，已有事务时须显式提供有效事务作用域 |
| 已有事务的操作端口 | 共享协调器与 board 内部操作 | 只调用绑定当前 Store 的类型化操作；不暴露原始连接、SQL 事务控制或 `close()` |
| 运行执行作用域 | 共享协调器 | 管理本次 worker/check、订阅和计时器；释放这些资源不关闭借用的 Store，也不删除非本次所有的目录 |

事务端口是 Store 签发、仅在同步回调期间有效的能力，绑定连接与当前事务代次。其他 Store 的端口、退出回调后的端口，以及未提供端口却在已有事务内再次进入的写事务调用，都明确拒绝。不能仅凭 `isTransaction` 或全局深度猜测调用方是否有权加入。

board 的独立写入口和组合写入口复用同一实现：独立调用由 Store 包装事务，运行内调用显式使用当前事务端口，不再执行第二次 BEGIN。一次转移涉及的 put、claim、deliver、judge、resolve、保留关系和运行事实写入都须遵循此规则；清理、串行晋升等伴随写入也在同一边界内，或明确由独立维护事务承担。Store 已有的事务端口不等于每个 board operation 都已接入；未来接线不能遗漏独立入口自带的边界。

初版采用整笔原子事务，不增加 savepoint 级局部恢复。内层操作抛错时将当前事务标记为 rollback-only；即使调用方捕获异常，最外层也不得 COMMIT。预期的 stale/conflict 应在该操作首次写入前返回，或作为失败使整笔回滚；不得先写一部分，再用普通返回值掩盖失败。事务是否已提交只由最外层决定。ROLLBACK 自身失败时保留原错误并隔离该连接，不能假定连接仍可继续使用。

回调必须同步且不接受 Promise/thenable；类型约束之外，端口在回调结束即撤销，防止延迟回调继续写入。外部验证、模型调用和通知都不得持有端口跨越 `await`。提交路径保持：读取并冻结验证输入 → 事务外验证 → 新的短事务内重读 fence/lease/cancel 并原子写入。不能通过“复用事务”取消验证后的复核。

共享运行时只在事务成功后返回已提交结果并发送通知。必须可靠送达的通知先把待发送事实写进同一事务，再在事务外发送；瞬时通知失败不改写已提交事实。当前 `BoardAdmission` 以已提交 artifact 行作为 `publishReady()` 的可重建通知来源，并在重启/重试时重发；调用方未收到响应时按同一身份查询或重试，不重跑 worker。`afterCommit` 只具提交后观察语义，其异常不能说明数据库已回滚。

生命周期采用外层拥有、内层借用的单一路径：daemon 创建 Store，构造不含 close 的操作端口传入 run；离线宿主也先创建自己的 Store，再调用相同 run 入口，并由外层 finally 关闭。run 内不使用 `ownsStore` 分支分散关闭逻辑。正常返回、初始化失败、提前取消、检查抛错都经过各资源 owner 的统一清理；资源每成功创建一步就纳入清理范围。status 的借用视图构造不迁移 schema、不发布 handoff、不因查询触发 run 初始化写入。

daemon 关闭顺序为：停止接收新工作，取消/围栏在途尝试，撤销订阅并等待使用 Store 的异步任务退出，完成已开始的同步事务，最后 checkpoint/close 一次。无法及时终止的外部进程不得保留数据库操作能力；迟到结果由已关闭的运行作用域拒绝。现有 service 的 drain/close 只证明 daemon 请求的生命周期边界，不等于外部 worker 已被取消或围栏。该顺序须由 daemon owner 与执行 host 协同，不能只保证借用者不 close，却让后台使用者在关库后写入。
