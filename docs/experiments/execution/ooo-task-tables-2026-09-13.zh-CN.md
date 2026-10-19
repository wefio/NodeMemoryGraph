# 任务行的三类事实，拆成三张表 — 2026-09-13

[English](ooo-task-tables-2026-09-13.md) | [简体中文](ooo-task-tables-2026-09-13.zh-CN.md) · [术语](ooo-task-tables-2026-09-13.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是带日期的研究或 fixture 记录。表名、源码位置、状态表述、测试计数和未完成标签属于当时快照，不证明当前 daemon `taskRun` 集成。本轮未重跑所列套件或 mutation，也未确认当前检出可用全部历史／本地重放命令。产品边界由当前 [task-unit 契约](../../design/task-unit-semantics.zh-CN.md)负责。

设计的 persistence 一节（`docs/design/task-unit-semantics.md:200-208`）说，一条被持久化的事实可以是两类之一——不可变的 run manifest，或 board 并不持有的 append-only run fact——并且**派生状态没有权威存储**：`ready`／`blocked`／`accepted`、依赖满足情况、取消之后的有效性以及 fusion candidate 都是算出来的。`ooo_probe_tasks` 中的一行同时持有这三类，这正是上一次迁移必须_决定_不信任旧 `accepted_entry_id` 列的原因，也是「派生值可以重建」当时只是断言而不是测试的原因。

## 形状

- `ooo_probe_manifest (run_id, id, revision, input, dependencies, position, effect, source_revision, wait_event, operation, kind, patch_files, patch_editable)` —— 在计划安装时写入一次，之后永不更新。
- `ooo_probe_facts (…, attempt, artifact, entry_id, external_ready, observed_revision, owner, claim_time)` —— round 保存、而 board 不携带的最新事实；以 `(run_id, id)` 为 key，不是记录每次 attempt 的 append-only 历史。
- `ooo_probe_derived (…, input_digest)` —— 只有一列，因为此处可重算的只有一件事。
- `ooo_probe_task_view` —— 一个投影（manifest ⋈ facts ⋈ cache），不是存储。读取走它，因此缺少 cache 行时会降级为 manifest 自己的答案，而不是丢失一条事实。

## 重算检查发现了什么

拆分的第一版把 `owner` 与 `claim_time` 放进 cache，理由是 board 知道谁持有 claim。删除 cache 并重建让这个判断变得**错误**：round 在接受 artifact 时会 resolve 该 entry，此后 board 就停止报告 `claimedBy`，因此重建在 cache 曾保存审阅者姓名的地方重新派生出 `null`。谁 claim 过因此是一条事实——它是确实发生过的事，且已无法从来源读取——于是它被移到 `ooo_probe_facts`。这正是设计所设检查要捕捉的那类问题：拆分在 schema 里看着对，在来源上却是错的。

cache 里剩下的确实可重算：`input_digest`，仅从冻结的 manifest 得出（在 claim 时铸造它的 ticket 可能随 round 的内存一起丢失，并可从 manifest 的字节重建）。该测试删除整个 cache、重建它、比较重建值，然后**交付 round 中的下一个任务**——一个仅相等但不可用的重建 digest 会通过比较而在交付时失败。

## 证据（可复跑）

- `npm test` — **1455 passed, 0 failed**（产品测试，含 3 个新测试）。
- `tests/integration/ooo-task-tables.test.ts` — **3/3**：一次 claim 写入 facts 与 cache 但不碰任何 manifest 字节；删除 cache 并重建得到相同的 cache 与可用的 round；损坏的 cache 由来源修复，而不是被信任。
- `tests/integration/ooo-run-namespace.test.ts` — **4/4** 不变（命名空间化之前的 store 仍可迁移，现在直接迁入三张表）。
- `node --experimental-strip-types --test "evals/ooo-execution/*.test.ts"` — **88 passed, 0 failed**（round 测试套件，含 replay）。
- `npm run mutation:teeth` — **23 个 mutant 中 23 个按名称被捕获，覆盖 6 个 target，6/6 逐字节还原，0 个不适用**（rebuild tooth 在此新增；claim tooth 随它所钉住的语句一起移动）。
- `npm run docs:check`、`npm run complexity:gate`、`npm run check` — clean。

两条机械层面的说明，因为它们耗费了真实时间并且还会重现：一条跨过方法边界的原始 SQL 锚点静默删掉了 `transaction()` 与 `ensureColumns()`（由 `npm run check` 发现，而不是靠读 diff），以及 mutation 标记必须从文件字节中重新取——prettier 重排了该 tooth 所针对的那一行，因此手写的标记什么都匹配不到，直到它被重新取一次。

## 本变更不做的事

- **round 仍自己打开 SQLite 文件。** 组合由 daemon 持有的 store 是下一步，而命名空间加上这次拆分正是让它成为「更换所有者」而不是重写的原因。
- **事实以 `(run_id, id)` 为 key，而不是按序列 append-only。** attempt 计数器与最新 candidate 是事实；更早的 attempt 没有被单独保留。设计的 `runFactsThroughSequence` 视图会需要它们，而这次拆分正是将来存放它们的地方。
- **run 级元数据仍是 `ooo_probe_runs`**（policy、取消）。这里混合了声明与生命周期字段；本次拆分并不证明整行是不可变的 run manifest。
