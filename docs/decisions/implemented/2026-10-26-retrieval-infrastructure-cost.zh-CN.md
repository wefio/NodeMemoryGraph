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
现有渲染证据 token 估算器和精确证据渲染器保持原样；该组装变更没有新增独立渲染器或预算。

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

## 请求内查询准备扩展

daemon 搜索可能针对多个 Store 或重复语义子句调用共享检索入口。
此前每个健康的混合检索分支都会再次对同一文本生成向量。
现在只在本次调用内复用查询准备，保留新鲜的 Store 读取和现有自动期限；
失败与空响应仍可重试。这避免进程级缓存的失效、租户边界与保留成本，
不合并不同查询，也不改变 provider 批次语义。
[检索契约](../../design/design/progressive-retrieval.zh-CN.md#请求内查询准备)拥有生命周期与排除项。

[成对测量](../../experiments/retrieval/request-preparation-2026-10-28.zh-CN.md)
记录 provider 调用数、模拟等待时间与候选严格一致性。
测试覆盖经 `NmgService` 使用真实本地 HTTP provider、读取之间删除、并发消费者、重试和取消。
此次扩展尚未测量真实云端 provider 或完整 recall benchmark；上文 500 题 LME 证据属于此前的组装变更。
