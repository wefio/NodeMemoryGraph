# 未决设计问题

[English](open-design-questions.md) · [使用的术语](open-design-questions.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## 未决设计问题

- 未来的确定性 gate 能否识别哪些窄任务适合使用显式 reasoning workspace，同时不把它注入普通 turn？
- 哪些经过测量的歧义度/覆盖率阈值，足以支持创建或细化 node？
- 哪种反馈能证明检索到的 memory 有用，同时不强化 router 自己先前的选择？
- 怎样的 STG 保留、过期与降级策略，能在保留有用临时信息的同时避免 STG 变成第二个无界归档？
- 估算 edge 稳定性时，什么算独立 task 或 source？如何降低来自同一 session 的重复证据权重？
- 哪种稳定性阈值、证据覆盖率和 hysteresis margin 足以支持将局部子图合并到 LTG？
- 应如何根据独立自然结果校准已实现的 Active Graph budget allocator 和 marginal-gain 停止信号？
- 应如何根据独立结果证据校准 QPP1 depth 和 QPP2 retained mass，而不是依赖 benchmark 标签或 controller 自己先前的选择？
- 已实现的逐 turn 构建预算（三次 search、search/get 总计五次调用、exact-evidence progression 和 no-gain stopping），对真正的多部分自然查询而言，是否在 precision/cost 之间取得合适平衡？
- 达到多少 node/leaf 数量后，exact contiguous vector scan 将无法满足端到端延迟预算？
- 什么 privacy/delete interface 能移除原始证据及其所有派生 summary、cache 和 learned signal？