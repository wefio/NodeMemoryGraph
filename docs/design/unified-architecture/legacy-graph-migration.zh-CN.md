# 旧记忆语义收敛与图数据迁移演练

[English](legacy-graph-migration.md) · [术语](legacy-graph-migration.terms.yaml)

**Status:** current
**Authority:** [统一架构](../unified-architecture.zh-CN.md#验证与迁移门槛)

## 行为与格式对照

既有入口通过 `NmgService` 调用 `NmgStore` 及其写入、检索、图与维护 mixin。显式启用的新路径由 `MemoryEngine` 通过 `MemoryBackend` 使用 SQLite 或 LanceDB。

| 职责 | 既有路径 | 统一引擎与剩余差异 |
| --- | --- | --- |
| 写入准入与默认值 | 服务执行准入，登记拒绝和显式绕过，补齐真实性默认值。Store 规范化标记并推导临时驻留。 | 共用准入、标记和默认驻留规则。两条服务路径对结构化证据中的凭据都返回 `WRITE_REJECTED`。引擎标记绕过。旧审计事件和完整写入元数据仍需对齐。 |
| 证据 | History 表按会话和来源消息去重，记忆有主证据和附加关联。 | 证据是实体，记忆载荷保存证据引用。演练保留证据 ID；新写入还需对齐来源消息复用和冲突处理。 |
| 去重与状态 | 按范围做 SQL 精确去重和近期规范化匹配，支持可选裁决、近似建议、状态键别名和替换。 | 规范化精确去重、按范围替换、更新证据角色。别名及其推断规则、候选策略、历史和时间边界仍有差异。 |
| 节点身份与图 | SQLite 图表保存节点、重定向、合并／拆分、证据和关系元数据。 | 节点／边载荷和有界图扩展。按名称复用活动 LTG 节点，包括迁入的旧 ID。拼写变体、临时节点身份、拓扑变换和检索规则仍有差异。 |
| 检索 | SQLite 查询和索引提供候选，支持范围／来源角色和时间过滤、向量／FTS、会话 AG 和历史。 | 当前词法检索、精确读取、范围／层级／会话约束和图扩展。后端可以有不同排序。SQLite FTS、索引维护和 SQL 留在 SQLite 实现，语义过滤和图规则由引擎负责。 |
| 生命周期与附属记录 | 删除、标记、晋升、保留、chain、tesserae、反馈、会话、审计及投影。 | 撤回和当前可见性。演练只迁移领域数据，生命周期和依赖记录仍需迁移或兼容路径。 |
| 物理格式 | SQLite 的 `memory_records`、`memory_nodes`、`history_records`、`memory_evidence_links`、`node_relations` 和附属表。 | SQLite 使用命名空间、实体与 FTS 表，Lance 使用实体数据与发布版本指针。两套后端均能保留原节点、记忆、证据和边 ID。 |
| 本地协作 | Task Board、run、事件和活动由 Store 在 SQLite 保存。 | 服务与编排依赖窄协作接口，既有本地 SQLite 实现继续持有这些数据。SQLite 同时承载记忆时，两组表使用同一个文件。 |

## 图数据演练

用当前旧版 SQLite 文件的可丢弃副本，调用 `src/core/store/legacy-memory-snapshot.ts` 的 `readLegacyMemorySnapshot(path)`。它在只读事务中读取一致快照，无需升级数据表。把返回的实体交给 `src/core/memory/graph-import.ts` 的 `importMemoryGraph(backend, entities)`，目标可选 SQLite 或 LanceDB 的空命名空间。使用 SQLite 时，演练可以沿用含源数据和 Task Board 的副本文件。

演练在一次提交中原子发布，最多 512 个实体。它保留 ID、节点和边字段、主证据和附加证据、时间字段、状态、替换链以及图内引用。遇到悬空引用、跨会话的私有证据或记忆引用、休眠／隔离记录、节点重定向或已使用的目标，会拒绝导入。重试同一快照返回已有凭据。演练只处理可信的领域数据，协作表和附属表留在源端。

[迁移契约测试](../../../tests/core/legacy-memory-migration.test.ts)在两个后端读回实体，验证当前状态与会话可见性、沿原有边扩展，以及在原节点续写状态替换链。导入后继续读取原 Task Board，且源图数据保持一致。迁移测试使用 Lance 原生本地对象，S3 协议由独立后端夹具覆盖。

## 默认入口切换条件

先对齐上表涉及默认入口的能力与行为，用代表性的旧库和项目／会话 STG 库验证。迁移还需覆盖生产规模和附属记录，并验证重启、源端写入隔离及新写入发生后的恢复方案。通过[迁移门槛](../unified-architecture.zh-CN.md#验证与迁移门槛)后再切换默认入口，待剩余调用方迁出再逐步删除旧 mixin。显式配置可独立用于验证。
