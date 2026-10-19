# store 拥有 transaction 边界，port 是工作加入它的方式 — 2026-09-13

[English](ooo-transaction-port-2026-09-13.md) | [简体中文](ooo-transaction-port-2026-09-13.zh-CN.md) · [术语](ooo-transaction-port-2026-09-13.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是带日期的研究或 fixture 记录。表名、源码位置、状态表述、测试计数和未完成标签属于当时快照，不证明当前 daemon `taskRun` 集成。本轮未重跑所列套件或 mutation，也未确认当前检出可用全部历史／本地重放命令。产品边界由当前 [task-unit 契约](../../design/task-unit-semantics.zh-CN.md)负责。

设计中的「事务参与与连接生命周期」契约（docs/design/task-unit-semantics.md）要求：一个连接不等于一个事务；store 是唯一执行 BEGIN/COMMIT 的地方；已经处于某个 transition 内部的调用方，要通过为该 transition 签发的能力加入它。本切片实现该原语，并手工迁移契约指名的那一处边界（`putTaskBoardEntry`），把各类拒绝都写成测试。

## 变更内容

- `NmgStoreBase.writeTransaction(callback)` 为已迁移的 board 写入路径提供共享边界；本切片中，界限章节所列四个方法仍使用独立边界。它拒绝在一个事务仍活着时开第二个事务，拒绝在被隔离的 connection 上运行，并拒绝返回 thenable 的 callback——port 不得在一次 await 之后继续存活。
- `withPort(port, work)` 加入正在运行的 transition。有效性以身份对照 store 自己尚未关闭的事务来判定，因此来自另一个 store 的 port、callback 已经返回的 port，以及从未签发过的 port 都会被按名称拒绝。任何权威都不从标志位或深度计数器推断。
- `withPort` 内部发生失败时，即使调用方捕获了它，该事务也会被标记为 rollback-only：失败之前的工作已经发生，只有最外层才能决定是否有东西提交。
- 失败的 ROLLBACK 保留原始错误并隔离该 connection，因为它的状态已不可知。
- `putTaskBoardEntry(input, port?)` 现在是 `insertTaskBoardEntry` 之上的薄入口：独立调用时它打开边界，被组合时它加入调用方的边界，而在 transition 内不带 port 到达时它被拒绝而不是嵌套。它自己的 BEGIN 与 catch/ROLLBACK 已被移除，因此两条路径只有一份实现。

## 证据（可复跑）

- `npm test` — **1463 passed, 0 failed**（本切片之前为 1455）。
- `tests/core/store-transaction-port.test.ts` — **8/8**：返回已提交的值；在 transition 内没有 port 的写入被拒绝且不留下任何东西；一个 transition 不能再开一个；另一个 store 的 port 被拒绝；callback 返回后仍在使用的 port 被拒绝；返回 thenable 的 callback 被拒绝；被吞掉的失败仍然禁止提交；失败的 rollback 会隔离该 connection。
- `node --experimental-strip-types --test "evals/ooo-execution/*.test.ts"` — 88 passed, 0 failed。
- `npm run mutation:teeth` — **25 个 mutant 中 25 个按名称被捕获，覆盖 6 个 target，6/6 逐字节还原，0 个不适用**（此处新增两个：嵌套写入事务变得被允许，以及被吞掉的失败仍然提交）。
- `npm run check`、`npm run docs:check`、`npm run complexity:gate` — clean。

原来的源码审阅描述了外层 commit 之后发布，以及取消 round 的清理泄漏：`runCycle` 在 src/integration/ooo-cycle.ts:814 的 `gate.close()` 之后返回，早于第 1037 行删除默认目录的 `finally`。通过的套件本身不能证明每条调用路径的时序。此处未提供这些行号所属源码版本，因此这是有归因的历史发现，不是对当前泄漏的独立验证。

记录中的推进顺序是[任务表拆分](ooo-task-tables-2026-09-13.zh-CN.md)、本 port 切片、[round transition](ooo-round-transition-2026-09-13.zh-CN.md)，再到[单边界](ooo-single-boundary-2026-09-13.zh-CN.md)。变化的套件计数属于不同快照，不是对完全相同输入的重复测量。

## 本变更不做的事

- **round 仍运行自己的事务。** `BoardAdmission.transaction()` 未改动，尚未把 port 串入其被组合的 board 写入（deliver、judge、resolve、retention）。契约要求两条边界都改，而做到这点意味着 transition 内部的每一处组合写入都要显式接收 port。
- **仍有四个 store 方法自己开事务**（`removeMemoryFromChain`、`upsertExternalNodeEmbeddings`、`upsertExternalLeafEmbeddings`、`upsertExternalEmbeddings`）。它们在 board 路径之外，但「store 是唯一的 BEGIN 所有者」仍不字面成立。
- **lifecycle 这一半尚未开始**：没有不带 `close()` 的 operations port，没有供 `status` 使用的借用视图，没有 daemon 关闭顺序（停止新工作、fence 在途 attempt、drain、checkpoint、close），而上面那个取消 round 的目录泄漏仍在。
