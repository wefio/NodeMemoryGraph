# 显式研究探针

[English](explicit-research-probes.md) | [简体中文](explicit-research-probes.zh-CN.md) · [术语](explicit-research-probes.terms.yaml)

**权威范围：**[功能注册表](../feature-register.zh-CN.md)。以下是评测／研究入口，不等同于产品 runtime 集成。精确命令、参数与拒绝条件以[英文原文](explicit-research-probes.md)为准；本页保留主要边界与状态。

## 显式研究探针

| 功能 | Gate／默认 | 摘要与边界 | 位置／状态 |
|---|---|---|---|
| Narrow OoO dispatch and admission | on-demand suite；默认无生产 wiring | 使用固定计划、单 runner、安全副作用 dispatch 与多进程 admission 探针；fixture-only 的 daemon／worker、IPC 时钟及 commit／外部事件／输入版本控制。`BoardAdmission` 的 declared `slots`（默认 1）与 `handoffTarget` 决定并行 admission；无 target 而 slots > 1 会拒绝。`round-host.ts` 可作为测试中的真实第二进程 round store，但没有生产 wiring；这是 dispatch/admission 实验，不是端到端 Agent scheduler。 | `src/integration/ooo-*`、`evals/ooo-execution/`；[admission 实验](../../../experiments/ooo-admission-2026-09-08.zh-CN.md) |
| Bounded speculation pilot（E arm） | `node --experimental-strip-types evals/ooo-execution/speculation-pilot.ts --live`；默认关闭 | 需要 `PI_PROVIDER`／`PI_MODEL`，`E_REPS` 控制重复次数。单一声明事实决定是否需要该 unit；候选预先生成，由 shared layer 的 `speculationOutcome` 决定发布或丢弃。Host 仍以 unit 自己冻结的 check 验证候选；每次尝试使用新 ticket，失败检查保留候选树作证据。 | `evals/ooo-execution/speculation-pilot.ts`；[F5 obligation](../../task-unit-semantics-obligations.zh-CN.md)；无默认 caller／产品接线 |
| Arms' plan driver | `plan-driver.ts run\|compare`；模型 worker 必须显式 `--live` | 研究 driver 执行声明的 spec 和 slots；每次 handoff 指向 claimant，结果记录实际 slots、instrument commit、provider usage 与 prompt digest。Fusion 是 opt-in，控制臂不得声明 fusion；只有 store 接受的 unit 才能延续 session，非法 successor、拒绝 verdict 或边界会终止。真实 `pi` session 若不能维持 continuation 会拒绝，除非传入 `--session-runner`。`pilot.ts` 执行付费 A/B/C pilot；报告模式只聚合已记录 run，不调用模型。 | `evals/ooo-execution/plan-driver.ts`、`pilot.ts`；[driver 决策](../../../decisions/implemented/2026-09-17-arms-get-their-own-driver.zh-CN.md)、[slot budget](../../../decisions/implemented/2026-09-18-declared-slot-budget.zh-CN.md)、[fusion legality](../../../decisions/implemented/2026-09-18-fusion-legality-and-accounting.zh-CN.md)；研究工具，无产品 wiring |
| Advisory cost model（fusion accounting） | `cost-model.ts`；离线 | 只模拟成本，无质量项。Fusion savings 与 shared startup 分开报告；未以 `--session-start-measured` 证明 session startup 已测量前，verdict 为 `unmeasured`，不得从假设中读出阈值。`assertModelProperties` 会拒绝违反已声明边界的模型。 | `evals/ooo-execution/cost-model.ts`；[成本模型记录](../../../experiments/execution/ooo-cost-model-2026-09-17.zh-CN.md)；advisory instrument，不是 fitted cost model |
| Real Pi snapshot／patch execution | `live-pi.ts --live`、`live-patch.ts --live` | 共享执行机制已从 harness 抽出；harness 仍是 adapter。Pi SDK executor 受界限约束，live provider 必须显式批准。`.pi/extensions/nmg/ooo-execution.ts` 虽存在，但未由 extension index 导入，因此不会注册 session tool。 | `src/integration/ooo-session-mechanism.ts`、`src/integration/ooo-execution.ts`、`src/integration/ooo-patch.ts`；[live experiment](../../../experiments/ooo-admission-2026-09-08.zh-CN.md#live-pi-sdk-run--2026-09-09)；无默认 session takeover |
