# Shared-Store 设计：行可见性与生命周期

[English](shared-store-design.md) | [简体中文](shared-store-design.zh-CN.md) · [术语](shared-store-design.terms.yaml) · 上级：[STG shared-store v2](../stg-shared-store-v2-2026-08-12.zh-CN.md)

**状态：**当前源码确认下述项目本地文件与读取过滤形状。设计理由、事故数量和 rollout 标签属于历史记录；session ID 不是身份认证机制。

## 存储布局与可见性

```text
<project>/.nmg/stg.sqlite                 # 每项目一个文件
memory_records.session_id:
  NULL       → 共享行（包括 cached_from_ltg hints）
  session ID → 对该 session 可见的行
```

- 不同项目使用不同文件。
- 带 session ID 的查询可以看到 `session_id IS NULL OR session_id = ?`。
- 不带 session ID 的查询只能看到 `session_id IS NULL`；不能变成无限制读取。
- `cached_from_ltg` 拷贝是项目本地共享提示；LTG 仍是权威数据。会话所属行通过显式 session purge 路径删除。

当前检索谓词位于 [`src/core/store/retrieval.ts`](../../../src/core/store/retrieval.ts)，共享 Store 路径和 purge wrapper 位于 [`src/core/stg.ts`](../../../src/core/stg.ts)。

## 历史匿名读取泄漏

2026-08-12 报告记录了一次 daemon RPC 观察：旧谓词 `(? IS NULL OR session_id IS NULL OR session_id = ?)` 在没有 session ID 时暴露了私有 provisional rows。该谓词被替换为两个显式分支：有 session ID 时读取共享行和本 session 的行；无 session ID 时仅读共享行。这是一条有日期的事故记录；所有读取路径的当前行为仍以源码为准。

## 信任与安全边界

`sessionId` 是 client／harness 提供的可见性选择器。Daemon 执行行过滤，但此设计不会签发或认证该标识符。能够提交其他 session ID 的本地调用方不受 SQL 谓词保护。此设计通过集中 daemon/store 路径降低遗漏风险，但不等价于数据库强制的 row-level security。

历史设计还提出：全局可见的 STG 行应由显式共享缓存或 consolidation 路径产生，而不应由意外漏传参数产生。这是设计不变量，不表示当前每个写入 API 都会独立强制它。依赖 session 必填规则前，应检查具体写入 owner。

## 生命周期与 WAL 处理

| 操作 | 当前 owner／路径 |
|---|---|
| 创建／打开 STG | 通过 `createStgStore()` 使用一个项目文件 |
| 拷贝 LTG 搜索提示 | `copyLtgSubsetToStg()` 写入 `cached_from_ltg` markers |
| 删除某 session 的 STG 行 | `purgeSessionFromStg()` 委托给 store purge |
| 关闭 writable store | `NmgStore.close()` 在关闭前尝试 `wal_checkpoint(TRUNCATE)` |
| 从异常退出后的剩余 WAL 恢复 | 构造函数尝试 checkpoint 非空 WAL |

Checkpoint 不会认证 session，也不会改变行可见性语义。行为以当前源码和测试为准，不以旧 rollout 表为准。

## 源码与测试参考

- [项目本地 STG helpers](../../../src/core/stg.ts)
- [按 session 过滤的读取路径](../../../src/core/store/retrieval.ts)
- [Session-scoped 写入与 purge 实现](../../../src/core/store/writes.ts)
- [Store 构造、PRAGMA、关闭与启动时 checkpoint](../../../src/core/store/base.ts)
- [STG v2 行为测试](../../../tests/core/stg-v2.test.ts)