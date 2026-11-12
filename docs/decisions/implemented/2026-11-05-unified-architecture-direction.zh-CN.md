# 分离记忆后端、本地协作与 Harness 集成

[English](2026-11-05-unified-architecture-direction.md) · [术语](2026-11-05-unified-architecture-direction.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [目标架构](../../design/unified-architecture.zh-CN.md)、[共享会话流程](2026-10-16-shared-session-flows.zh-CN.md)

## Problem

组合 Store 同时暴露记忆与协作职责。云端路径在对象存储中保存 SQLite 快照；宿主集成已共享部分会话流程，但尚无明确统一的共享集成边界。把 SQLite 快照视为唯一对象存储设计，无法形成独立、可替换的后端。

## Decision

已接受的方向划分四个边界：记忆引擎、可替换的记忆后端、本地 SQLite 协作，以及共享 Harness 集成层与宿主绑定。[可替换后端配置](../../design/unified-architecture/native-backends.zh-CN.md)定义有界实现；完整目标仍受验证门槛约束。

SQLite 与原生对象存储实现同一份领域存储合同。NMG 保留图组织与记忆语义。后端可以提供检索，不要求保留 NMG 的文本／向量实现。LanceDB 是首个验证对象，SlateDB 是后备底座。[目标设计](../../design/unified-architecture.zh-CN.md)拥有合同与采用门槛。候选优先级不等于已经验证的库选型或部署承诺。

pi durable 是选定的云端 Harness。其 NMG 绑定与本地宿主共享集成行为，使用认证云端记忆端点。Harness 拥有持久执行；NMG 拥有记忆语义。[Harness 集成设计](../../design/unified-architecture/harness-integration.zh-CN.md)拥有恢复与外部效果合同。接受方向不构成兼容性证据，也不引入云端 NMG 协作服务。

Magpie 是额外的网关集成候选。[Magpie 设计](../../design/unified-architecture/magpie-integration.zh-CN.md)区分自动召回与显式工具接入，并将完成采集限制在宿主尽力通知的合同内。它不替代 Harness，也不表示完整原生插件能力覆盖。

后续[管理面板草案](../../design/unified-architecture/magpie-operations.zh-CN.md)借用 Magpie 现有 UI 展示 NMG 统计和向量设置，再将网关观测与原生绑定组合。库／配置继续归共享服务，使其他 UI 也能复用。草案不表示指标、管理 API 或 Magpie 适配器已交付。

[固定版本接口映射](../../design/unified-architecture/magpie-capabilities.zh-CN.md)用 Magpie `0.1.3545` 源码和各原生适配器接线支撑该草案，优先复用网关向量传输，避免复制上游 key。功能对齐覆盖每个适配器的 NMG 缺口，包括工作状态承载、工具接续、归因／反馈和黑板投递；GUI、用量与追踪属于独立增强。原生生命周期所有权保持完整，源码核对不替代运行联调证据。

能力覆盖由客户端已连接的原生适配器、MCP、hook、CLI／Skill 与 Magpie 共同组成。[共享组合模型](../../design/unified-architecture/harness-integration.zh-CN.md#组合各接入点的能力)按操作分配提供方并保留明确缺口，避免要求 MCP 或 Magpie 独自成为完整 Harness，允许通过受支持交接组成覆盖更广的流程。这是设计方向，组合运行覆盖仍需联调证据。

Magpie 补齐其他适配器的角色不缩减自身插件界面。插件目标是在受支持宿主接口内提供完整、可独立使用的 NMG 集成。组合只选择启用提供方与效果所有者，保留重叠实现，将插件完整性与会话去重分开；独立与组合行为都需要证据。

DSH 目标是当前宿主包，历史 preset 不作为并行功能对齐目标。缺口分析区分 NMG 接线未完成、宿主路径待验证和已证明宿主限制。DSH／OpenCode 原生上下文与工具／事件 hook 仍是实现候选，缺少 NMG 接线不证明宿主需要网关才能提供该能力。

[原生能力核实](../../experiments/runtime/native-plugin-capabilities-2026-11-12.zh-CN.md)复用既有 OpenCode 矩阵与 smoke 记录。DSH 核心服务探测确认动态上下文及最终工具通知，OpenCode 私有 API 在 prompt 前返回会话目录，因此原生功能对齐独立于网关部署。新一轮 OpenCode 插件激活、原生生命周期边界及 NMG 组合行为继续保留验证门槛。

## Alternatives considered

- 强制把本地记忆和协作拆成两个数据库文件：没有物理隔离要求时会增加配置；默认在一个本地 SQLite 文件中保持独立所有权。

- SQLite 快照作为对象后端：可以复用数据库行为，但不满足独立原生对象路径的要求；既有格式保留为迁移源。
- NMG 自建全部对象事务与索引：在充分评估复用前就承担恢复、压缩和检索维护；优先采用满足领域合同的现成引擎。
- 所有后端使用同一检索实现：保留的是物理实现而非图语义，妨碍复用已有检索。
- 优先选择 SlateDB：更接近事务 KV 底座，但留下更多检索工作；用户接受后端提供检索，因此先验证 LanceDB。
- 将协作扩展至分布式对象存储：引入超出仅本地要求的远程协调。
- 分别重写每个宿主插件：重复会话策略，没有延伸既有共享流程方向。
- 将 Magpie hook 当成完整 Harness 适配器：客户端仍拥有工具和执行，完成通知也不持久；保留网关专有能力子集。

## Consequences

纯本地 SQLite 配置中，记忆与协作默认使用服务的同一数据库文件，接口与表的所有权仍分别管理。

显式启用的 Node 实现固定 LanceDB 0.41.0，把领域实体和凭据放在同一暂存原生分支，通过 head 版本条件更新发布完整分支，避免把独立 Lance 表更新误当成跨表事务。SQLite 使用自身事务与 WAL 快照实现相同提交接口。此配置接受原生全文检索。条件 S3 发布通过原生 HTTP 驱动测试；服务商部署与成本验证仍是独立门槛。

依赖树将 `sharp` 覆盖为 0.35.5，以修复间接原生图像依赖的安全通告；Lance embedding 集成需要单独验证兼容性。

显式应用选项选择后端，不转换既有数据库，也不替代默认／AML 路径。board／run 事务保留本地，run 协调器接收窄化协作接口。共享 Harness 端点绑定负责会话 generation、方法检查和由稳定 invocation 派生的写入 ID；具体宿主插件仍须通过单独接入门槛。配置契约与限制见[可替换后端](../../design/unified-architecture/native-backends.zh-CN.md)。

共同抽象包含读取、查询、图访问与提交，不是通用对象 `put`。库是否适用取决于完整变更的原子性与部署环境。允许后端专有排序，身份、可见性与图语义保持不变。实现切片通过门槛前，本地 SQLite 默认和既有公开工具继续生效。

## Deferred

生产库选型、服务商／运行环境部署、基准、分支回收与压缩、迁移演练、云端交互 API 及具体宿主插件仍需进一步证据。本决策不授权生产部署或用户数据库转换。
