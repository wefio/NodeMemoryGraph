# 分离记忆后端、本地协作与 Harness 集成

[English](2026-11-05-unified-architecture-direction.md) · [术语](2026-11-05-unified-architecture-direction.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [目标架构](../../design/unified-architecture.zh-CN.md)、[共享会话流程](2026-10-16-shared-session-flows.zh-CN.md)

## Problem

组合 Store 同时暴露记忆与协作职责。云端路径在对象存储中保存 SQLite 快照；宿主集成已共享部分会话流程，但尚无明确统一的 Runtime 边界。把 SQLite 快照视为唯一对象存储设计，无法形成独立、可替换的后端。

## Decision

已接受的设计方向划分四个边界：记忆引擎、可替换的记忆后端、本地 SQLite 协作，以及共享 Harness Runtime 与宿主绑定。本记录落实架构方向决策并发布其设计所有者，不表示后端重构已经交付。

SQLite 与原生对象存储实现同一份领域存储合同。NMG 保留图组织与记忆语义。后端可以提供检索，不要求保留 NMG 的文本／向量实现。LanceDB 是首个验证对象，SlateDB 是后备底座。[目标设计](../../design/unified-architecture.zh-CN.md)拥有合同与采用门槛。候选优先级不等于已经验证的库选型或部署承诺。

## Alternatives considered

- SQLite 快照作为对象后端：可以复用数据库行为，但不满足独立原生对象路径的要求；既有格式保留为迁移源。
- NMG 自建全部对象事务与索引：在充分评估复用前就承担恢复、压缩和检索维护；优先采用满足领域合同的现成引擎。
- 所有后端使用同一检索实现：保留的是物理实现而非图语义，妨碍复用已有检索。
- 优先选择 SlateDB：更接近事务 KV 底座，但留下更多检索工作；用户接受后端提供检索，因此先验证 LanceDB。
- 将协作扩展至分布式对象存储：引入超出仅本地要求的远程协调。
- 分别重写每个宿主插件：重复会话策略，没有延伸既有共享流程方向。

## Consequences

共同抽象包含读取、查询、图访问与提交，不是通用对象 `put`。库是否适用取决于完整变更的原子性与部署环境。允许后端专有排序，身份、可见性与图语义保持不变。实现切片通过门槛前，本地 SQLite 默认和既有公开工具继续生效。

## Deferred

最终库／SDK 版本、原子数据表示、受支持原生运行环境、基准、迁移演练、数据库文件拆分与双宿主 Runtime 集成仍需证据。本决策不授权生产部署或用户数据库转换。
