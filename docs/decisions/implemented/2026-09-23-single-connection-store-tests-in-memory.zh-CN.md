# 单连接 Store 测试使用内存 SQLite

[English](2026-09-23-single-connection-store-tests-in-memory.md)

**Status:** implemented
**Approved:** auto
**Relates to:** [测试不需要文件系统](2026-09-20-tests-need-no-filesystem.zh-CN.md)

## 问题

`tests/core/store.test.ts` 与 `tests/core/store/maintenance.test.ts` 原先为只通过一个连接断言行为的测试创建和删除独立文件数据库。这些测试没有观察文件持久化边界，却承担了文件数据库的成本。

## 决策

单连接 helper 为每项测试打开独立的 `NmgStore(":memory:")`，结束后关闭。验证重启后持久化、已有文件的迁移或独立连接读取的测试继续使用各自的文件数据库。测试的 Safety/Contract 类型与产品阻塞覆盖不变。资源由断言需要观察的性质决定，与 narrow/full 范围无关。

集成用的 `testDatabase()` 仍使用文件路径，以供 daemon 和 service 共享。CLI、Git、lease 与跨进程测试继续使用真实工作区和进程。

## 考虑过的替代方案

- 所有 store 测试都保留文件数据库：重复运行磁盘 I/O，却不会让从不重开的测试增加持久化断言。
- 共用一个文件数据库：减少准备成本，但测试间记录和 schema 状态会串扰，并行结果依赖顺序。
- 所有测试都改用内存：会失去独立连接、重启与迁移证据。

## 后果

52 项 store 测试使用原文件 helper 时通过，用时 12.153 秒；单连接 helper 改为内存后两次均通过，用时 9.363 和 8.706 秒。55 项 maintenance 测试使用文件库时通过，用时 2.494 秒；改为内存库后通过，用时 1.470 秒。40 次准备成本探针测得建删目录平均 0.258 毫秒、内存 store 开关平均 17.419 毫秒、文件 store 开关并清理目录平均 32.874 毫秒。这些是本机对照数据，不是最坏时间保证；方法见[实验记录](../../experiments/verification/product-file-partitions-2026-09-23.md#resource-boundary-trial)。

若测试开始断言文件、WAL、重启或跨连接性质，应改为独立文件 fixture。若完整阻塞测试失败，或文件持久化行为失去直接测试覆盖，则撤销本决策。
