# 旧版 tessera 迁移

[English](legacy-migration.md) · [术语](legacy-migration.terms.yaml)

可写打开时，旧 `anchors` 记录及其引用在一个保存点内迁移。两表共存时，相同 ID 的七个旧字段必须一致；记录不同或旧表含不支持的列时，迁移停止且不修改两表。无冲突记录进入 `tesserae`；旧标记类型和 `anchorId` 属性分别转为 `tessera_ref` 和 `tesseraId`。保存点也会修复此前未完成改名留下的标记。旧表及其 FTS 对象只在该迁移成功时移除。普通 schema 流程在保存点之后创建和修复 tessera FTS；这一步不属于该保存点。只读打开不迁移。
