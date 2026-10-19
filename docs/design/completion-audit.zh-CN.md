# NMG 设计完成度审计

[English](completion-audit.md) · [术语](completion-audit.terms.yaml)

**Authority:** current requirement-to-evidence ledger. Normative intent remains
in [design.md](design.zh-CN.md); implementation history in
[implementation-lineage.md](implementation-lineage.zh-CN.md); document ownership is
defined by [the documentation index](../README.zh-CN.md)。

**Status:** current
**Updated:** 2026-10-18
本账本在不混淆两者的前提下回答两个不同问题：

1. 每项有意的 NMG 职责是否都已被某个组件设计并拥有？
2. 每项可选策略是否已经挣得默认产品启用？

第一个问题可以已完成，而第二个仍开放。缺少自然数据标定不是再造一个子系统的许可；一个通过的单元测试也不是某项策略改善真实 Agent 工作的证据。

## 状态词汇

| 状态 | 含义 |
| --- | --- |
| **已验证核心** | 契约已设计、接入稳定边界，并由确定性测试覆盖。 |
| **可选 Lab** | 已实现且可显式启用，但从 Lite 默认工具/提示词路径中省略。 |
| **已设计目标** | 规范目标与归属已被接受，但当前实现仍采用被取代的运行时形态。 |
| **标定闸门** | 机制存在；阈值或默认启用需要独立的自然证据。 |
| **显式推迟** | 边界已设计，但实现等待一个已声明的前提。 |
| **范围之外** | 由另一个组件拥有；NMG 只需定义集成边界。 |

Lab 不是单向的存放区。daemon 通过既有客户端 RPC 发布能力目录与会话作用域的过期租约。Agent 可以自行启用明确指定的低风险能力；受控与主动驱动仍要求 harness/操作员权威及其既有 receipt 与闸门。通过一次评测是让能力成为 Lite 默认的必要条件，而不是为某一个合适任务显式使用它的前提。

## 需求矩阵

阅读完整职责：[需求矩阵](completion-audit/requirement-matrix.zh-CN.md)。

## Agent 收敛反馈实现切片

[反馈设计](agent-convergence-feedback-design.zh-CN.md)仍是 **partial**，不会因一次文档或实现 PR 而完成。`SessionFeedbackProvider` 与显式 RCP CLI 会话/任务目标把通过校验的、新记录的 receipt 送入临时的 AG 观察。受控测试覆盖真实失败检查、HTTP 投递、身份绑定、去重与失败隔离。它们不证明整体任务完成，也不证明自然 Agent 改善。

132 参数的 `ContextRouter` 数值原语有动作掩码、采样、已观察动作更新与权重往返测试，包括编译执行。它不会被自动调用、不从自然结果训练，也没有作为新的自助 Lab 能力暴露。实验 harness 现在已有带版本的 32 特征编码器、四个有界上下文执行器适配器、有序试验事件、调用方核验的结果准入与按来源组的数据集重放。试验汇聚点会被 await；一个有界的本地 append/fsync 日志检查阶段、输出身份与重复执行预留。生成输出指纹与执行器调用计数把准入绑定到执行，却不证明模型暴露。重新打开会在重建时撤回一行；生产制品撤销仍未接线。[LoCoMo 组件探针](../experiments/context/router-component-2026-09-06.zh-CN.md)收集了 6128 条动作行并拟合了一个线性头，但在留出证据覆盖上与固定的 retrieve 打平。它使用自定义词法排序、没有主 LLM、也没有官方答案打分。仅验证集上的成本敏感性与按来源组计数现在暴露了退化策略与小的独立样本量。通用生命周期生产者、生产恢复编排、模型暴露、外部验证器适配器与端到端效力仍未完成。不隐含任何系统完成状态或默认提升。

## 实际活跃阻塞项

仍存在四个活跃工作族；第一个是范围更窄的 AG 完成工作，另外三个阻碍自适应策略获得有证据支撑的默认启用：

1. 会话 AG 核心、显式帧/分支生命周期、有界运行时条目与共享适配器披露账本已实现。自动语义帧分类、完整多维预算 `B` 与可选的类型化 HA/MGR 产物准入仍未完成。
2. 自然 Pi 任务很少包含独立核验的 claim/证据结果。
3. 检索/控制器的收益尚未通过匹配的质量**以及** token、工具轮次、延迟与回滚闸门。
4. 无人值守的 STG 巩固与身份合并没有自然假阳性、矛盾与反转覆盖。

AG 那一项是有意的破坏性运行时重设计；其余项是验证阻塞，而不是缺失存储机制。它们的可执行检查单在 [temporary-todo.md](temporary-todo.md)。

## 完成规则

当每项有意的职责都在本矩阵中带有所有者、不变量、启用权威与证据闸门时，NMG 设计在结构上完成。只有当活跃阻塞项在独立的自然使用上通过时，NMG 才在产品意义上被证明。只有在观察到的失败无法由既有所有者解决时才应加入新机制；否则它们只会增加维护成本而不闭合任何需求。

只有当提交哈希实质性地缩短恢复时间或防止重复一个被取代的设计时才会被记录。经策展的所有者映射与记法在 [implementation-lineage.md](implementation-lineage.zh-CN.md)；Git 仍是穷尽的变更日志。
