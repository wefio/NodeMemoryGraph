# A. 离线语义

[English](offline-semantics.md) · [术语](offline-semantics.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.zh-CN.md).

## A. 离线语义

| 节点 | 义务 | 状态 | 证据 |
| --- | --- | --- | --- |
| A1 | 编译器返回合法计划，或明确拒绝并指出任务、字段与义务 | 已证明 | `tests/integration/task-semantics.test.ts` |
| A2 | 离线模型可完成派发，但不发布或持久化运行状态 | 已证明 | `tests/integration/task-semantics-model.test.ts` |
| A3 | 设计中的六个区分性用例均可执行 | 已证明 | `tests/integration/task-semantics-cases.test.ts` |
| A4 | 字段映射能发现预算单位混淆、requires/deps 混淆及被静默丢弃的键 | 已证明 | mutants `budget-inner-alias-is-dropped`、`over-maximum-budget-is-accepted`、`assumption-may-carry-a-dependency` |
| A5 | 对至多四个单元的每种合法事件交错顺序都进行枚举，并检查每个前缀上的发布义务、输入与来源 | 已证明 | `tests/integration/ooo-publication-invariants.test.ts`（18 个用例），基于 `src/integration/task-semantics-interleavings.ts`。枚举将每个单元的事件脚本合并，最多四个单元、六个事件；检查读取派生视图而不是第二套模型：派发依赖已结束且已接受的输入；完成（接受集合以同一谓词封闭）要求 verdict 绑定对应字节、字节存在、未取消，且输入存在并已接受。两类检查均有独立 mutant，且由点名规则的用例捕获：`the-completion-does-not-bind-the-verdict-to-the-bytes`、`the-input-is-not-required-to-be-accepted`、`the-input-may-be-cancelled`、`the-completion-ignores-a-cancelled-unit`、`the-dispatch-does-not-require-a-closed-input`。记录的干净运行中，设计列出的脚本集合没有报告问题。枚举完整性由数量断言证明：用例 `the merge enumerates every legal order, not one of them` 检查多项式系数计数，返回单一顺序的合并器会失败；相应 tooth `the-merge-enumerates-one-order` 在 2026-09-24 规则明确后退役（[决策](../../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.md)）。模块也保留了设计的证据边界：通过只证明这个有限模型满足所列性质，不证明任意 Agent 程序正确。 |
| A6 | 发布顺序是冻结计划的稳定拓扑顺序；模型的 `ordered` 模式采用该顺序，而不是任意拓扑排序 | 已证明 | 设计原句：“最初使用冻结计划的稳定拓扑顺序作为发布顺序；生成和验证可以越序”。`tests/integration/task-semantics-model.test.ts` 中的 `the ordered mode is the declared plan order and nothing else` 精确断言：只有一个有序计划、顺序等于声明计划、模式只报告一个顺序；基线不获得顺序自由，而越序模式有两个顺序。因此，若模式返回任意拓扑顺序，数量断言会失败。该规则由 tooth `ordered-mode-becomes-any-topological-order` 覆盖；用例写明规则后，它于 2026-09-24 退役（[决策](../../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.md)）。 |
