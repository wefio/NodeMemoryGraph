# G. 产品入口：协作与 OoO 证据边界

[English](collaboration-product-entry.md) · [术语](collaboration-product-entry.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.zh-CN.md).

## G. 产品入口：协作与 OoO 证据边界

预期的产品入口是普通 task-board handoff，而非专用 `ooo` tool、channel、第二份 task body 或 `board.runRound` wrapper。此边界由[共享层与 board 设计](../task-unit-semantics/shared-layer-and-task-board.zh-CN.md)拥有。本台账区分产品路径证据与 `BoardAdmission` 研究证据；研究测试通过不能证明产品调用方已经存在。

| 节点 | 义务 | 状态 | 证据与限制 |
| --- | --- | --- | --- |
| G1 | 普通产品 handoff 经共享任务语义、执行与验收到达目标，且不依赖 `ooo_round` | 部分完成 | 普通 Pi 路径使用 `nmg_board`，但 `tests/integration/ooo-ordinary-handoff.test.ts` 构造的是 `BoardAdmission`，证明的是研究工具路径。[产品调用路径审计](product-call-path-audit-2026-09-20.zh-CN.md)未证明产品代码会调用 `dispatchPlan` 或 `task-semantics.ts`。 |
| G2 | 只有依赖已接受后，接受产品任务才能释放其后继任务 | 尚欠 | 产品路径审计显示：有依赖 P 的 managed task J 可以经 `taskRun` 被 claim，而无需先生成或接受 P。`BoardAdmission` 的 `deriveStatus` 测试证明的是研究路径，不是产品依赖准入。 |
| G3 | 产品失败/取消只保留已接受前缀并遵循声明的 fallback 顺序 | 部分完成 | `ooo-ordinary-failure.test.ts` 和有限模型覆盖研究路径。daemon `taskRun` API 会记录 run/task 取消，但其 status 返回原始 facts；产品路径尚未接入研究侧的 dispatch/派生循环。 |
| G4 | 可通过 daemon 接口查询 run 状态并取消 run | 已证明，仅限原始运行记录 | `tests/cli/task-run-surface.test.ts` 经 service 测试 `taskRun`。`taskRunStatus` 返回 manifest、tasks、facts 和 bindings，不派生 ready/blocked/accepted。`ooo-round-query.test.ts` 是另一条研究工具只读路径测试。 |
| G5 | 移除专用 `ooo_round` 产品 tool，并保留普通 board 入口 | 已证明 | extension 注册与测试不再暴露 `ooo_round`；`nmg_board` 仍是 handoff 入口。`evals/ooo-execution` 与 `npm run ooo:round` 是研究界面，不是产品 tool。 |
| G6 | task/run 真相保存在类型化 facts 与 board state 中；模型不能通过 patch 把 `accepted`、lease 或取消状态改成第二份可编辑状态 | 部分完成 | `task_run_*` 表、类型化 `taskRun` 写操作和 managed-write 围栏，使产品 run facts 与 board 生命周期受 Store 所有的转移控制。产品 API 尚无派生的 Task-Unit view；研究侧投影测试不能证明它已接入产品。 |
| G7 | 用第二个 Agent session、取回的证据与固定 parent check 测量真实 continuation | 已在研究路径测量 | [2026-09-14 continuation 实验](../../experiments/execution/ooo-real-continuation-2026-09-14.zh-CN.md)中，5 项任务有 4 项端到端接受；另 1 项 continuation 产生不可解析 patch，parent 没有 verdict。`live-continuation.ts` 使用研究侧 `NmgStoreBase`；这是实验数据，不是产品运行时证明。 |

因此，当前产品边界比研究设计更窄：普通 board 操作与 daemon run records 已存在，但经共享任务语义执行产品依赖调度仍未完成。不得将研究测量改写成已启用通用多 Agent runtime 的主张。
