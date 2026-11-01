# 在现有黑板上复用协作概念

[English](board-concept-reuse.md) · [使用的术语](board-concept-reuse.terms.yaml)

当协作需求类似 DSH 原型概念时，先使用下文对应的 NMG 操作。
概念清单是参考，不是新增字段、表、工具、状态机或调度器的实施要求。
吸纳条件由[事件契约](../design/board-event-records.zh-CN.md#概念吸纳)维护。
本指南不改变运行时行为，也不把草案中的任务语义宣布为已实现。

## 原型概念参考清单

来源：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。
于 2026-11-01 核对 main 分支文档与类型；链接内容可能变化。
以下简述用于识别概念，不复制其完整生命周期规则。

| 输入与通信概念 | 它区分的问题 |
| --- | --- |
| Source | 输入来自哪里，谁维护读取位置？ |
| Trigger | 到达的是哪一次不可变输入？ |
| Thread | 哪段有序讨论提供上下文？ |
| Correlation | 可以查阅哪些关联上下文？ |
| Channel | 可以向哪个外部地址回复？ |
| Subscription / Fan-out | 哪种订阅关系把更新送给哪些工作？ |

上游[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)
把这些与工作身份分开，并将 Source、Thread、Eval、Mandate、Subscription 视为核心领域。
NMG 不必照搬其聚合布局。

| 准入概念 | 它区分的问题 |
| --- | --- |
| Policy / Policy version | 使用哪套准入规则？ |
| Eval / Gate / Assessment | 评估过程、确定性准入检查、模型研判分别是什么？ |
| Decision | 评估作出了什么决定？ |
| Mandate / Scope / Strength | 哪项工作得到授权，范围和依据是什么？ |

来源：[授权契约](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)。
这些不等同于 NMG 的成果验收或普通 decision 消息。

| 工作与接续概念 | 它区分的问题 |
| --- | --- |
| Ticket | 什么工作独立于执行者持续存在？ |
| Assignment | 哪一次执行绑定承担责任？ |
| Executor / Session / Execution environment | 谁执行分配，使用哪个会话和环境？ |
| Input | 什么上下文被交给工作？ |
| Disposition | 输入去了哪里，是否被接手或退回？ |
| Report | 执行者报告了什么？ |
| Attention | 哪个明确问题等待人回答？ |
| Follow | 哪个外部对象的闭合影响这项工作？ |

来源：[模型类型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/model.ts)
和[执行契约](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)。
Agent、Main Session、Executor Session 描述上游参与者和执行角色，不规定 NMG 必须采用的组织层级。

Effects、Outbox、收据和 DomainEvents 是支撑这些概念的可靠性机制，不是新增管理职位。
上游[架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)
与[端口](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/ports.ts)
区分领域事务和排队执行的外部工作。本指南不吸纳其具体重试、恢复、人工优先或 PR 闭合策略。

## 先使用已有基础

| 需求 | 现有 NMG 路径 | 保留的边界 |
| --- | --- | --- |
| 分享发现或请求决定 | 在明确频道写入 `note`、`result`、`question`、`decision` | 普通文本表达意图，不代表执行授权或已接受成果 |
| 保留协作过程 | `eventCreate`、检查修订的 `eventUpdate`、`eventRead`；关联频道和资源 | 协作事件是持续过程，不是一次 DSH Trigger |
| 关联讨论而不唤醒所有人 | 事件／频道关联，按需读取上下文 | 关联不等于通知；NMG 频道不等同于 DSH 的只写 Channel 地址 |
| 邀请协作者或跟进变化 | 现有定向、频道和事件通知范围、邀请与订阅 | 受邀／订阅不等于认领工作；ACK 不产生下一轮唤醒 |
| 提供工作并转交责任 | 可认领的 `handoff` 条目，以及现有 claim/release、attempt、lease 操作 | 黑板条目不自动成为持久 Ticket；`taskId` 是频道地址 |
| 提交与评价成果 | 现有交付引用／digest 和独立 judge/verdict | 收据、自报解决、独立接受是不同事实 |
| 执行已声明依赖 | 支持范围内的受限 OoO 任务／run 与成果绑定 | 事件 `dependencies` 不直接调度或解锁；Task IR 仍是含草案扩展的派生视图 |
| 展示相关上下文 | 现有 InformationView 投影与预算 | 渲染不授予权限、不提交验收，也不证明最终 provider 送达 |

操作语法与订阅行为继续由[黑板工作流](../../skills/nmg-memory/references/board.zh-CN.md)、
[事件通知](../design/board-event-records/event-subscription-and-notification.zh-CN.md)
和[任务声明映射](../design/task-unit-semantics/task-ir-vocabulary.zh-CN.md)维护。
[视图契约](../design/state-spaces.zh-CN.md#统一上下文信息项)拥有呈现行为。
复用这些 owner，不为现有字段增加同义别名。

例如，一个事件关联设计与验证频道。发现写成 note，需要意见时显式邀请；
若请求执行，另发 handoff。收到邀请不等于接受 handoff。
交付和判定沿用现有操作；关闭讨论事件不会完成其他参与者的工作。
这个流程不需要新的 Ticket 或 Assignment API。

## 有具体缺口再启用候选概念

| 候选扩展 | 值得重新讨论的证据 |
| --- | --- |
| 通用 Ticket / Assignment 对象 | 任务必须超过现有条目保留期，或当前 owner 无法区分多次执行绑定 |
| Input / Disposition 责任 | 可复现的交接丢失、重复或无法确定输入归属，现有收据不能解决 |
| 通用 Policy / Mandate / Eval | 新输入路径需要其宿主契约无法表达的权威、版本化准入决定 |
| 可执行依赖 DAG | 具体任务依赖无法由支持的任务／run／成果契约表示或检查 |
| 新 Outbox 或副作用队列 | 已证明的提交／送达恢复缺口无法由现有送达 owner 处理 |

这些是参考候选，不是承诺实施的待办。宣布缺口前先核对 owner 实现与支持边界。
存在缺口时保留失败场景，再最小化扩展该 owner，并检查版本、并发与恢复。
不把全部语义关系变成 DAG 边：上下文、订阅和冲突关系不是执行前置条件。
