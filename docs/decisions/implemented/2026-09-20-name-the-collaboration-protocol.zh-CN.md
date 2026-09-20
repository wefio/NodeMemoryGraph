# 给协作协议与它的任务单元子协议定名

[English](2026-09-20-name-the-collaboration-protocol.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [任务单元语义](../../design/task-unit-semantics.md)、[派发循环是共享的](2026-09-19-dispatch-loop-is-shared.zh-CN.md)

## 问题

这条线在做的东西一直没有名字，于是每次讨论都要重新推导指的是什么：是黑板、是 run 这个对象、是
Agent 用的那几个动词，还是拍板的那些规则。顺手能用的词又都已经被占，而且占法会引导出错误理解：
**融合** 已经指一个具体机制（多单元共享一个会话：`sharedSessionLegal`、`fusionAccounting`）；
**调度器** 是任务单元语义那条决策明确说不启用的东西；**治理** 已经是黑板地址与可读性那一线；
**台账** 已经指三样（假设、预算、披露）；**executor** 已经指受限的 context executor 适配器和 Pi
SDK 执行路径。用其中任何一个给新东西命名，讨论是短了，理解会更差。

## 决策

分两层，每一层一个含义：

- **协议化协作（Protocol-Governed Collaboration）** 是大类：agent 之间通过一份公开的协议协商，
  而协商的机制属于程序，不属于模型的讨论。黑板的那些动词只是它的一个实例。
- **任务单元协议（Task-Unit Protocol）** 是这条线在做的子协议：把任务声明成单元（输入、依赖、
  验收、能力、预算），并规定它如何被收编进一次 run、如何被认领、交付与独立裁决，以及哪些事实由
  运行时拍板并负责。"任务单元"是设计里已有的词，缺的是"协议"的那一半。

各组成部分沿用已有名字，不另起：**黑板（Task Board）** 是这个子协议的面；**受管条目（managed
entry）** 是条目被某次 run 治理之后的状态；**run** 是计划、任务与事实被冻结的那个对象；
**adopt（收编）** 是把条目绑到一次 run 的那次转移。唯一没有名字的是"决定收编的调用方"，本记录叫它
**收编者（adopter）**。

## 命名一览

这是索引，不是第二份规范：每个名字一行含义加一个指针，行与 owner 冲突时 owner 胜。它存在的原因是这些定义
原本只能把设计文档、义务台账和几条决策记录摊在一起才看得全。

两个层次与它们的组成：

| 名字               | 一句话含义                                                                                           | 契约 owner                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议化协作         | agent 通过一份公开协议协商，机制与拍板留在程序侧                                                     | 本记录；[概念图](../../guides/concept-map.zh-CN.md)                                                                                                     |
| 任务单元协议       | 把任务声明为单元，并规定它被收编、认领、交付、裁决的方式以及运行时拥有哪些事实                       | [task-unit-semantics.md](../../design/task-unit-semantics.md)、[义务台账](../../design/task-unit-semantics-obligations.md)                              |
| 任务单元           | 可以交接、验证和独立作废的工作，由输入、依赖、验收、能力与预算声明                                   | [task-unit-semantics.md](../../design/task-unit-semantics.md)                                                                                           |
| 黑板（Task Board） | 位于语义记忆之外、有归因、有过期时间的任务级协作区                                                   | [memory-graphs.md §2](../../design/memory-graphs.md#shared-task-board-cross-agent-coordination-not-a-memory-graph)                                      |
| 条目 entry         | 一条黑板项（goal / question / handoff / blocker / result / note / decision），带认领租约、交付与裁决 | [board-find-serial-a2a-compat](../../design/board-find-serial-a2a-compat-2026-08-13.md)                                                                 |
| 唤醒 wake          | 定向条目通知那个 agent 的会话；黑板只负责把人叫到，不决定谁干活                                      | [board-find-serial-a2a-compat](../../design/board-find-serial-a2a-compat-2026-08-13.md)                                                                 |
| 串行通道           | 同一时刻只推送一条未定向的 actionable；它被认领或关闭时晋升下一条                                    | [board-find-serial-a2a-compat](../../design/board-find-serial-a2a-compat-2026-08-13.md)                                                                 |
| 认领 / 释放 / 关闭 | 租约动词：同一时刻一个持有者，过期回池，关闭即结束                                                   | [黑板治理与能力寻址](2026-09-06-board-governance-addressing.zh-CN.md)                                                                                   |
| 交付 / 裁决        | 认领以 digest 绑定的交付物收尾，由另一个 agent 裁决（accepted / rejected / undecidable）             | [黑板治理与能力寻址](2026-09-06-board-governance-addressing.zh-CN.md)                                                                                   |
| 受管条目           | 已被某次 run 收编的条目：在 run 的协调范围之外，它的生命周期动词被拒                                 | [义务台账 B6](../../design/task-unit-semantics-obligations.md)                                                                                          |
| run（运行）        | 冻结的对象：已注册的 run、一份冻结计划、绑定的条目与事实日志，经 `taskRun` 到达                      | [义务台账 D11、D13](../../design/task-unit-semantics-obligations.md)                                                                                    |
| adopt（收编）      | 把黑板条目绑到一次 run 的那次转移，记为运行事实 `entry-bound`                                        | [义务台账 D12](../../design/task-unit-semantics-obligations.md)                                                                                         |
| 收编者 adopter     | 决定收编的调用方；本表里唯一还没有产品实现的名字                                                     | 本记录；[义务台账“还剩什么”](../../design/task-unit-semantics-obligations.md)                                                                           |
| 运行事实 run fact  | 一次已记录的运行转移：`entry-bound`、`board-claim`、`board-deliver`、`board-judge`、`run-cancelled`  | `src/integration/task-coordinator.ts`                                                                                                                   |
| 合法动作集合       | 确定性算出的、来源只能在其中排序的集合，按声明的槽预算切分                                           | [声明的槽预算](2026-09-18-declared-slot-budget.zh-CN.md)、`src/integration/ooo-execution.ts`                                                            |
| 派发循环           | 共享的顺序循环，逐单元驱动一份计划，黑板在端口之后                                                   | [派发循环是共享的](2026-09-19-dispatch-loop-is-shared.zh-CN.md)                                                                                         |
| 会话 / 融合        | 单元的会话按黑板取键而非按 harness；融合是多单元共享一个会话——一个机制，不是本协议的名字             | [会话身份来自黑板](2026-09-19-session-identity-comes-from-the-board.zh-CN.md)、[融合的合法性与记账](2026-09-18-fusion-legality-and-accounting.zh-CN.md) |

刻意不用的两个词：

| 词               | 为什么不用                                                                         | 真实含义的 owner                                                   |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 调度器 scheduler | 语义层刻意不启用：排序是合法集合上的确定性规则加声明的预算                         | [任务单元语义](2026-09-13-task-unit-semantics.zh-CN.md)            |
| OoO、`ooo-`      | 项目给自己实现的调度模型起的名字，也是文件前缀；它指的是模型，不是“谁讨论、谁拍板” | [ooo-execution-bootstrap](../../design/ooo-execution-bootstrap.md) |

## 考虑过的替代方案

- **继续叫 OoO。** 作为大类被拒：`ooo` 是项目给自己实现的调度模型起的名字、在 100 多份文档里承重，
  但它指的是模型，不是"谁讨论、谁拍板"这个二分，所以消不掉定名要消的歧义。
- **黑板治理的执行（Board-Governed Execution）。** 被拒：`治理` 已经是黑板地址与可读性那一线，而且
  这个说法读起来像"黑板在拍板"，与"程序拍板"正好相反。
- **任务单元生命周期协议。** 被拒：太长，不好说；生命周期那层意思从定义里读得出来，不必写进名字。
- **受管运行协议（Managed Run Protocol）。** 被拒：丢了语义那一半，而那是设计的主体，也是黑板自己
  查不了的那一半。
- **名字里带"融合"。** 被拒：执行融合已经指一个具体机制（多单元共享一个会话），而收编与派发无论有
  没有融合会话都会发生。
- **为了让名字成立去改代码或设计文档名。** 被拒，理由与"给检查身份与检查运行器定名"那条记录一致：
  `ooo` 这个词与现有路径被带日期的测量记录和冻结的运行归档引用，改名会让证据指向不存在的路径。

## 后果

- 讨论可以指名层次了：整体叫协议化协作，语义加运行时那一层叫任务单元协议，缺的调用方叫收编者，
  其余部分沿用黑板、run、adopt、受管条目这些已有词。
- 不改任何标识符。`run`、`adopt`、`managed`、`dispatch`、`ooo-` 文件前缀以及所有文件名保持原样，
  因此没有历史记录需要修补。
- 名字住在概念图里并带别名以便检索。`docs/glossary.yaml` 不动：它负责仓库与流程词汇，而这是产品概念。
- 定名本身不建任何东西。子协议的机制已经在（run 面、受管写入围栏、共享派发循环），产品路径仍然没有
  收编者——那是下一步工作，不是这个名字的后果。
