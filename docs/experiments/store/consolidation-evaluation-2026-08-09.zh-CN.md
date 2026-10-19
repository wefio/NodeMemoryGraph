# STG → LTG consolidation gate 评测 — 2026-08-09

[English](consolidation-evaluation-2026-08-09.md) | [简体中文](consolidation-evaluation-2026-08-09.zh-CN.md) · [术语](consolidation-evaluation-2026-08-09.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史记录，其配置、测量结果和实现状态不是当前测试回执，也不授权默认策略。本轮未重跑实验，未独立复核原始运行产物。

这是一次策略覆盖与可逆性审计，不是「自动 consolidation 已可默认启用」的结论。

## 协议

- 数据集：官方 LoCoMo `locomo10.json`。
- 单元：一段对话内的一个 evidence source ID。
- 结果单元：引用该 source ID 的不同官方 QA 任务。本工具把任务 ID 区分开，不表示来自同一对话的这些确认在统计上相互独立。
- 标签：只用官方 evidence ID；没有模型生成的判断。
- 先验：零标注写入路径（`confidence = 0.5`，prior strength 为 2）。
- 策略：当前默认的 STG consolidation 与 retention 阈值。
- 命令：`npm run eval:consolidation`。

## 结果

- 10 段对话中共 1,986 个 QA 任务。
- 1,434 个唯一官方 evidence 条目。
- 355 个 evidence 条目出现在至少三个独立任务中。
- 组合均值 gate 与保守下限 gate 要求从零标注先验得到五个全正结果；75 个 evidence 条目达标。
- candidate 覆盖率为全部官方 evidence 的 5.23%，为达到名义三任务重现下限的 evidence 的 21.13%。
- 在 retention hysteresis（`mean >= 0.65`，保守下限 `>= 0.35`）下，75 个 candidate 中有 46 个在两次后续矛盾后撤回，20 个在三次后撤回，9 个在四次后撤回。没有任何一个在单次矛盾后振荡出局。

## 工程结论

默认 gate 是保守的，较低的 retention 阈值提供了真实可逆的生命周期，而没有单事件 promote／demote 振荡。NMG 现在只在支撑低于 retention gate 时，撤回携带精确 `consolidated_from_stg.sourceMemoryId` 标记的 active LTG 行。既有或手工写入的 LTG 重复项没有该标记，永远不会被 STG 反馈撤回。后续重新取得资格时，会创建新的可审计 LTG 版本。

这个 benchmark 无法估计 false-promotion precision：某条记忆没有出现在某个 QA 的 evidence 列表中，既不构成反驳，也不是权威的负向 promotion 标签；它可能只是未用于该问题。因此在自然纠正或另一个权威负标签来源能够测量 false-promotion 成本之前，自动 actuation 仍默认关闭。

LongMemEval 的 `knowledge-update` 案例澄清的是另一条不变量，而不是解决缺失的 precision 标签。例如一个官方案例把 charity-5K 的个人最好成绩从 `27:12` 改为 `25:50`。新的同 scope state 必须立即替换旧的 current 投影；它不能等待 consolidation hysteresis 所要求的两次或更多后续矛盾。NMG 现在在投影时协调物理上分离的 STG/LTG state 版本，只保留最新版本，而 as-of search 仍返回较旧版本。这弥补了陈旧 current state 的暴露面，但没有把 LongMemEval 变成 false-promotion precision benchmark。

HaluMem 是通过 OmniMemEval 已经存在的最相关权威来源：它发布操作级 memory point，并包含干扰与动态更新。所引后续报告描述了 operation adapter 与 official-judge wrapper。其中 user 1、session 6 的自然 slice 达到了 full expected-memory recall，但 all-candidate weighted accuracy 只有 0.683，拒绝了 0/1 条干扰记录，并正确更新了 3/4 个目标。因此较高的 official extraction F1（0.933）并不意味着写入集合是干净的。

该结果评估的是 benchmark bridge 的 raw-message ingress，它把 assistant 对话存为未经验证的 `conversation_evidence`；它并不标注 Pi `remember` 边界或后验 STG-to-LTG promotion gate 实际产生的 candidate。它补上了缺失的操作级 harness 并展示了一个权威的污染失败，但在真实 promotion candidate 被评分、且 false-promotion 成本与撤回被测量之前，无人值守 consolidation 仍然关闭。完整 protocol 与结果见 [HaluMem 操作报告](../benchmarks/halumem-operation-evaluation-2026-08-11.zh-CN.md)。该后续报告标为 2026-08-11；本记录的文件名不表示后来纳入的全部内容都发生于 2026-08-09。
