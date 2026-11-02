# Recall 临近上下文与显示模式

[English](recall-context-and-display.md) · [使用的术语](recall-context-and-display.terms.yaml)

**Status:** current
**Related:** [InformationView](state-spaces.zh-CN.md)、[自动召回预算](session-memory-lifecycle-hooks-2026-08-10/automatic-recall-budget.zh-CN.md)

## 候选排序

共享 daemon 搜索路径在检索后、反馈暂存前，对会话关联结果重排。
自动和显式搜索共用排序，显示模式不参与相关性判断。
候选页、规范 ID、分数、检索参数和图引用保持完整；本环节不删除候选、不增加检索上限，
也不额外调用 provider。保留整页意味着整页大小处的 recall 不变，不保证更小截断位置的 recall。

原生回合准入只提供用户消息和项目身份。daemon 为各会话保存有界的临近消息窗口，
助手回复、工具结果和黑板状态不进入该窗口。项目改变时丢弃旧项目消息。
释放会话、缓存淘汰和 daemon 重启会丢弃上下文；显示设置使用独立的 daemon 内存生命周期。

最新请求提供主要词面信号。简短延续请求或与近期主题重叠的请求，可以利用最近的实质用户内容。
无关的新话题不继承旧主题的重叠信号。有界分词忽略纯数字词和长十六进制标识符。
原排名提供稳定先验与同分顺序。词面重叠只是弱排序信号，不是相关性标签或真实性证据。
没有词面重叠的语义匹配仍保留在候选页中，可以按需精确获取。

## 呈现与披露

自动 Recall 使用会话级 `compact` 或 `full` 显示模式。精简模式限制展示条数和正文长度；
全文模式保留检索所得记录正文，仍受组合输出预算约束，不包含原始证据，也不解除上下文限制。
两种模式都遮蔽已遗忘内容。

紧凑投影携带显示模式。共享候选准备在形成 InformationView 条目前按 Unicode 码点截断，
保留引用 ID、图范围、时间标签和预览状态。InformationView 按完整条目准入，并将外层提示计入预算。
即使正文完整，两种模式也都是候选预览；精确记录／证据披露仍走 get 及其收据路径。

Pi 在组合上下文中复用同一候选视图，OpenCode、DSH 和 WorkBuddy 使用共享自动 Recall 准备。
适配层不裁剪最终准备片段，也不将未展示候选计为送达。
界面历史召回与本轮可注入代际分离；缺少新结果不能成为重新注入旧快照的理由。

## 会话控制与验证边界

`sessionActiveGraph action=recallDisplay` 读取模式，提供 `mode=compact|full` 时设置模式。
设置只影响指定会话；重启或显式释放会话后恢复默认精简模式。
近期上下文缓存淘汰不会重置显式选择的模式。普通显式搜索保留既有呈现，get 继续获取选定精确记录。

CLI 用法由[记忆操作参考](../../skills/nmg-memory/references/recall.zh-CN.md)维护。
初始数值与取舍见[决策](../decisions/implemented/2026-10-07-shared-information-output.zh-CN.md#临近上下文与显示模式)。
测试覆盖候选页保留、主题隔离、模式分离、遗忘遮蔽与共享服务接线，
不证明自然对话相关性收益或最终答题质量；后两者需要留出对话评测。
