# 运行自声明槽预算，一次认领花掉一个槽

**Status:** implemented
**Approved:** explicit
Date: 2026-09-18
Branch: feat/ooo-run-namespace
**Relates to:** [task-unit 语义设计](../../design/task-unit-semantics.md)、
[义务台账](../../design/task-unit-semantics-obligations.md)、
[实验臂自建驱动器](2026-09-17-arms-get-their-own-driver.md)

治理 meta-rule：[self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) ——
本规则变更本身也是一次受治理的决策（决策 + 替代方案 + 一个规则一个家）。

English: [2026-09-18-declared-slot-budget.md](2026-09-18-declared-slot-budget.md)

## 问题

设计的 C 臂比较的是**同一份细计划在不同槽数下**的表现（"C 同一细计划、多槽 | 仅改变执行槽数/合法顺序"，
`docs/design/task-unit-semantics.md:371`），而设计的主问题里有一半是并发。做实验臂的驱动器时**测出这条臂没有
机制**：在一个前三个单元互相独立的计划上请求 `slots: 4`，运行报告 `slotsUsed: 1`，其余按名字拒绝
（"no published handoff for this task"）。测量记录见
[台账](../../design/task-unit-semantics-obligations.md#what-f2b-measured-a-run-can-hold-exactly-one-claim)。

造成它的是三条规则，各自在自己的家：

1. `selectableTasks`（`src/integration/ooo-execution.ts`）在**任何**未接受任务被认领时返回 `[]`。它的注释写的是
   更窄的**邻居**规则（"a task whose earlier neighbour is still claimed blocks selection"），代码并没有实现它。
2. `publishReady`（`src/integration/ooo-board.ts`）只为被选中的任务发布 handoff，认领则拒绝任何不是 `next()`、
   或没有已发布 handoff 的任务。
3. 存储按 channel 串行化未定向的动作条目：只有没有其它打开着的未定向动作条目时，本条才是 `outstanding`，下一条是
   `pending`，而 `claimTaskBoardEntry` 会拒绝 `pending` 条目，直到 outstanding 那条被认领、解决或过期
   （`src/core/store/base.ts`）。这就是 D14 边界，它被特意选成"同一时刻只有一个动作摆在 Agent 面前"（台账 D14 行）。

## 决策

**运行自声明它能同时持有几个认领**，每次认领花掉一个。这个数是 `slots`，默认 `1` —— 也就是仓库原本就有的规则。

- `selectableTasks(plan, slots)` 是共享规则已经给出的合法集合，减去已被认领的任务；当 `claimed >= slots` 时为空。
  排序步骤可以给这个集合排序，不可以放宽或收窄它。被认领计数统计的仍是上一条规则统计的那批 pending 任务。
- `startableTasks(plan, slots)` 是上述有序集合裁到 `slots - claimed` 的那一段，也是认领许可**唯一**可以点名的部分。
  裁剪发生在**排序之后**，所以"哪个合法任务排第一"仍由排序决定，预算不会把候选池交回规则自己的顺序。
- `deriveStatus(units, facts, slots)` 用同一段裁剪作为 `ready`，因此状态查询与启动规则不会对"现在能启动什么"给出两种答案。

其余一律不放宽。被认领任务的依赖在认领在途期间仍未接受，所以依赖它的任务依旧不能提前启动（`valid`/`ready` 未改）；
"至多一个任务可以在被许可的预测中等待外部事件"是另一条规则，不动；接受谓词、围栏与租约不动。认领在它的任务被接受
之前都在途 —— 正是接受把任务移出预算所统计的 pending 集合。

## 考虑过的替代方案

C 臂需要 N 个认领共存，所以必须回答存储的按 channel 串行化。有两条路：

- **（a1）允许每个 channel 有 N 条 outstanding 的未定向动作条目。** 这会改变产品任务板的推送语义 —— 也就是 D14 特意
  选的悲观顺序，其目的是"同一时刻只有一个动作摆在 Agent 面前"。否决：代价是产品可见的，收益只是一个实验。
- **（a2）把每个单元的 handoff 定向发给它自己的认领者。** 定向条目（`to != null`）按构造就不参与串行化 —— 存储那条
  规则自己的注释就是这么写的："Directed entries and notify-only kinds are not serialised (point-to-point,
  parallel-safe)"。于是存储与 D14 完全不动，而每个槽的工作是通过点对点投递出去的，这本来就是它的样子：驱动器在板上的
  owner 是逐任务不同的。

（a2）是下一片要用的形状，所以本记录的代价只有一层规则。同样被否决的是 **（b）**：F3 只比较 A 与 B，并记录"并发在这个
接缝上不可达" —— 设计的主问题有一半是并发，那等于在便宜机制存在的情况下把它留空。

## 后果

- 默认 `1` 逐字复现原先行为，因此所有既有断言成立：原来"有认领即阻断选择"变成 `claimed >= slots`，在单槽下与旧谓词
  等价，而产品轮次根本不传槽数。规则的注释与代码现在陈述同一条规则。
- 状态查询变得"按预算回答"。这是本次唯一触及的产品可见面，在默认值下它给出的答案与从前相同。
- 更大的预算要求运行付出什么：必须已发布并定向好那些 handoff，且不得把退回单槽的运行读成多槽运行。实验臂的驱动器继续
  分别报告"请求的槽数"与"达到的槽数"，并在未达到请求值时拒绝给出时间结论。
- 牙齿：新规则上四个具名突变体 —— 预算用尽不关闭选择、被认领任务仍在候选里、裁剪没从 startable 集合里切、零或半个槽
  被当成预算 —— 每个都被点名的那条用例抓住（`tools/mutation-teeth.ts`，目标
  `src/integration/ooo-execution.ts` 与 `src/integration/task-semantics.ts`）。

## 实现状态

- **已落地**：规则层与状态读（`selectableTasks`、`startableTasks`、`nextTask`、`deriveStatus`），
  `evals/ooo-execution/narrow-dispatch.test.ts` 新增两条用例（共 6 条）、`tests/integration/task-semantics.test.ts`
  新增一条，加上上述四个突变体。没有任何调用方传非默认值，所以本记录没有改动任何开关或入口。
- **下一步，同一决策**：`BoardAdmission` 的声明槽数、为每个可启动任务发布 handoff 并定向给它的认领者、认领许可点名
  任一可启动任务、驱动器的真实 N 槽。之后是 F2c 的规格对与 F3。
