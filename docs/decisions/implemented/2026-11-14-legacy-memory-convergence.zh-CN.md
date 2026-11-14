# 默认入口切换前先演练图数据迁移

[English](2026-11-14-legacy-memory-convergence.md) · [术语](2026-11-14-legacy-memory-convergence.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [架构方向](2026-11-05-unified-architecture-direction.zh-CN.md)

## 问题

两条记忆路径的领域行为和物理表结构不同。把旧记忆作为新写入重放会丢失标识、引用和历史关系。本地协作有自己的生命周期，可以与记忆共用一个 SQLite 文件。

## 决策

逐步收敛领域规则，并用一致的旧图快照验证两个后端。迁移演练保留标识，在一次有界提交内发布。SQLite 专有查询和行解码由 SQLite 代码负责。本地协作通过看板、运行和活动接口调用，纯本地继续共用 SQLite 文件。

## 考虑过的替代方案

- 使用 remember 重放旧陈述。这样会分配新标识，并把当前写入策略应用到历史数据。
- 基础读取和检索可用后立即切换。迁移、能力对齐和恢复由后续验证承担。

## 后果

显式启用的[演练和差异对照](../../design/unified-architecture/legacy-graph-migration.zh-CN.md)覆盖一部分图数据和行为。完整迁移和行为门槛决定后续何时切换默认入口、何时移除旧记忆 mixin。
