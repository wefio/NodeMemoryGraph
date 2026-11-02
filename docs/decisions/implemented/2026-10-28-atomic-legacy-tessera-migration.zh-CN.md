# 原子协调旧 tessera 迁移

[English](2026-10-28-atomic-legacy-tessera-migration.md) · [术语](2026-10-28-atomic-legacy-tessera-migration.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

旧改名逻辑在 `tesserae` 存在时跳过 `anchors`，且改名与标记更新是独立语句。失败或混合 schema 可能让记录或引用留在当前路径之外。旧标记还使用 `anchorId`，与当前的 `tesseraId` 不同。

## 决策

[Tessera 设计](../../design/memory-tesserae-design.zh-CN.md)拥有迁移契约。在同一保存点内复制无冲突旧记录、保留相同的当前记录、拒绝不一致记录及不支持的旧字段，并修复标记类型和 ID。只有安全合并后才在该保存点内移除旧表。普通 schema 流程在保存点之后创建或修复 FTS。

## 考虑过的替代方案

保留两张表或静默选择胜者可能隐藏记录或覆盖不同书签。拒绝所有混合 schema 会让可安全合并的记录继续不可用。单独的人工迁移会延迟无冲突库的自动恢复。

## 后果

真实 ID 冲突或未知旧字段会阻止可写打开，需要显式协调；只读检查仍可使用。迁移不决定胜者，也不删除冲突数据。FTS 恢复仍是后续 schema 步骤，因此保存点与该步骤之间中断时依赖下一次可写打开。
