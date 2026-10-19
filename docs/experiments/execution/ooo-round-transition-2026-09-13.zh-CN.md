# round 的 transition，以及其中的 board 写入 — 2026-09-13

[English](ooo-round-transition-2026-09-13.md) | [简体中文](ooo-round-transition-2026-09-13.zh-CN.md) · [术语](ooo-round-transition-2026-09-13.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是带日期的研究或 fixture 记录。表名、源码位置、状态表述、测试计数和未完成标签属于当时快照，不证明当前 daemon `taskRun` 集成。本轮未重跑所列套件或 mutation，也未确认当前检出可用全部历史／本地重放命令。产品边界由当前 [task-unit 契约](../../design/task-unit-semantics.zh-CN.md)负责。

设计的集成契约要求：被组合的写入条目复用同一份实现——独立调用时它们打开事务边界，在 transition 内部则通过 store 签发的 port 加入该边界。本切片完成 round 这一半。

## 变更内容

- `BoardAdmission.transaction()` 不再自己执行 BEGIN/COMMIT/ROLLBACK：它委托给 store 的 `writeTransaction()`，因此 round 的 transition _就是_ store 的边界。
- `publish()` 与 `publishReady()` 接受可选 port 并把它交给 `putTaskBoardEntry()`，因此在 transition 内部发生的发布会成为该 transition 的一部分，而不是第二次 BEGIN（store 对嵌套是拒绝而不是接受）。

该切片的静态审阅记录称发布发生在外层 commit 之后；通过的套件本身不能证明所有调用路径都满足该时序。接口改动使其不再依赖此顺序：在既有 transition 内发布时须经签发的 port 加入，否则在该处被拒绝。Transition 之外的独立发布可自行打开 store 边界。

## 证据（可复跑）

- `npm test` — **1466 passed, 0 failed**。
- `tests/integration/ooo-transition-atomicity.test.ts` — **3/3**：发布随 transition 一起提交；round 自己的发布在 transition 随后失败时被回滚（这是第二次 BEGIN 无法通过的检查）；在 transition 内没有 port 的发布被拒绝且不写入任何内容。
- `node --experimental-strip-types --test "evals/ooo-execution/*.test.ts"` — 88 passed, 0 failed。
- `npm run mutation:teeth` — **26 个 mutant 中 26 个按名称被捕获，覆盖 6 个 target，6/6 逐字节还原，0 个不适用**（此处新增一个：自己开事务的 round 发布）。
- `npm run check`、`npm run docs:check`、`npm run complexity:gate` — clean。

一条提交卫生方面的记录，因为它是被偶然发现而非被 gate 发现的：B2 对 `tests/integration/ooo-run-namespace.test.ts` 的改写（跟随新投影的原始读取）被漏在 B2 的提交之外，因此推上分支的版本里包含一个红的测试套件。它现在被单独提交，而这个失败模式值得记住：一次搬动表的重构，可能破坏该重构从未触碰过的文件里的测试。

## 本变更不做的事

- **仍有四个 store 方法自己开事务**（`removeMemoryFromChain`、`upsertExternalNodeEmbeddings`、`upsertExternalLeafEmbeddings`、`upsertExternalEmbeddings`），因此「store 是唯一的 BEGIN 所有者」仍不字面成立。
- **lifecycle 这一半尚未开始**：没有不带 `close()` 的 operations port，没有供 `status` 使用的借用视图（它不得迁移 schema、发布 handoff 或写入），没有 daemon 关闭顺序，以及历史报告的取消 round 临时目录泄漏（`src/integration/ooo-cycle.ts:814` 在第 1037 行清理用的 `finally` 之前返回）。这些未绑定版本的行号只保留为历史证据线索，不是已核实的当前缺陷位置。
