# Store 所有权、操作 port 与借用只读视图

[English](store-ownership-operation-ports-and-borrowed-views.md) · [术语](store-ownership-operation-ports-and-borrowed-views.terms.yaml)

**Authority:** [Parent scope](../lifecycle-and-integration-prerequisites.zh-CN.md).

## Store 所有权、操作 port 与借用只读视图

| 节点 | 义务 | 状态 | 证据 |
| --- | --- | --- | --- |
| D1 | 只有 owner 能打开、迁移、checkpoint 与关闭 Store | 已证明 | 产品客户端通过 daemon 操作而非直接使用其 Store（D13/D14）；Store owner 收束已接收调用并关闭（D8）；离线只读句柄由打开它的宿主拥有（D6）。借用 port 不暴露 close（D2）。D7 的 round 专用证明已退役；研究 runner 仍是各自 Store 的 owner（D14）。 |
| D2 | port 不暴露原始连接、SQL、事务控制或 `close()` | 已证明 | `src/integration/ooo-board.ts` 中的 `RoundQueryPort` 与 `TransactionPort`；`tests/integration/ooo-round-query.test.ts`。 |
| D3 | 已有转移开启时，无 port 的写操作会被拒绝 | 已证明 | `tests/core/store-transaction-port.test.ts`；用例 `a write entry reached inside a transition without a port is refused, not nested` 明确断言拒绝，并检查没有残留写入。tooth `nested-write-transaction-is-allowed` 于 2026-09-24 退役。 |
| D4 | status 的借用视图不迁移、不发布、不初始化 | 已证明 | `tests/integration/ooo-round-query.test.ts`；mutant `the-status-read-path-opens-the-rounds-store`（变异让读取路径打开 round 的写库，测试能捕获）。 |
| D5 | 两条读取路径基于相同事实与求值时间时结果一致 | 已证明 | `tests/integration/ooo-read-paths-agree.test.ts`。该比较不再是空测试：用例先通过 round 自己的 host-verified 路径接受任务，然后要求两条路径报告相同接受结果及相同 artifact bytes。Mutant `the-offline-reader-decides-acceptance-on-its-own` 让借用 port 按自己的规则返回 `{}`，会被捕获。 |
| D6 | 只读打开由句柄权限保护，而不是依赖 `query_only` | 已证明 | `tests/core/store-readonly-open.test.ts`；用例 `a read-only open neither creates, migrates nor writes` 断言拒绝、缺失文件未被创建、Store hash 未变。tooth `the-read-only-factory-opens-a-writable-handle` 于 2026-09-24 退役。 |
