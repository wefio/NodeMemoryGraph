# 剩余义务与待决问题

[English](remaining-obligations.md) · [术语](remaining-obligations.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.zh-CN.md).

## 剩余义务与待决问题

Store 所有的 run-record 路径已实现；研究 runner 尚未接入。不要把两者合并成一个完成结论。

## 当前产品边界

daemon 拥有产品 run manifest、task rows、facts 与 bindings。`taskRunStatus` 返回这些记录，不派生 `ready`、`blocked` 或 `accepted`。`task-coordinator.ts` 为受管理的 board 转移加围栏，并在同一事务中记录对应运行事实。daemon 普通 board verbs 会将受管理条目路由到该 coordinator；未绑定 handoff 仍走原有路径。

产品调用路径审计没有找到 `dispatchPlan` 或 `task-semantics.ts` 的调用方；它还表明，即使依赖任务尚未先被接受，依赖它的任务也可以通过 `taskRun` 被 claim。因此 G2 仍尚欠，产品侧共享语义/dispatch 路径尚未完成。

研究路径仍相互独立：`evals/ooo-execution/plan-driver.ts` 用其研究 `databasePath` 构造 `BoardAdmission`，`live-continuation.ts` 则打开 `NmgStoreBase`。证据驱动 `board-worker.ts`、`board-deliver.ts`、`board-judge.ts` 使用 `round-client`，经 `round-host` 调用 board verbs；这个 daemon-client 边界并不意味着 `plan-driver` 或 `live-continuation` 是产品 `taskRun` 客户端。因此 B6 剩余工作是 runner 接入，不是再加一层 Store guard 或第二个公开写入 verb。

## 未完成的设计义务

- **产品任务语义：** 决定并实现普通产品 handoff 是否应调用共享任务编译器/dispatcher，然后使依赖接受、失败、取消与有序 fallback 都遵循该路径。在此之前，G1 与 G3 只有部分覆盖，G2 尚欠。
- **产品任务视图：** 当前产品 API 暴露原始 run/task/fact/binding 记录，而不是派生的 `TaskUnit` view。继续将 Task IR 保持为拟议的只读内部视图；不要增加第二份持久化或可由模型编辑的 task 真相。run-record 与 managed-write 边界对 G6 提供部分覆盖。
- **研究 runner 采用 daemon：** 若要把研究 runner 迁至 daemon，必须使用现有 `taskRun` 与 managed-board 操作。该接入完成并通过测试前，研究证据仍应标记为 research-only。
- **可选 HA/MGR：** adviser port 与九项离线 seam 证明没有接入 HA 或 MGR 实现、改变 gate 或启用开关。任何此类连接都需要单独拥有的设计与证据。

## 已完成的边界工作与历史证据

D11–D13 建立了 Store 所有的运行记录、协调写入、受管理条目绑定及 daemon `taskRun` surface。D14 建立了证据驱动的 daemon-client 路径，不包括研究 plan/continuation runner。行级范围见[产品入口台账](collaboration-product-entry.zh-CN.md)。

旧 round 工具于 2026-09-18 退役。D7 与 D10 对已删除的对象不适用；[历史 D7 转换发现](d7-findings.zh-CN.md)不能验证当前产品路径。此分支没有 board/`taskRun` JSONL 导出，因此 B7 没有失败情形可测。

F arms 的测量阶段已结束；有界结果与限制见[实验 arm 台账](experiment-arms.zh-CN.md)、[pilot](../../experiments/execution/ooo-arms-pilot-2026-09-18.zh-CN.md)及其[归档](../../experiments/execution/archive/ooo-arms-2026-09-19/README.zh-CN.md)。F3 仅具方向性；D arm 结果不能证明普遍的 fusion 节省；付费 E arm 对已测形状没有实际收益。上述实验不证明通用多 Agent runtime 或质量提升。
