# 权威关系型 SQLite 存储与计算图解耦

[English](2026-11-24-authoritative-relational-memory-store.md) · [术语](2026-11-24-authoritative-relational-memory-store.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

过渡期关系重构仍把 `nmg_memory_entities`（JSON 大对象表）保留为隐藏的运行时权威存储，并向关系表同步双写，遗留三项风险：

1. 关系行反序列化未完整还原扩展字段（`truthStatus`、`extractMethod`、`claims`、`evidenceRole`、`writeReason`、`writeSource`、`openedAt`、`promotedAt`、`retentionChangedAt`、`quarantineUntil`、可空 `sourceSessionId`、有序 `markers` 与多对多 `evidenceIds`），无法安全切换到单源权威读取。
2. 撤回、`forget` 标记与 `quarantine`／`dormant` 保留状态变更必须在一次写入或状态流转内同步清理派生 FTS5、向量索引并降级关系边。
3. 算法模块（`bm25f-neighborhoods.ts`、`ComputeGraph`）仍存在跨层工具依赖，且缓存与调度尚未隔离可变对象、带副作用算子与异步波次并行。

## 决策

SQLite 记忆存储全面切换为以规范化关系表为唯一权威数据源（`nmg_sources`、`nmg_nodes`、`nmg_memories`、`nmg_memory_evidence`、`nmg_memory_relations`、`nmg_memory_markers`、`nmg_tesserae`、`nmg_state_aliases`、`nmg_write_events`、`nmg_relation_proposals`、`nmg_claim_posteriors`、`nmg_claim_outcomes`、`nmg_resolution_events`、`nmg_receipts` 与 `nmg_schema_migrations`）：

1. **零运行时 `nmg_memory_entities` 依赖**：常规读写、批量扫描、凭据、记忆链投影、叶上下文、FTS5／向量补齐与调试视图全部只读写关系表。`src/core/memory/sqlite-entity-migration.ts` 是唯一兼容读取模块；打开未迁移旧库时在单事务内执行版本化导入、校验各类行数、写入 schema version 2 后删除旧表；`openLocalMemory` 在发现 `nmg_memory_entities` 时先生成经过校验的 SQLite 备份。
2. **严格区分原始与恢复来源**：`nmg_sources.source_kind` 区分真实转录原文（`raw`）、显式写入合成来源（`explicit`）以及仅记录空内容的孤儿补齐（`missing_recovered`），绝不伪造原文证据。
3. **无损往返与派生传播**：`hydrateMemoriesFromRows()` 完整还原所有 `MemoryRecord` 字段、有序标记、显式关系与有序证据引用。删除、撤回、`forget` 标记及 `quarantine`／`dormant` 状态会立即清理 FTS5 与向量（含分块向量）并降级关联边；`rebuildDerivedIndexes()` 可在索引损坏后直接从关系表重建。
4. **按需图投影**：`projectGraph()` 先在 SQL 完成多条件筛选、排序与分页，再在内存中构图并标明边的 `authority`（`"explicit" | "inferred"`）与 `provenance`，同时显式返回跨页 `boundaryRelations` 与 `page.truncatedRelationCount`。
5. **存储与算法严格解耦**：纯日期规范化函数迁移至 `src/core/memory-normalization.ts`，算法与计算图模块零导入 SQLite 模块。`ComputeRegistry` 支持算子 `version` 与 `sideEffect` 元数据，`ComputeMemoCache` 对未深冻结的可变输入／输出及 `sideEffect` 节点跳过缓存，异步执行器按拓扑波次并行执行。

## 考虑过的替代方案

1. **长期维持双写与读取适配层**：拒绝，因为双写放大写入开销，保留了隐蔽的 JSON 解析路径，并存在主从不一致风险。
2. **旧库缺失证据时写入占位文本替代原文**：拒绝，会混淆真实原始证据与恢复元数据。
3. **跨页图投影始终加载全库边表再分页**：在 `projectGraph` 有界查询中延后采纳；通过返回显式 `boundaryRelations` 与截断计数既保持 SQL 分页延迟，又避免静默丢失跨页边。

## 后果

- 即使完整移除或替换 `ComputeGraph` 与重排算子，NMG 仍可依托 SQLite 权威关系库独立完成记忆持久化、更新、迁移、导出与恢复。
- `sqlite-relational.ts` 的节点邻边查询显式使用 `INDEXED BY nmg_memory_relations_edge_source`／`nmg_memory_relations_edge_target`，确保小表和大表下均走边索引而非主键扫描。
- `onlion/package.json` 中的 `--experimental-transform-types` 脚本保持原样以适配 CI 的 Node 24 运行时；本地 Node 26 通过直接执行对应 `.mjs` 测试脚本完成等价验证。
