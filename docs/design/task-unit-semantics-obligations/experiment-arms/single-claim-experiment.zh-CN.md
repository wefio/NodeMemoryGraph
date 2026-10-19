# 历史 F2b 探针：一次只能有一个 claim

[English](single-claim-experiment.md) · [术语](single-claim-experiment.terms.yaml)

**Authority:** [Parent scope](../experiment-arms.zh-CN.md).

## 历史 F2b 探针：一次只能有一个 claim

本文记录 slot budget 决策前的首个 F2b driver 探针。其单 claim 结果不是当前契约：F2b-slot 后来增加了声明式并发预算。当前策略见[槽预算决策](../../../decisions/implemented/2026-09-18-declared-slot-budget.zh-CN.md)与父文档的 [F2b-slot 行](../experiment-arms.zh-CN.md)。

原探针尝试在 **N 个槽**中运行细粒度计划。对 `slots: 4` 且前三个任务相互独立的计划，`plan-driver.ts` 报告 `slotsUsed: 1`，并给出 `slotRefusal: "wanted 4 slots, the board allowed one: no published handoff for this task"`。当时有三个约束导致该结果：

1. 只要任一未接受任务处于 claim 状态，`selectableTasks` 就返回 `[]`。
2. `publishReady` 只为被选任务提供 handoff；`claimableRow` 会拒绝既不是 `next()`、也没有 handoff 的任务。
3. board 按 channel 串行化可执行条目；第二个未定向 handoff 不能绕过该边界。

直接探针显示了状态变化：无人持有 claim 时，`candidates()` 返回 `["first","second"]`；认领 `first` 后返回 `[]`，且 `claim("second")` 因 `no published handoff for this task` 失败；接受 `first` 后，`second` 才可认领。顺序执行仍能完成四个单元、四项 host 检查和 parent check。

两种替代方案都不能隔离设计的 C arm——它只改变槽数和合法顺序。同一 Store 上并发多个 run 可以同时持有两个 claim，但也改变了 channel、plan 和串行规则。不经 claim 直接生成任务则违反契约：原子 claim/fence 才授予执行权。

2026-09-18 决策选择了声明式槽预算。Store 的按 channel 串行规则保留；预算大于一时，通过定向 handoff 使每个可启动任务都可被认领。若请求槽数未达到，`comparePlanSlots` 会拒绝给出耗时结论（`slotShortfalls` 与 `comparable: false`）。因此，原始探针促成了预算方案，却不描述当前 `publishReady` 行为。

离线模型预测：一个槽没有收益；chain 或双单元细化在每种粒度下都更差；若 B arm 节省成本，则与 sweep 矛盾。该模型没有质量项，也不固定模型、预算或重复次数。付费 pilot 的证据与限制见[试验记录](../../../experiments/execution/ooo-arms-pilot-2026-09-18.zh-CN.md)；不得声称超出该记录的收益。
