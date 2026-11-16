# 默认入口切换前先演练图数据迁移

[English](2026-11-14-legacy-memory-convergence.md) · [术语](2026-11-14-legacy-memory-convergence.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [架构方向](2026-11-05-unified-architecture-direction.zh-CN.md)

## 问题

两条记忆路径的领域行为和物理表结构不同。把旧记忆作为新写入重放会丢失标识、引用和历史关系。本地协作有自己的生命周期，可以与记忆共用一个 SQLite 文件。

## 决策

逐步收敛领域规则，并用一致的旧图快照验证两个后端。迁移演练保留标识，在一次提交内发布。本地完整演练在 SQLite 副本的空命名空间专门执行，并保存原审计、状态键别名和文件引用。SQLite 专有查询和行解码由 SQLite 代码负责。本地协作通过看板、运行和活动接口调用，纯本地继续共用 SQLite 文件。

SQLite 在导入并隔离旧表写入的同一事务中发布启用标记。标记属于对应的 SQLite 文件。项目换一个 daemon 打开时，仍沿用文件已有的命名空间和记忆标识。Codex 状态和披露由共享会话运行时处理，项目召回读取统一后端。

SQLite 启用时保留记录向量及模型标识，并读取既有节点和叶块投影。统一引擎通过候选接口融合结果。宿主调用 provider 并分批处理缺失记录，SQLite 在调用返回后写入向量。

## 考虑过的替代方案

- 使用 remember 重放旧陈述。这样会分配新标识，并把当前写入策略应用到历史数据。
- 基础读取和检索可用后立即切换。迁移、能力对齐和恢复由后续验证承担。

## 后果

[演练和差异对照](../../design/unified-architecture/legacy-graph-migration.zh-CN.md)覆盖跨后端的有界图和本地完整副本。待迁移的数据库继续使用旧配置，启用后的 SQLite 保留旧表供恢复使用。
