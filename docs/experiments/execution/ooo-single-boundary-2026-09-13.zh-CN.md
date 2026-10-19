# store 中唯一的 transaction 边界，以及守住它的检查 — 2026-09-13

[English](ooo-single-boundary-2026-09-13.md) | [简体中文](ooo-single-boundary-2026-09-13.zh-CN.md) · [术语](ooo-single-boundary-2026-09-13.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是带日期的研究或 fixture 记录。表名、源码位置、状态表述、测试计数和未完成标签属于当时快照，不证明当前 daemon `taskRun` 集成。本轮未重跑所列套件或 mutation，也未确认当前检出可用全部历史／本地重放命令。产品边界由当前 [task-unit 契约](../../design/task-unit-semantics.zh-CN.md)负责。

集成契约要求 store 是唯一执行 BEGIN/COMMIT/ROLLBACK 的地方。在 port 原语（上一篇记录）之后，仍有四个 store 方法自己开事务：memory chain 的移除与三个 external-embedding upsert。本切片把它们移到边界上，并让该不变量变成机械检查。

## 变更内容

- `removeMemoryFromChain`、`upsertExternalNodeEmbeddings`、`upsertExternalLeafEmbeddings` 与 `upsertExternalEmbeddings` 改为调用 `writeTransaction()`，不再使用 BEGIN/try/COMMIT/catch/ROLLBACK。`src/core/store/base.ts` 现在恰好包含一个 BEGIN、一个 COMMIT 与一个 ROLLBACK，且三者都属于边界自身。
- embedding upsert 的 cache 刷新保持在事务**之外、且成功提交之后**：一个事务未能提交的批次同样不得预热 cache。改写保留了这个性质，而不是悄悄把它挪进事务。
- 该不变量是一个测试，而不是约定：`the store runs its transaction boundary in exactly one place` 统计源码中的这三条语句，检查 BEGIN 与 COMMIT 属于 `writeTransaction`，并检查每一处 `this.rollback()` 调用都是由边界发起的。仅通过行为套件不能确立这一结构性质；源码模式检查本身也仅覆盖其能识别的语句。

## 证据（可复跑）

- `npm test` — **1467 passed, 0 failed**。
- `tests/core/store-transaction-port.test.ts` — **9/9**（八个拒绝用例加一个单边界不变量）。
- `node --experimental-strip-types --test "evals/ooo-execution/*.test.ts"` — 88 passed, 0 failed。
- `npm run mutation:teeth` — **27 个 mutant 中 27 个按名称被捕获，覆盖 6 个 target，6/6 逐字节还原，0 个不适用**（此处新增一个：自己开事务的方法）。
- `npm run check`、`npm run docs:check`、`npm run complexity:gate` — clean。

## 本变更不做的事

lifecycle 这一半仍未触及：没有不带 `close()` 的 operations port，没有供 `status` 使用的借用视图（它不得迁移 schema、发布 handoff 或写入），没有 daemon 关闭顺序，以及历史报告的取消 round 临时目录泄漏（`src/integration/ooo-cycle.ts:814` 在第 1037 行清理用的 `finally` 之前返回）。此处未把这些行号绑定到源码版本，本轮也未将其重新确认为当前缺陷。
