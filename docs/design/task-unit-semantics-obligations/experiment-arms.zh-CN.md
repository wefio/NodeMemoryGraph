# F. 后续阶段：实验 arms

[English](experiment-arms.md) · [术语](experiment-arms.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.zh-CN.md).

## F. 后续阶段：实验 arms

A–E arms 已有离线证据，并在设计要求时完成付费测量。离线模型检查语义与成本形状，不预测真实模型质量。付费结果受模型、任务族、工具与样本量限制；数值及其限制由链接的实验记录拥有。

| 步骤 | 状态 | 证据边界 |
| --- | --- | --- |
| F1：离线建议式成本模型 | 已证明 | `evals/ooo-execution/cost-model.ts`、对应测试及[成本 sweep 记录](../../experiments/execution/ooo-cost-model-2026-09-17.zh-CN.md)。成本预测由 sweep 记录拥有，不可当作付费测量。 |
| F2a：计划只有一个来源 | 已证明 | `PlanDriverSpec.plan` 是 driver 输入，冻结运行 manifest 是持久化计划。round 专用载体随旧工具退役（[决策](../../decisions/implemented/2026-09-18-retire-the-round-instrument.zh-CN.md)）；单一来源的选择见 [driver 决策](../../decisions/implemented/2026-09-17-arms-get-their-own-driver.zh-CN.md)。 |
| F2b：任意合法计划 | 已证明 | `evals/ooo-execution/plan-driver.ts` 从 `BoardAdmission.candidates()` 获取有序合法集合。`plan-driver.test.ts` 与已注册 mutations 覆盖 driver；不得重新派生合法性。 |
| F2c：选择 parent 任务族 | 已证明 | 粗、细两种 report family 由 `evals/ooo-execution/families.test.ts` 检查；`pipeline` 任务族在 driver 之后才作为 held-out family 加入。parent check 组合子任务的接受结果，任一子检查失败都会拒绝 parent。 |
| F2b-slot：声明并发预算 | 已证明 | `slots` 默认 1；先按顺序计算可启动集合，再按预算裁切。预算大于 1 时必须提供 `handoffTarget`，使每个可执行 handoff 都有方向。覆盖见 `board-slots.test.ts`、`narrow-dispatch.test.ts`、`plan-driver.test.ts` 与 `tests/integration/task-semantics.test.ts`；策略由[决策](../../decisions/implemented/2026-09-18-declared-slot-budget.zh-CN.md)拥有。 |
| F3：真实模型 A/B/C pilot | 已测量；仅具方向性 | pilot 使用 `deepseek/deepseek-v4-flash`，A=3、B=3、C=2，共 8 次运行与 23 次模型调用；8 次 parent check 全部接受。单一模型和单一 held-out 任务族不足以比较一般质量。见[试验记录](../../experiments/execution/ooo-arms-pilot-2026-09-18.zh-CN.md)。 |
| F4：融合合法性、计量与 session 策略 | 离线已证明；live 机制已测量 | 融合测试覆盖共享规则与 driver 策略。`createPiSessionRunner`、`piSessionWorker`、`--session-runner` 提供跨单元 session 复用。六次 D arm 运行质量一致；约 1.9 秒的 wall median 差小于两臂各自 2.2 秒的 spread，token 基本持平。另一个四单元 cap experiment 的两次重复配对测得 wall 节省 8.451 秒；第三次重复使用了较新的 prompt，token/cost 比较仍未解决。见[试验记录](../../experiments/execution/ooo-arms-pilot-2026-09-18.zh-CN.md)与[归档](../../experiments/execution/archive/ooo-arms-2026-09-19/README.zh-CN.md)。 |
| F5：有界推测生命周期 | 离线已证明；付费 E arm 已测量但无收益 | 首个 arm 的边界是：一个已声明的待决事实、无推测后继、无不可逆操作。`speculationOutcome` 在 true 时发布，在 false 时丢弃候选并关闭 branch session，在 unknown 时等待。E arm 共运行两次；有证据的第二次运行中，事实成立时 3 个候选都无法发布，因此不声称 speedup 或收益。见[试验记录](../../experiments/execution/ooo-arms-pilot-2026-09-18.zh-CN.md)与[归档](../../experiments/execution/archive/ooo-arms-2026-09-19/README.zh-CN.md)。 |

### 历史 F2b 单 claim 探针

首个 driver 探针发现 run 一次只能持有一个 claim。这是 F2b-slot 之前测得的前置条件，不是当前槽预算契约。详见[探针与后续状态](experiment-arms/single-claim-experiment.zh-CN.md)。
