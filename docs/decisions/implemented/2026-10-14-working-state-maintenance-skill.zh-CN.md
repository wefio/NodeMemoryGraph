# 用小型 Skill 维护工作状态正文

[English](2026-10-14-working-state-maintenance-skill.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [持续工作状态的日常使用](2026-10-12-working-state-daily-use.zh-CN.md)

## Problem

工作状态机制与共享策略没有充分说明正文的取舍和退出条件，可能产生部署日志式快照
或提前写下已验证结论。任务单元设计已有相关语义，但文档较长且正在考虑治理；用户
允许参考，不接受强依赖。

## Decision

[工作状态维护](../../../skills/working-state-maintenance/SKILL.md)拥有简短的正文维护
流程和审阅样例，不读任务单元设计也能执行。既有 NMG Skill 入口指向它，日常状态
说明中的固定示例换为该流程的引用。

流程补充而不替代共享 `memory_policy` 与 AG 操作规则。已有任务契约继续决定执行与
验收事实。任务单元设计只是可选背景，不是必读、导入的 schema 或另一份规范。

## Alternatives considered

- 新运行时校验或状态 schema：正文维护无需新增机制，也不能由此证明任意文本真实。
- 强制读取任务单元设计：把日常维护绑定到一份较长且可能调整治理的文档。
- 在提示词和 NMG 操作说明中重复流程：本可通过一个 Skill 到达的规则会出现多个 owner。

## Consequences

不修改运行时、存储、工具或提示词契约。文档检查验证载体与链接；审阅样例不证明
Agent 自然遵循、宿主重载、模型可见性或准确率/token 收益。若要评估，需另取证据。
