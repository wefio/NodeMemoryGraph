# STG Shared Store v2：项目文件与会话级行可见性

[English](stg-shared-store-v2-2026-08-12.md) | [简体中文](stg-shared-store-v2-2026-08-12.zh-CN.md) · [术语](stg-shared-store-v2-2026-08-12.terms.yaml)

**状态：**当前源码确认每项目一个 STG SQLite 文件，并按 session 隔离行可见性。2026-08-12 的存储成本数值与 rollout／测试标签是历史报告，不是当前测量或验证回执。

**更新日期：**2026-10-16

**取代：**[STG isolated store](stg-isolated-store.md)，该设计曾为每个 session 单独创建私有文件。

## 当前源码契约

- `stgStorePath(projectDir, sessionId)` 解析为 `<project>/.nmg/stg.sqlite`；`sessionId` 不再参与文件名。
- `memory_records.session_id` 提供应用层行可见性。带 session ID 查询时，可见共享行（`session_id IS NULL`）和该 session 的行；不带 session ID 时，只能看到共享行。这是过滤契约，不是身份认证，也不能防止能传入其他 session ID 的本地调用方。
- `cached_from_ltg` 拷贝是项目共享的搜索提示，不是 LTG 权威数据。会话所属 STG 行通过显式 purge 路径删除；项目文件保留。
- writable store 使用 WAL，并在关闭时通过 `PRAGMA wal_checkpoint(TRUNCATE)` checkpoint。若打开时发现非空 WAL，构造过程还会尝试 best-effort checkpoint。

这些事实对照 [`src/core/stg.ts`](../../src/core/stg.ts)、[`src/core/store/base.ts`](../../src/core/store/base.ts) 和带 session filter 的检索／写入路径检查。设计细节与信任边界见 [Shared-store design](stg-shared-store-v2-2026-08-12/shared-store-design.zh-CN.md)。

## 历史动机与证据边界

2026-08-12 报告比较了 per-session 文件设计与项目共享数据库。报告记载 1,765 个 session 数据库文件、约 1.5 GB WAL、约 900 MB 重复 schema／FTS 开销，以及抽样 `memory_records` 表为空。这些是有日期的观察，不是对当前 checkout 的新测量。设计理由是避免空数据库文件随 session 数量倍增，同时保留行级 session 可见性。

报告也记录了一次历史匿名读取泄漏：旧谓词把缺失 session ID 当作“任何 session”，因此暴露了私有 provisional rows。修正后的双分支可见性规则见子文档。Session ID 由 client／harness 提供并由 daemon 信任；该存储设计不会签发或认证 session ID。

旧迁移方案与业界比较仅作历史背景，不构成数据库产品 benchmark，也不授权未来采用云端／同步架构。

## 当前源码与测试参考

- [项目本地 STG 路径与 purge 入口](../../src/core/stg.ts)
- [STG 检索与行可见性](../../src/core/store/retrieval.ts)
- [Store schema、连接 PRAGMA 与 WAL 生命周期](../../src/core/store/base.ts)
- [写入路径](../../src/core/store/writes.ts)
- [STG v2 测试](../../tests/core/stg-v2.test.ts)

本文引用测试文件作为 owner，不声称当前测试已通过。精选的历史到 owner 索引见[实现沿革](implementation-lineage.md)。