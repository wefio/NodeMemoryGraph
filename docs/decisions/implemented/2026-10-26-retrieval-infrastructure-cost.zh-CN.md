# 降低检索组装与 InformationView 准备成本

[English](2026-10-26-retrieval-infrastructure-cost.md) · [使用的术语](2026-10-26-retrieval-infrastructure-cost.terms.yaml)

**Status:** implemented
**Approved:** auto

## 问题

InformationView 每检查一个候选的预算，就重新拼接完整的已纳入输出。
直接检索和节点检索则为每条返回记忆分别读取关联与历史行。
两种成本都随提供给读者的证据量增长。

## 决策

优化现有 `prepareInformationOutput` 和存储结果组装路径。
输出准备增量维护字符计数，复用各来源指纹；存储组装通过有界 SQL 连接批量读取关联历史。

契约继续归属[状态展示](../../design/state-spaces.zh-CN.md#统一上下文信息项)
和[检索证据组装](../../design/design/progressive-retrieval.zh-CN.md#证据组装)。
现有渲染证据 token 估算器和精确证据渲染器保持原样；本次没有新增独立渲染器、预算或缓存。

## 考虑过的替代方案

- 逐候选重新渲染：实现简单，但大视图被重复复制成本主导。
- 缓存完整输出：需要处理来源变更失效；增量计数只需要请求内状态。
- 只在最终 AG 页补齐证据：可能继续节省成本，但会影响检索中间阶段检查来源的消费者。
  在原组装边界批量读取可保留这些消费者的行为。

## 后果

计数必须正确处理分隔符、分组包装和省略回收。边界测试覆盖这些情况，
包括加入条目后包装反而变短的 AG/board 混合状态。
证据测试覆盖顺序、共享来源、空结果、缺失历史与批次边界。

[离线测量](../../experiments/retrieval/infrastructure-performance-2026-10-26.zh-CN.md)
记录了输出哈希和重复运行，证明本地成本下降；独立的 LME 全量成对检查证明
500 题的 recall@20 与输出保持不变。两者均不证明召回提升或完整答题、判分管道提速。
