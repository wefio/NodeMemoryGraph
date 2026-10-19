# 神经门控的历史提案与反馈观察（2026-09-07）

[English](recall-neural-gate-2026-09-07.md) | [简体中文](recall-neural-gate-2026-09-07.zh-CN.md) · [术语](recall-neural-gate-2026-09-07.terms.yaml)

**状态：**历史提案，不是已采纳的产品设计。原记录还包含一项有日期的反馈生成观察。未经检查当前 owner，不应将其预探针／神经门控提案或 2026-09 数量视为当前行为。

## 提案：判断廉价探针是否值得披露

原记录指出关键词优先的 auto-recall gate 有一个局限：若某回合没有意图关键词，系统可能在检查库中是否存在有用记忆前就将其路由到 `none`。提案是在决策前运行一个小规模 FTS top-k 预探针，再决定维持 `none`、注入少量 `cue`，或进行更完整的 `retrieve` 披露。其成本区分是：词法探测便宜；语义扩展和上下文注入则带来更多延迟、token 与干扰成本。

拟议决策会结合预探针证据、现有意图分类、回合／session 上下文和既往反馈。它明确区分回合级“要不要注入任何内容？”决策与 QPP／QPP2 等逐项排序或披露机制。建议先做 shadow 测量，再考虑任何 actuation，且不另造独立的第二个 gate 模型。

## 额外研究接缝：候选池全局上下文

另一节提出为逐项候选池决策增加低维“virtual node”或 global-view channel，同时认为它不适用于回合级 gate。原文将其标为实验性，无代码，也不承诺实现。原文建议的触发条件是：有证据表明同一 memory 在不同候选池中的效用会变化；之后先 shadow，再与独立的逐项评分比较。

## 有日期的反馈生成观察

原记录称，2026-09-07 用户指出真实会话中 `nmg_remember(action=feedback)` 调用为零；作者表示已核实，`context-router-online.json` 中唯一一行来自手动 HTTP 测试。原文将其与更早的 125 条 controller-shadow feedback 记录对比（据原文为 109 条 natural、16 条 controlled），这些记录由 feedback nudge 生成。

这是有日期的观察，不是当前计数。原文列出的选项——一次性 nudge、保守的可观测结果标签、稀疏 LLM 自评——都是提案；其推荐组合不等于已获批准或已实施。原文明确指出，单靠 answer overlap 不足以伪造 usefulness 标签。

## 当前 owner

- [检索置信度控制器](../../design/retrieval-confidence-controller.zh-CN.md)
- [反馈循环设计](../../design/feedback-loop-design.zh-CN.md)
- [当前检索与 gate 实现](../../../src/core/gate.ts)
- [控制器与反馈实现](../../../src/lab/)

当前行为请查阅这些 owner 和现行测试。原有外部研究综述及里程碑计划不在此重复：它们是有时效性的探索，不是 NMG 实现证据。