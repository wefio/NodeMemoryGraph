# 宿主生命周期、运行记录与 daemon 客户端边界

[English](host-lifecycle-run-records-and-daemon-clients.md) · [术语](host-lifecycle-run-records-and-daemon-clients.terms.yaml)

**Authority:** [Parent scope](../lifecycle-and-integration-prerequisites.zh-CN.md).

## 宿主生命周期、运行记录与 daemon 客户端边界

| 节点 | 义务 | 状态 | 证据 |
| --- | --- | --- | --- |
| D7 | run 借用操作 port，不关闭 owner 的 Store | 不适用 | round 专用对象（`OooRoundOperations`、`openRoundStore()`、`CycleOptions.operations` 和构造时安装的 specs）随 round 于 2026-09-18 退役。当前 owner/borrower 契约见[运行记录归属](../../../design/task-unit-semantics/run-record-ownership.zh-CN.md)；另见[退役决策](../../../decisions/implemented/2026-09-18-retire-the-round-instrument.zh-CN.md)。 |
| D8 | 关闭前停止新工作、收束已接收工作，并且只关闭一次 | 已证明 | [`src/cli/service.ts`](../../../../src/cli/service.ts)：有调用在途时 `close()` 会拒绝，`drain()` 必须等待，`inFlight` 统计 daemon 已接收的工作。[`tests/cli/service-drain.test.ts`](../../../../tests/cli/service-drain.test.ts) 保持一个调用在途，并断言 `drain(0)` 失败；[`tests/cli/service.test.ts`](../../../../tests/cli/service.test.ts) 与 [`tests/cli/archive-shutdown.test.ts`](../../../../tests/cli/archive-shutdown.test.ts) 覆盖关闭行为。 |
| D9 | 提交后通知失败应被记录，而不是作为回滚抛出 | 已证明 | `tests/integration/ooo-post-commit-notification.test.ts`：`afterCommit` 抛错后，artifact 仍为已接受且归 board 所有；`lastNotificationFailure()` 返回错误信息。通知回调发生在提交之后，其失败不能撤销已存储结果。 |
| D10 | `runCycle` 的提前取消分支可达，或为死代码 | 不适用 | 该分支和 `runCycle` 于 2026-09-18 随 round 一起删除；此前回归只属历史证据，不是当前 runner 证明（[决策](../../../decisions/implemented/2026-09-18-retire-the-round-instrument.zh-CN.md)）。 |
| D11 | 运行记录属于 Store schema，且类型化写入加入 Store 事务 | 已证明 | `migrate()` 创建 `task_run_manifest`、`task_run_tasks`、`task_run_facts`。`registerTaskRun`、`freezeTaskRunTask`、`appendTaskRunFact` 接受事务 port。`tests/core/store/task-runs.test.ts` 覆盖 board/事实原子写入与回滚、重试幂等与序号、run 隔离、冻结计划拒绝、绑定歧义和无副作用读取；`tests/core/store/schema.test.ts` 检查这些表。注册及退役的 tooth 由[mutation-anchor 决策](../../../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.zh-CN.md)维护。 |
| D12 | 逻辑任务与 board 条目的绑定是运行事实，且由单一规则判定条目是否受管理 | 已证明 | `bindRunEntry()` 记录 `entry-bound`；Store fence 会拒绝在协调转移之外直接改变已采用条目的生命周期。`tests/integration/ooo-managed-adopt.test.ts` 覆盖创建与绑定的原子性、幂等重试、重复/跨 run 拒绝及具名拒绝原因。`coordinatedEntryWrite()` 集中 daemon 路由。`tools/mutation-teeth.ts` 中的 mutants 覆盖绕过 fence、过期绑定、取消与跳过运行事实。 |
| D13 | 其他进程只能通过 daemon `taskRun` 到达运行事实 | 已证明 | `src/cli/protocol.ts` 将 `taskRun` 路由至 `src/integration/task-coordinator.ts` 的 `registerRun`、`freezeRunPlan`、`bindRunEntry`、`cancelRun`、`taskRunStatus`、`createBoundEntry`。`tests/cli/task-run-surface.test.ts` 经 service wire 验证这些路径及 `hello.methods` 广告。冻结顺序取请求数组顺序；悬空/自依赖与已取消 run 的写入会被拒绝；采用操作在同一转移中创建并绑定。`status` 只读，CLI 提供 `nmg run status` 与 `nmg run cancel`。 |
| D14 | 证据驱动经 daemon 客户端访问研究 board，不自行打开数据库 | 已证明 | `round-client.ts` 按 store 的 daemon lease 定位 host；无 host 时具名拒绝。`round-host.ts` 服务已有研究 store。`board-worker.ts`、`board-deliver.ts`、`board-judge.ts` 使用协议 board verbs，不自行打开 Store。`tests/integration/ooo-evidence-drivers.test.ts` 以独立进程运行客户端，并检查 `entry-bound → board-claim → board-deliver → board-judge` 记录、无 daemon 拒绝以及不回退到直接打开 Store。调用有界，客户端拒绝连接自己服务的 PID；测试也覆盖 lease 释放。 |

D14 不覆盖研究 runner：`plan-driver.ts` 用研究数据库路径构造 `BoardAdmission`，`live-continuation.ts` 则直接打开自己的 `NmgStoreBase`。两者都未使用 daemon `taskRun`；这是独立接入缺口，不是上述证据驱动边界失效。
