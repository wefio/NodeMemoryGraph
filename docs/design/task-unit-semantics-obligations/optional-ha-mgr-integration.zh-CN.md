# E. 可选 HA/MGR 接入

[English](optional-ha-mgr-integration.md) · [术语](optional-ha-mgr-integration.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.zh-CN.md).

## E. 可选 HA/MGR 接入

[任务顾问设计](../task-unit-semantics/autodiff-ha-mgr-integration.zh-CN.md)拥有复用方向与接线顺序。本台账只证明离线 seam：`src/integration/task-advisers.ts` 向可选来源提供有界 `AdviceProjection` 与共享 `selectableTasks` 合法集合；来源可在集合内排序，但不能改变合法性。`BoardAdmission` 的 `advisers` 可选，默认不提供任何来源。没有 HA 或 MGR 实现接入，没有 gate 改动，也没有新增开关。

| 节点 | 义务 | 状态 | 证据 |
| --- | --- | --- | --- |
| E1 | 即使集合外动作得分最高，也必须拒绝 | 已证明 | `tests/integration/ooo-advisers.test.ts`：`a suggestion outside the legal set is refused, however high it scores`；`1e9` 分数只改变集合内排序。Mutant `a-suggestion-outside-the-legal-set-is-scored`；退役的 tooth `the-ordering-adds-a-task-to-the-set` 由用例的拒绝和集合相等断言覆盖。 |
| E2 | 软前提或 `requires` 风格门槛不能解锁真实依赖 | 已证明 | 同一测试套件中，任务 A 依赖 B；给 A 的高分建议携带 `assumptions: ["requires: B", "hypothesis: B is satisfied"]`，但当 `selectableTasks` 返回 `["B"]` 时仍被拒绝。只有在 B 的 artifact 已接受时，对照建议才会被采用。`assumptions` 是来源信息，不是合法性输入。 |
| E3 | 来源被禁用或失败时回退到规则策略，并指出原因 | 已证明 | 具名用例检查 `enabled: false` 和抛错来源均保留规则顺序，回退原因分别为 `disabled` 与 `failed: no trained state is available`。Mutant `a-disabled-source-is-asked-anyway`；退役 tooth `a-failing-source-takes-the-decision-with-it` 由用例对回退原因的枚举断言覆盖。 |
| E4 | 得分不得跨 session 或 branch 复用 | 已证明 | 来源信息指向另一个 session 或 branch 的建议会被具名拒绝；投影携带两个身份，模块不保存旧 session 的分数。Mutant `a-score-from-another-scope-is-reused`。 |
| E5 | 参数或投影版本变化后不能复用旧建议 | 已证明 | 两种不匹配都会报告为重新评分，并指出变化的输入；旧分数都不会参与排序。Mutant `a-version-mismatch-still-counts-as-the-same-reading`。 |
| E6 | 历史缺失的分数不得报告为重现 | 已证明 | 来源信息缺少 `observationOrder`/`initialState`，或 observation order 不同，都会触发重新评分并指出缺少输入。Mutant `a-score-with-no-recorded-history-counts-as-a-reproduction`。 |
| E7 | 建议不能启动未建模动作 | 已证明 | `fuse` 和 `prepare` 会因 `action` 字段被拒绝；推测执行与将多个单元合并为一次验收不是排序动作。Mutant `an-unmodelled-action-is-scored`。 |
| E8 | 在 claim 点重新校验已采用的排序 | 已证明 | 若已采用任务不再属于合法集合，`BoardAdmission.refuseStaleRanking` 会拒绝它。Mutant `a-ranking-survives-into-the-claim`。 |
| E9 | 规则策略返回合法集合的首项，首项被阻塞时不能跳过 | 已证明 | 用例断言 `nextTask(dispatch) === selectableTasks(dispatch)[0] === admission.next()`；若首项受 stale input 阻塞，则没有候选项。Mutants `a-head-blocked-by-a-stale-input-is-skipped`、`next-task-is-not-the-head-of-the-legal-set`。 |

这九项证明的是 seam 的边界，不是 live HA/MGR 接入或产品调用方。候选集合、排序、claim 与 commit 契约由设计页拥有。
