# NMG 设计基线

[English](design.md) · [术语](design.terms.yaml)

**Status:** current — 0.11：核心持久化稳定；会话 Active Graph 运行时核心已实现
**Updated:** 2026-10-16

## 定义

Node Memory Graph（NMG）是面向长期运行 Agent 的 local-first 长期记忆组件。它保留不可变历史证据，从中派生可变语义记忆，并渐进披露当前任务所需的上下文。

NMG 将物理记忆驻留与运行时暴露分开：

- **Short-Term Graph（STG）** 属于一个 Agent session，保存新增、暂定、任务局部或尚未巩固的语义信息；
- **Long-Term Graph（LTG）** 是唯一的共享图，保存持久原子记忆和已巩固的语义结构；
- **Active Graph（AG）** 是会话私有、归该 session 所有、可变且严格驻留内存的运行时图。它维护从该 session 的 STG 与共享 LTG 共同选择出的有界工作集，以及临时工具状态、任务 frame、激活元数据和推理产物；
- **ProjectionRevision** 是从 AG 冻结出的不可变、有预算的模型可见快照，界定一次检索／披露／反馈边界。

AG 不是第三个权威或共享记忆图。对 AG 唯一强制的物理要求是：图本身驻留内存，并随所属 session 释放；持久事实与来源信息仍由 STG/LTG 保存。Agent 不会写入共享 AG 或 STG：持久协作通过获准的 LTG 记忆完成；临时协作通过独立的 Task Board 完成，再投影进每个调用者的私有 AG。设计理由和迁移合同记录在已实现的[会话 Active Graph 决策](../decisions/implemented/2026-08-29-session-active-graph-runtime.zh-CN.md)中。

> **独立参考：** STG/LTG/AG 模型、理论脉络（Atkinson–Shiffrin 1968、Complementary Learning Systems 1995、ACT-R/SOAR、MemGPT/Letta）、暂定记忆规则、晋升／降级阈值和实现状态，集中在[memory-graphs.md](memory-graphs.zh-CN.md)。本文件保留规范模型；细节移至独立文档。

首要集成目标是 Pi Agent Harness。Pi 拥有模型循环、session 生命周期、工具和 UI；NMG 拥有持久记忆、来源信息、检索和记忆维护策略。NMG 不是 Agent Harness、沙箱或云平台。

仓库开发编排也在 NMG daemon 之外。run-to-completion Repository Control Plane 位于本仓库，可通过可选客户端适配器使用 NMG，但依赖方向严格为 `Repository Control Plane -> NMG client -> NMG daemon`。Git 合同、仓库观察、验证 receipt、pull request 状态和 merge readiness 属于 control plane 或 forge，不会成为 STG/LTG 真值；NMG daemon 也不会调度或协调仓库工作。显式 RCP client 可通过既有 AG RPC，将经过验证的 receipt 作为有界 `tool_observation` 反馈投影进具名 session/task frame。这不会推断 quest 已完成、准入训练 reward 或将验证权移交给 NMG；完整证据仍在 receipt 中。已实现核心和延期边界见[ci-cd-and-quality.md](ci-cd-and-quality/repository-control-plane.zh-CN.md)及已实现的[Repository Control Plane 决策](../decisions/implemented/2026-08-29-repository-control-plane.zh-CN.md)。

NMG 有两个刻意区分的界面：

- **NMG Lite** 是默认产品界面：零配置 Pi 插件、SQLite、小型模型侧 API，以及供可选控制器使用的免框架可微计算底座。
- **NMG Lab** 包含非默认能力，例如图路由、自适应层级、ANN、学习型路由和拓扑细化。Lab 是选择加入的产品通道，不是永久隔离区：Agent profile、Harness、operator 或用户显式启用相应 feature gate 后，可在功能仍属于 Lab 时使用它。只有消融评估证明它相较简单基线有足够收益，且质量、延迟、token 和维护成本可接受，才可纳入 Lite 默认项。

仓库可以同时包含这两类界面，但实验复杂度不得成为默认插件的安装或 prompt 依赖。禁用的 Lab 能力必须从模型当前工具 schema 和常规 prompt 中移除。选择启用意味着接受该能力记录的成本与成熟度限制，不代表它已通过 Lite 晋升 gate。

Lab 能力生命周期有两个彼此独立的迁移：

```text
已实现的 Lab 能力
  |-- 按能力显式选择加入 --> 已启用的 Lab 能力
  `-- 有证据支持的晋升 --> Lite 默认能力
```

第一次迁移是有界显式租约，不证明能力有用。第二次迁移是产品默认项决策，而且必须可逆。Daemon 能力目录说明哪些功能允许 Agent 为当前 session 租用。低风险 scratch、只读推理和 shadow 观察可自助启用；会产生成本或修改状态的控制器模式仍要求 Harness/operator 授权，不能由模型请求自行解锁。因此，`nmg_lab` 是始终可用的小型发现／控制入口；能力专属 schema 和状态只有启用后才加载。Pi 的可选 `nmg_reason` 只是对这一共享边界的类型化便捷包装。

autodiff 底座属于 Lite，因为产品功能可能依赖其数值图，而且它不增加 Python、PyTorch、GPU 或模型服务依赖。**这不表示底座的每个使用方都晋升**：学习型路由、层级激活、fork/merge 实验和 Memory-Graph Reasoner 各自保留独立 feature gate 和证据要求。

## 基本原则

NMG 遵循以下原则：

1. **历史是持久来源；语义记忆是可重建的解释。** 常规维护不改写历史证据。
2. **记忆系统改善对相关既有状态的访问，不提高基础模型的推理上限。** 它可能改善连续性、个性化、约束遵循与经验复用；错误记忆也可能让 Agent 表现更差。
3. **存储可以增长，而 prompt 不必增长。** 多数回合应不包含动态记忆，或只看到精简目录。
4. **渐进披露优先于激进预取。** Agent 先看到有哪些记忆，再按需获取精确证据。
5. **漏掉推测关系比持久化错误关系安全。** 原始和暂定记忆仍可全局检索，同时语义结构逐步建立。
6. **选择经过测量的最简单实现。** 在相较简单对照提升质量或降低成本前，图、ANN、自适应树和学习型路由都保持可选。
7. **驻留、激活和巩固是不同决策。** STG 或 LTG 决定持久化；AG 决定当前可见性；激活描述当前使用；稳定性决定暂定结构是否适合巩固。
8. **事实可以先于结构稳定而持久保存。** 带来源信息的确认事实、偏好、约束或可替换状态可直接进入 LTG；推断关系、派生概念和可复用策略则需要更强的跨任务证据，才能成为 LTG 结构。

## 职责边界

| 组件 | 职责 |
| --- | --- |
| 基础模型 | 识别候选事实／偏好／约束，归纳信息，改写查询，判断是否需要更多证据，提出语义关系或拆分建议，并综合答案。 |
| Agent Harness | 运行模型／工具循环，暴露 session 生命周期事件，保留当前回合执行状态，并提供上下文／工具集成点。 |
| Harness 适配器 | 将原生消息和生命周期事件转换为 NMG 集成合同，注册工具并注入返回的上下文；不包含检索或存储策略。 |
| NMG 集成层 | 应用共享配置、保留获准的来源证据、运行混合检索，并暴露与 Agent 无关的应用边界。 |
| NMG 核心 | 维护稳定 ID、来源信息、STG/LTG 生命周期、时间／作用域／状态不变量、Active Graph 预算、语义组织、巩固信号和可重建索引。 |
| SQLite／索引后端 | 提供事务、WAL／崩溃恢复、FTS、版本化记录、脏队列、内容哈希以及物理索引／缓存持久化。 |
| 可选学习器 | 根据带标签的检索结果学习 query-to-node/leaf 分数、边的有效性、扩展深度或停止策略；不拥有持久拓扑。 |

更强的模型可以改善提取、归纳、查询规划、冲突解释和拓扑提案，但不能自然提供跨 session 持久化、事务、稳定来源、删除传播、索引维护或确定性预算执行；这些仍由系统负责。

## 产品边界：NMG Lite

阅读完整职责：[NMG Lite 产品边界](design/product-boundary.zh-CN.md)。

## 核心数据模型

阅读完整职责：[核心数据模型](design/core-data-model.md)。

## STG/LTG 连接与暂定记忆

阅读完整职责：[STG/LTG 连接与暂定记忆](design/stg-ltg-connectivity-and-provisional-memory.md)。

## Active Graph、激活、稳定性与巩固

阅读完整职责：[Active Graph、激活、稳定性与巩固](design/active-graph-activation-and-consolidation.md)。

## 信息与通信解释

阅读完整职责：[信息与通信解释](design/information-and-communication-interpretation.md)。

## Session 捕获与写入路径

阅读完整职责：[Session 捕获与写入路径](design/session-capture-and-write-path.md)。

## 增量存储与索引维护

阅读完整职责：[增量存储与索引维护](design/incremental-storage-and-index-maintenance.md)。

## 渐进检索

阅读完整职责：[渐进检索](design/progressive-retrieval.md)。

## 学习型路由与最小可微查询图

阅读完整职责：[学习型路由与最小可微查询图](design/learnable-routing-and-differentiable-query-graphs.md)。

## Memory-Graph Reasoner：保留的数值型 Lab 原型

阅读完整职责：[Memory-Graph Reasoner：保留的数值型 Lab 原型](design/memory-graph-reasoner.md)。

## 会话推理工作区与压缩检查点

阅读完整职责：[会话推理工作区与压缩检查点](design/session-reasoning-workspace-and-compaction-checkpoint.md)。

## 当前实现与目标

阅读完整职责：[当前实现与目标](design/implementation-versus-target.md)。

## 评估与可证伪声明

阅读完整职责：[评估与可证伪声明](design/evaluation-and-falsifiable-claims.md)。

## 云端与执行边界

云同步是可选的，不具有权威性。未来后端可以交换不可变操作和内容寻址的加密对象，而不是复制运行中的 SQLite 文件。Cloudflare 协调不属于 NMG Lite。

NMG 存取记忆；它不执行记忆中保存的命令，也不提供 `ExecutionBackend`。Pi 可通过自己的沙箱插件获得执行隔离，该能力独立于 NMG。NMG 可以把沙箱工具结果作为带来源信息的证据保存，但沙箱选择、权限、生命周期和策略仍由 Pi 及选定插件负责。

## 修订后的实现顺序

阅读完整职责：[修订后的实现顺序](design/implementation-order.md)。

## 尚待解决的设计问题

阅读完整职责：[尚待解决的设计问题](design/open-design-questions.md)。

## 简明技术定义

> NMG 是面向 Agent 记忆的自适应语义编码系统。它将不可变的历史证据编码为短期图和长期图中的可变、粒度可变的语义节点与关系；维护归 session 所有、可变且驻留内存的 Active Graph，作为有界工作空间；将不可变投影修订冻结为模型可见证据；可选使用 HA 管理激活、使用 MGR 执行临时推理；在允许受治理的原子记忆立即持久化的同时，巩固稳定且有证据支持的结构；并将精确历史保留为抵御语义检索错误的无损后备。

## 配套工程笔记

本文定义架构合同。配套笔记探讨实现选择，但不将它们全部变成核心要求：

- [`math-physics-foundations.md`](./math-physics-foundations.md) 区分已实现数学机制与有用类比，并提出可测量模型。
- [`structural-analogies.md`](./structural-analogies.zh-CN.md) 将 NMG 与 LSM、事件溯源、内容寻址、关联学习和图方法联系起来。
- [`function-signatures-from-structures.md`](./function-signatures-from-structures.md) 根据这些结构类比推导可能的 API 边界。
- [`sqlite-assessment.md`](./sqlite-assessment.md) 记录在当前规模和插件边界下继续使用 SQLite 作为权威存储的理由。
- [`improvement-areas.md`](./improvement-areas.md) 跟踪尚未解决的工程风险；不能把它当成已实现设计。
- [`ci-cd-and-quality.md`](./ci-cd-and-quality.md) 描述当前本地质量检查与 CI 自动化。
