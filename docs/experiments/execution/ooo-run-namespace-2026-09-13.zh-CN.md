# 按 run 划分的 round 存储 — 2026-09-13

[English](ooo-run-namespace-2026-09-13.md) | [简体中文](ooo-run-namespace-2026-09-13.zh-CN.md) · [术语](ooo-run-namespace-2026-09-13.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是带日期的研究或 fixture 记录。表名、源码位置、状态表述、测试计数和未完成标签属于当时快照，不证明当前 daemon `taskRun` 集成。本轮未重跑所列套件或 mutation，也未确认当前检出可用全部历史／本地重放命令。产品边界由当前 [task-unit 契约](../../design/task-unit-semantics.zh-CN.md)负责。

设计的迁移第 2 步（`docs/design/task-unit-semantics.md`，「persistence」）：一个 round 的存储按 run 划分命名空间，因此一个 store 可以容纳多个 round，而每一处曾经是 singleton 的地方都以 `(run_id, …)` 为 key。

## 本变更不做的事

- **表仍是一张表。** `ooo_probe_tasks` 把不可变 manifest、candidate 字节与派生状态放在同一行里；拆分它是下一步（B2），不是这一步。
- **round 仍然自己持有 SQLite 文件。** store 由 round 打开，而不是由 daemon 注入（B3）。命名空间化使_后续_的注入成为更换所有者，而不是重写每一条语句——这正是这个顺序的理由。
- **`checkId` 有意不按 run 划分。** 它是 round 日志记录的身份，而一次 replay 在新的 `runId` 下运行并复现相同的 attempt；store 中的唯一性由 `(run_id, task_id)` key 保证。先给它加 run 作用域_破坏了_ replay（`replay asks for exactly the recorded attempts: 2 !== 3`），约束正是这样被发现的，而不是被假定的。
- **acceptance 不会从迁移后 store 的旧列恢复。** 命名空间化之前的 store 记录的是 round 自己的 verdict；那正是 board 的独立 verdict 所取代的自我报告。迁移保留 artifact 并让它保持未接受——可见，而不是被静默接受。

## 变更内容

- `BoardAdmissionOptions { runId? }`；`ooo_probe_runs (run_id PK, policy, cancel_reason, cancelled_at, created_at)` 取代 `ooo_probe_meta (id PK CHECK(id=1))`；`ooo_probe_tasks` 与 `ooo_probe_checks` 获得 `run_id` 及复合主键；board 频道变为 `ooo-probe:<runId>`，而不是常量 `ooo-process-probe`。
- 采用规则：具名 run 会打开它；只有一个 run 的 store 被继续（因此既有行为不变）；有多个 run 的 store **拒绝**并要求具名，因为「采用最新的」与「另起一个」都是对某人证据的静默回答。
- `migrateToRunScope()` 在一个事务内重建旧表（rename → create → copy → drop），若存在没有 `meta` 行的旧数据则抛错而不是猜测。被拒绝的 store 会关闭其 handle：在 Windows 上调用方被告知改开另一个 database，而一个打开的 handle 会把那个文件锁住（由测试的清理发现，随后修复）。
- 约 37 处 SQL 现在都带上 `run_id`；两条 prune 路径与 retention 均按 run 划分。

## 证据

`npm test` — **1452 passed, 0 failed**（产品测试，含 4 个新测试）。
`tests/integration/ooo-run-namespace.test.ts` — **4/4**：一个 store 中的两个 run 互不冲突、互不可见对方的行，并可分别取消；多 run 的 store 拒绝猜测；单 run 的 store 仍被继续；命名空间化之前的 store 被原地迁移，保留其 run、行与终局决定（迁移后的 round 随后_执行_该决定，拒绝一次 claim）。
`npm run mutation:teeth` — **22 个 mutant 中 22 个按名称被捕获，覆盖 6 个 target，6/6 逐字节还原，0 个不适用。**

这次练习发现而不是假定了两件事：

1. `claim-is-not-scoped-to-its-run` 这个 tooth **未被**第一版测试捕获：`next()` 与 `accepted()` 都不会观察到相邻 run 的行。真正能捕获它的是在本 run claim 同一 task id 之后，对该另一 run 的 `owner` 做一次原始行读取。一个能运行且通过的 tooth，正是「描述变更的测试」与「钉住变更的测试」之间的差别。
2. 给 `checkId` 加 run 作用域看起来是「每个 run 一行」的显然收尾，却是错的：replay 是一个_不同的_ run 在复现_同样的_ attempt，round 测试套件也这么说了。

Run 级终局元数据不同于 artifact acceptance：保留终局 run 决定不等于恢复旧的自报接受列。这些命令名标识历史检查入口；仅有命令清单或提交信息都不能证明运行成功。重现所记计数需要原始源码版本及回执，而不是只看当前命令是否可用。
