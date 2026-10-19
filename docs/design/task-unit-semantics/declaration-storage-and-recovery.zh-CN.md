# 声明存储与恢复

[English](declaration-storage-and-recovery.md) · [术语](declaration-storage-and-recovery.terms.yaml)

**Status:** draft

**权威范围：**[任务单元范围](../task-unit-semantics.zh-CN.md)与[声明归属决策](../../decisions/implemented/2026-10-02-declarations-have-one-owner.zh-CN.md)。

## 默认声明的权威

声明语义与编码归协议，执行冻结与恢复归采用方。store 提供同一个连接与事务，黑板只解释协作状态，不另拥有任务正文。

默认 Task-Unit 的类型、DDL、读写与规范化相等性由 [task-unit-declaration-store.ts](../../../src/integration/task-unit-declaration-store.ts) 拥有。`task_run_tasks` 保留为唯一任务定义；store 的既有方法是默认适配层兼容转发，不是所有协议必须采用的字段契约。

## 冻结输入回执

默认补丁采用方在认领事务内，把原始输入字节、显式 budget／limits、允许结论种类及执行声明摘要写入 `task_run_facts` 的 `task-unit.patch-inputs-frozen` 回执，按 run／task／attempt 定位。

说明、依赖与权限名单仍从冻结任务行读取，不在回执或黑板正文中复制定义。认领、输入回执与认领事实一起提交；任何冻结错误使整个转移回滚。合法性和恢复查询不补写事实。

## 恢复与拒绝

恢复必须用对应 attempt 的原始输入与参数重建，并核对声明摘要。未知回执版本、非法字段、摘要不符或验收时缺少回执都明确拒绝，不以当前工作区兜底。

未认领任务仍由宿主提供初始输入，验收回调也由宿主重新提供。回执不持久化函数，不证明恢复了验收配置。计划、执行声明和交付产物使用各自的摘要身份。

归属决策说明为何保留类型表而不复制 JSON；peer 外框的协议字段与 payload 迁移仍是独立范围。
