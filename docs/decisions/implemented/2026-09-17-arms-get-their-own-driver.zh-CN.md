# 实验臂自建驱动器，轮次保持为“一个实验”

**Status:** implemented
**Approved:** explicit
Date: 2026-09-17
Branch: feat/ooo-run-namespace
**Relates to:** [task-unit 语义设计](../../design/task-unit-semantics.md)、
[义务台账](../../design/task-unit-semantics-obligations.md)、
[F1 成本扫描实验](../../experiments/execution/ooo-cost-model-2026-09-17.md)

治理 meta-rule：[self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) ——
本规则变更本身也是一次受治理的决策（决策 + 替代方案 + 一个规则一个家）。

English: [2026-09-17-arms-get-their-own-driver.md](2026-09-17-arms-get-their-own-driver.md)

## 问题

设计里的 A–D 臂要在**同一个父任务**上比较**不同粒度**：A 是原父任务，B/C 是它的合法细化。细化就是
**另一个计划**，所以这些臂需要“能跑任意合法计划”的轮次。仓库里唯一的轮次是为**一个特定实验**写的：

```
const plan: ProbePlan = [
  ["A", "", [], "isolated-artifact", "protocol-regression", null],
  ["B", "", [], "isolated-artifact", null, null],
  ["C", "", ["A", "B"], "isolated-artifact", null, null],
];
```

它看起来像一个可以参数化的常量，本切片最初的计划也正这么说：“把 `plan` 变成选项，臂就成了数据”。
**测量否证了这一判断**：`src/integration/ooo-cycle.ts` 共 1 063 行，其中 **42 处**引用这三个固定名字：

| 类别         | 例子                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| 选项形状     | `aInstruction` / `bInstruction` / `aEditable` / `bEditable` —— 两个 patch 任务，按名字  |
| 按任务的映射 | `noChangeCases?: Record<"A" \| "B", …>`、`mutations`、`visible`、`admitted`、`requires` |
| 流程里的角色 | 给 **A** 发检查、检查悬空时跑 **B**、之后修 **A**、晋升 **C**                           |
| 贯穿的不变量 | `"A" \| "B"` 穿过 patch 校验、用例判定与“前提未满足”检查                                |

也就是说，**驱动器本身就是那个实验**，泛化它是重写而不是改名。同一轮阅读还发现一个更小的隐患：
研究 runner（`evals/ooo-execution/round-runner.ts`）把它**逐字复制**成 `ROUND_PLAN`，而另一个进程
正是通过打开“这个计划塑造的 store”来取消/查询轮次——一旦副本漂移，操作者就会去围堵一个**并非它正在
运行**的计划。

## 决策

**实验臂在 `evals/ooo-execution/` 下自建研究侧驱动器，`src/integration/ooo-cycle.ts` 保持它那个特定
的“外部窗口”实验不动。** 依据是设计自己的排序：“先做语义判定，**不先搭建通用调度平台**”，以及“研究
枚举与成本模拟保持 advisory”。产品侧的通用计划调度器正是那句话要推迟的平台；而这些臂属于研究。

同一次变更里落下了计划的**可读性那一半**，因为漂移隐患是真实且与驱动器无关的：

- `DEFAULT_ROUND_PLAN` 在 `src/integration/ooo-cycle.ts` 只导出一次；`ROUND_PLAN` 删除，runner 改为
  import 而不是重新声明。
- `CycleOptions.plan?: ProbePlan` 是轮次运行的计划，且轮次日志记录**它被赋予的计划**，而不是字面量
  `["A","B","C"]`——报告与运行不一致比没有报告更糟。
- `openRoundStore(databasePath, plan)` 支持按计划打开 store，于是 store 与它的轮次可以共用同一个值。
- spec 可以声明 `plan`，计划成为数据而不是改研究脚本（S3 的目标）。解析器**只查形状**：计划里允许
  什么（重复 id、未知依赖、自依赖、依赖环、权限扩大）仍归共享编译器独家拒绝，一个规则一个家。

## 考虑过的替代方案

**乙：把 `src/integration/ooo-cycle.ts` 泛化到任意计划。** 暂不采纳，理由是上面那 42 处耦合，以及设计的
排序：它会在语义定案之前把一个有名字的实验变成产品路径上的通用调度器，并把实验臂的需求塞进产品自己的
驱动。并非永久否决——见后果一节。

**保留计划为常量，把粒度塞进现有 A/B 角色。** 作为不诚实方案否决：粗臂只能写成“同样三个单元、指令更长”，
而这正是设计自己的反例（“仅把测试分成普通与边界两组、串行换会话，不能证明发现并发”）。那会花掉 token
去回答一个答不出的问题。

**只把计划变成可注入就收手（不新建驱动器）。** 作为不充分否决，而且现在由测试说明理由：没有 `A`/`B`/`C`
角色的四单元计划会以 `plan refused by the shared semantics: … a patch spec exists for a task that is not
in the plan` 失败；把汇合点从 `C` 改名也同样失败。可读性那一半单独**跑不了**这些臂。

## 后果

- **`src/integration/ooo-cycle.ts` 故意保留 A/B/C 角色。** 它们是实验的自变量而非偶然：A 的检查悬空时
  跑 B，正是设计所说的乱序决策。不再计划进一步泛化。
- **研究驱动器消费共享层，而不是这个函数**：同一个 `BoardAdmission`、任务协调器、运行面与轮次日志，由
  `evals/ooo-execution/` 驱动。
- **如果将来产品路径确实需要任意计划**，那是一次单独的受治理决策，并有自己的切片；它必须回答本记录没有
  回答的问题：通用驱动器是否该进 `src/`，还是产品永远只驱动宿主声明过的计划。
- **边界由测试钉住，而不是注释。** `evals/ooo-execution/round-plan.test.ts` 断言了上述两种拒绝，所以将来
  泛化驱动器的人会看到这两条用例翻转，并有意识地修改它们，而不是在一次付费轮次里才发现这层耦合。
- **重复永久消除**：任何将来需要默认计划的地方都读 `DEFAULT_ROUND_PLAN`。
- **操作者决定推迟、而不是忘掉：轮次的“角色”与“机制”是否该剥开。** 直接删掉 `runCycle` 会同时删掉 S4 的仪器、它的五个回归套件、账本 D7/D10 的证据、乱序派发唯一的端到端载体，而且四个共享类型就住在这个文件里（`Requirement`、`CaseRule`、`CycleWorker`、`WorkerMetrics`）。这个选择的实测形状是：**角色层**约 54 处引用、~150 行（`aInstruction`/`bInstruction`/`aEditable`/`bEditable`、`Record<"A"|"B">` 各表、`installA`、`installB`、`patchVerifier`、`casesTail`，以及 `let a / let b` 的流程），而“认领—提交—验证”的核心 `runTask` 已经是按 task id 参数化的。先做 F2b 与 F3；判断是否剥开的证据，就是研究驱动器实际不得不复制多少那段核心。

## 验证

- `evals/ooo-execution/round-plan.test.ts` —— 6 条：日志记录它被赋予的计划（把日志改回字面量
  `["A","B","C"]` 会令其失败）、上述两种拒绝、一个计划值同时到达 store 与轮次、spec 映射及其默认值、
  以及解析器的拒绝。
- `evals/ooo-execution/cycle.test.ts` —— 23 条，未改动且全绿：驱动器行为被保留。
