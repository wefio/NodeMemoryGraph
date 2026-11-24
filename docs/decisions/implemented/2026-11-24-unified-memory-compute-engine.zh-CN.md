# 统一记忆计算引擎与生产流程计算图接管

[English](2026-11-24-unified-memory-compute-engine.md) · [术语](2026-11-24-unified-memory-compute-engine.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [权威关系型 SQLite 存储](2026-11-24-authoritative-relational-memory-store.zh-CN.md)

## 问题

关系型存储迁移完成后，计算图仍仅局限于 `piecewise-rerank.ts`、`http-search-graph.ts` 与独立示例 `retrieval-graph.ts`，存在三方面不足：

1. `MemoryEngine`（`src/core/memory/engine.ts`，1,773 行）把业务编排与具体召回、时间窗扩展、邻域遍历、证据水合、投影和写入变更规划混杂在同一类中。
2. 逻辑计算语义与物理执行计划尚未分层，外部黑盒算子缺少渐进式能力声明与表达下推接口。
3. `ComputeMemoCache` 与图执行器仍需补齐可变输出克隆隔离、基于闭包实例而非源码哈希的身份识别、外部状态戳失效、复合子图动态重算、资源锁波次调度、有界 LRU 容量、引用计数释放及无缓存零哈希快路径。

## 决策

在独立权威存储层之上建立分层统一记忆计算引擎：

1. **契约与渐进式能力模型（`src/core/compute-contracts.ts`）**：定义 `MEMORY_COMPUTE_CONTRACTS`、缺省按 `"opaque"` 保守解析的 `resolveCapabilities`、`ComputeStateStamp` 状态戳工具、五种统一节点实现形态以及 `adaptExternalAlgorithm`。
2. **逻辑–物理执行规划器（`src/core/compute-planner.ts`）**：将 `ComputeGraphSpec` 编译为可缓存的 `PhysicalExecutionPlan`，支持契约绑定、CSE、DCE、`relational_query` 下推改写（`sqlite_pushdown`／`portable_scan`）、可选线性纯链路融合、按资源冲突划分并行波次及消费者引用计数计算。
3. **运行时正确性与快路径加固（`src/core/compute-graph.ts`）**：对可变缓存值通过 `structuredClone` 隔离；使用 `COMPUTE_CACHE_TOKEN`／`WeakMap` 标识闭包实例；校验 `hasRequiredStateStamp` 并传播下游污染标记；为 `graphAsOperator` 动态计算签名与能力；引入默认 512 上限的 LRU `ComputeMemoCache` 与引用计数中间结果释放；未开启缓存时走零哈希快路径。
4. **生产计算图全面接管与清理**：抽离只读快照端口 `MemorySnapshotPort`（`src/core/memory/hydration.ts`）及 `DEFAULT_ENGINE_SEARCH_GRAPH`、`DEFAULT_GET_CONTEXT_GRAPH`、`DEFAULT_NEIGHBORHOOD_GRAPH`、`DEFAULT_PROJECT_GRAPH`、`DEFAULT_USER_PROFILE_GRAPH`、`DEFAULT_REMEMBER_PLAN_GRAPH`、`DEFAULT_LIFECYCLE_PLAN_GRAPH`、`DEFAULT_HTTP_WRITE_PREPROCESS_GRAPH`、`DEFAULT_HTTP_PROFILE_GRAPH`；`MemoryEngine` 收敛为前置校验、快照生命周期与 `mutate`/`commit` 事务编排器；清理已废弃未使用的 `rank-fusion.ts`。
5. **头部增量 `BM25+QTF` 晋升与散文数字 Trigram 收紧**：新增按查询实时重算 `N` / `avgdl` / `df` IDF 的 `incremental_bm25_score`（`src/core/memory/incremental-bm25.ts`），将 `HEAD_QTF_R3_SUBGRAPH`（`bm25_qtf`, `k1: 1.5, b: 0.75, k3: 8.0, weight: 0.1`）设为 `DEFAULT_PIECEWISE_RERANK_GRAPH`（`src/core/memory/piecewise-rerank.ts`，保留 `HEAD_BM25F_R3_SUBGRAPH` 导出）的默认头部子图，并在 `surfaceAnchors`（`src/core/store/search-ranking.ts`）中过滤散文裸数字、序数词、年代与 12 小时制时间词，同时保留中日韩连续片段、代码路径、带点号版本号、错误码与字母数字混合标识符的 trigram 通道匹配。

## 考虑过的替代方案

1. **在保留 `MemoryEngine` 庞大实现的同时并行新增实验计算图**：拒绝，保留两套语义相同流程会导致行为漂移并继续耦合核心引擎。
2. **预先引入重型外部编译框架（如 MLIR/LLVM）**：拒绝，本地部署优先直接复用 SQLite 查询下推与 V8 原生函数执行，避免过早引入复杂度。

## 后果

- 新增检索、重排、预处理和变更规划算子可直接向领域注册表注册而无需改动 `MemoryEngine` 或数据库结构，并由 `tests/core/compute-architecture-guardrails.test.ts` 门禁保护。
- 缺省注解的第三方黑盒适配器在保守 `"opaque"` 边界内安全执行，不会污染前缀缓存或并行波次。

## 延后事项

- 基于运行时 `costHint` 统计的自动多实现代价选择器。
- 超出 `relational_query` 投影下推范围的通用多表 SQL 查询编译。
