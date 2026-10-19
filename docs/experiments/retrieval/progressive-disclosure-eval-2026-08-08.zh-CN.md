# 渐进式披露评估（2026-08-08）

[English](progressive-disclosure-eval-2026-08-08.md) | [简体中文](progressive-disclosure-eval-2026-08-08.zh-CN.md) · [术语](progressive-disclosure-eval-2026-08-08.terms.yaml)

**状态：**HaluMem 内容披露的历史诊断与提案。报告中的配置、阈值和代码行为不是当前默认值。其 backend 评估没有测量 Agent 是否选择调用工具。下方观察只适用于 2026-08-08 的 `supersession_trial19` run；本次文档审计没有复现。

## 评估对象

报告检查了完整 HaluMem `supersession_trial19` 数据，记录分数为 `0.7352`，当时 embedding 生效。它评估 backend `search()` 输出和 memory-context 披露，**没有**评估 Agent 是否会调用 `nmg_search`、是否根据 headers 调用 `nmg_get`、证据不足时是否继续搜索，或无需记忆时是否弃权。

报告称，导入的 2,329 条记录全是 `tier2 conversation_evidence`。因此，当时要求至少五条 tier-1 记录才会触发的 `warm_halves` 路径没有运行。评估也关闭了 QPP second pass（`NMG_QPP_SECOND_PASS=0`）。Bridge 使用名义 20 条 limit 与 6,000-token budget；报告观察到约 13 条 conversation-evidence 被披露。

## Promotion 案例与观察到的失败模式

针对 “What is Martin Mark's current job title as of June 15, 2033?”，报告的大 budget probe 将 promotion memory 排在 **#34**；评估实际披露的 13 条是 2033-05-10 的无关泛化对话，不包含 2033-04-25 的 “promoted to Executive Director” memory。模型无法从披露上下文中恢复答案。相对地，另一个明确询问 Martin 4 月 25 日 promotion 的 query 将该 memory 排为 **#1** 并披露。

报告将该历史实现的失败描述为三个交互原因：

1. “job title” 与 “promoted to Executive Director” 词法分为零，向量排序也弱；
2. 当时的 QPP 触发器判断意图家族覆盖而非内容相关性，在第一个 query 上提前停止；
3. `hardLimit` 计算仍由 caller limit 限制扩展，尽管注释称 limit 只是 recommended。

这些是带日期的诊断，不是当前 QPP 代码或默认值的声明；请使用下方当前源码与设计 owner。

## 内容披露与能力发现

报告区分了两个互相独立的问题：

- **能力发现：**Agent 是否知道某个工具存在，并选择调用它。
- **记忆内容披露：**调用之后，哪些候选 header 与 exact evidence 对 Agent 可见，以及 Agent 是否继续或停止。

HaluMem backend 轨道从 `search()` 开始，只测量内容披露。原文将 Kimi 动态工具加载作为类比，不是 NMG 与工具 schema 加载属于同一机制的证据。本文不重复该比较中的外部协议细节。

## 历史提案与证据边界

笔记提出重新审视 QPP 扩展上限、在 benchmark 中启用 second pass、改进充分性信号，以及暴露 direct／related selection 信息以便诊断。它还建议未来做 Agent 工具轨迹评估，记录工具调用率、headers 后的证据召回、继续／过早停止行为、token 用量、provider cache 使用、延迟与答案质量。这些都是提案，不是 backend score 已经测量了这些结果的发现。

报告中的 `0.7352` 是所述配置下的扁平披露分数，不是渐进式披露有益或有害的证据。Promotion 排序、预算和功能激活的历史说法必须限定于该样本与代码版本。

## 当前 owner

- [分层披露设计](../../design/tiered-disclosure-design.zh-CN.md)
- [Fibonacci 渐进式召回](../../design/fibonacci-progressive-recall.zh-CN.md)
- [检索置信度控制器](../../design/retrieval-confidence-controller.zh-CN.md)
- 当前检索实现：[`src/core/store/retrieval.ts`](../../../src/core/store/retrieval.ts)

这些 owner 取代 2026-08 笔记中的历史默认值与实现描述。