# 实现边界（部分实现，不是系统完成）

[English](implementation-boundary.md) · [术语](implementation-boundary.terms.yaml)

**Status:** draft
**Authority:** [上层范围](../agent-convergence-feedback-design.md)。

## 实现边界（部分实现，不是系统完成）

第一段代码切片只实现：

- `src/rcp/session-feedback.ts`：一个通过校验的 receipt 在显式具名的会话/任务帧中变成有界的临时工具观察。CLI opt-in 使用 `reconcile ... --nmg optional --session-id <id> --task-frame-id <id>`，并要求一个已在运行且兼容的 daemon。它不启动/停止 daemon、不写持久记忆、不把任务标记为完成、也不训练路由。receipt 投递失败属于诊断信息，不改变验证者的决定。plan 模式与幂等的 receipt 复用不发出新通知。AG 可见性仍遵循既有的激活/披露生命周期。
- `src/lab/context-router.ts`：一个隔离的 132 参数动作价值原语，使用既有自动微分底座、允许动作选择、带倾向的显式 epsilon 采样、脱离权重的导出，以及已观察动作的回归。它未接入自动召回、未作为新的 Lab 租约暴露，也不是已训练或已启用的策略。结果准入仍是调用方的责任；任意数值奖励不是经核验的证据。

`tests/rcp/session-feedback.test.ts` 在受控 fixture 中演练真实的失败 npm 验证、receipt/contract 绑定、重复投影、会话隔离、中断处理、plan 行为，以及 CLI 到 daemon 的 HTTP 投递。`tests/core/context-router.test.ts` 覆盖该小头部在解释执行与编译执行两种方式下的行为。这些测试确立它们所演练的机制，不确立自然任务成功、收敛或因果干预收益。

随后一个进程内研究边界 `src/lab/context-intervention.ts`，在请求调用方提供的独立证据验证者准入之前，先校验带版本的 decision/execution/outcome 信封。natural、benchmark 与 synthetic 三种来源始终显式。影子选择、被取消/超时的执行、scope/version 不匹配、被重新打开的结果、无效窗口与缺失证据都不能产生被准入的行。它不是 receipt 校验器、JSON 解析器、持久事件收集器或自动训练路径；对 harness 而言，认证外部证据仍是其自身责任。

当自然样本稀少时，benchmark 任务可提供标定数据。先执行干预再给它打标签；仅凭官方答案不是反事实的动作结果。把完整的源任务/对话切分到训练、调参与留出评测，并让 benchmark 结论只限定在该分布内。在加入显式历史统计量、循环低维状态或历史节点连接之前，先比较固定规则与线性基线。这些历史架构没有一个被本准入边界实现或选中；设计仍可依测量证据修订。

下一段实验切片实现 `context-features.ts`（带版本的值与缺失掩码）、`context-executor.ts`（有界固定动作适配器）与 `context-trial.ts`（先决策后执行的 await 汇聚点与结果准入）。`context-journal.ts` 提供有界的单写者 append/fsync 日志，带阶段/身份检查、拒绝重复执行与重放；过期的锁或撕裂的尾部需要操作员检查，而不是自动恢复。`evals/controller-shadow/context-dataset.ts` 重放修订、拒绝决策身份碰撞、撤回被重新打开的标签，并按调用方提供的来源组分区。这些是显式的 harness API，不是自动的 Pi/AG 驱动。自定义 LoCoMo 上下文探针演练全部四种动作，并只在训练组上训练一个线性头。它的仅证据指标不是答案准确率；见[组件报告](../../experiments/context/router-component-2026-09-06.zh-CN.md)。

仍未完成：通用生命周期生产者、生产恢复编排、主模型暴露集成、外部证据验证者适配器、定位书签内容摄入、长期任务延续、端到端留出任务，以及默认启用闸门。[上层范围的实现边界](../agent-convergence-feedback-design.md#implementation-boundary-partial-not-system-completion)规定了总体限制；本文不主张这些集成已实现。原始理论仍是暂定的，生命周期事实/SimHash 也不是普适无偏的奖励。不要因本切片而关闭整体实现任务。
