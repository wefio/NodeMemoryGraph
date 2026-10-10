# 按 SQL 占位符顺序绑定 hybrid 候选

[English](2026-10-10-hybrid-sql-bind-order.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [借用 Float32 打分载荷](2026-10-09-borrow-float32-scoring.zh-CN.md)

## 问题

Hybrid 在 `WHERE` 与 `ORDER BY` 中重复使用词法候选 ID。第二组 ID 绑定在时间和 scope
参数之前，但对应占位符在这些过滤条件之后。有效 FTS 命中可能消失；受控的时间窗口用例
也出现了窗口外记录。尚未量化生产影响范围，空结果相等不能证明路径正确。

## 决策

第二组 FTS ID 绑定在所有时间/scope 参数之后、行数上限之前。SQL 谓词、候选边界、词法
优先表达式、打分权重、向量表示及公开 API 不变。保留 SQL 过滤，不以评分后的补偿过滤修复。

[Store 契约](../../../tests/core/store/hybrid-bindings.test.ts)覆盖正向 FTS 命中，分别检查
无过滤、单侧/双侧时间界、多键 scope 及组合；验证边界包含、字段缺失、排除条件、重复排序
和公开二次检索上下文，并保留 FTS-only、vector-only、无命中 hybrid 回退及 forced-candidate
对照。[打分等价契约](../../../tests/core/store/vector-scoring.test.ts)直接比较正命中的 hybrid
结果，不再仅以无 FTS 命中的回退路径作对照。

## 考虑过的替代方案

- 关闭词法优先或强制只走语义检索：以改变候选行为规避缺陷，而非修复绑定。
- 调换 SQL 子句或评分后过滤：不符合 SQL 语法或先过滤再限额的契约。
- 为整个查询引入命名参数设施：超出移动错位列表所需范围；回归矩阵保护当前调用边界。
- 比较错误路径和修复后的耗时：可检索输出不同，不能作为优化收益。

## 后果

修复前六个正向用例失败，修复后通过；回退与 forced 路径仍执行相同约束。
上下文用例显式设 `qppThreshold: 1` 请求扩展，不把最大结果数误当作覆盖 QPP 合理早停的要求。

正确性恢复后，[上下文级观察](../../experiments/retrieval/hybrid-context-scoring-2026-10-10.md)
在同一个已修复查询上比较普通数组解码与 Float32 借用打分。结果只是合成负载的 store 级
耗时和精确输出等价证据，不代表真实 LoCoMo/Qwen、RPC/harness、部署或最坏耗时收益。
