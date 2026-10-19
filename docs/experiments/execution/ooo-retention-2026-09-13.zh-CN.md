# 保留机制，与 round 不再复制的 verdict

[English](ooo-retention-2026-09-13.md) | [简体中文](ooo-retention-2026-09-13.zh-CN.md) · [术语](ooo-retention-2026-09-13.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是带日期的研究或 fixture 记录。表名、源码位置、状态表述、测试计数和未完成标签属于当时快照，不证明当前 daemon `taskRun` 集成。本轮未重跑所列套件或 mutation，也未确认当前检出可用全部历史／本地重放命令。产品边界由当前 [task-unit 契约](../../design/task-unit-semantics.zh-CN.md)负责。

**Related:** [task-unit 语义设计](../../design/task-unit-semantics.zh-CN.md) · [已实施决策记录](../../decisions/implemented/2026-09-13-task-unit-semantics.zh-CN.md) · [单一 acceptance 谓词](ooo-acceptance-predicate-2026-09-13.zh-CN.md) · [board 交付物／verdict 决策](../../decisions/implemented/2026-09-06-board-governance-addressing.zh-CN.md)

2026-09-13 测量。零模型 token。

## 问题

本记录引用的是当时设计中 runner 集成前的两个前提；此处未固定该引文的原始源码 revision，不能把它当作今天已修改设计的原文：_"被保留 run 引用的 board entry 必须能 survive 普通 TTL prune"_，以及派生事实不得有权威存储。两者当时都不成立，而且它们是同一个问题被看到两次：round 保留一个私有列（`accepted_entry_id`）指向接受 artifact 的那个 entry，恰恰是因为该 entry 本身可能在自己的 TTL 上被 prune 掉。复制该事实是为了在无法保留证据时的变通做法。

## 变更内容

| 部分                                                                             | 变更                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task_board_retentions`（schema）                                                | 每个 `(entry_id, owner)` 一条 pin，带原因与可选的 `retained_until`                                                                                                        |
| `retainTaskBoardEntry` / `releaseTaskBoardRetention` / `listTaskBoardRetentions` | store 的 API；对悬空引用、无归因的 pin 与不可解析的界限都按名称拒绝                                                                                 |
| `pruneExpiredTaskBoardEntries`                                                   | channel 作用域与全局两条路径都会豁免 pinned entry 及其 delivery 与 ack；serial-slot promotion 忽略 pinned entry；过期的界限会停止 pin |
| round                                                                            | 为它发布的每个 handoff 加 pin，在 `fenceRow` 上释放（`cancel` 与 `reopen` 都经过它），并在一个从未使用过的 handoff 被 retire 时释放                                    |
| `acceptedArtifacts()`                                                            | verdict 通过 _本次尝试的_ artifact 的 digest 在 board 上查得；没有指针列                                                                                  |
| `commitArtifact()`                                                               | 停止写入 `accepted_entry_id`                                                                                                                                 |

Acceptance 从 board 的 digest 绑定 verdict 查得；retention 保持派生所需证据可用。Pin 本身不会接受 artifact，也不替代独立 verdict。需要持久引用的消费者不必再把事实复制进自己的表——这正是设计所说「派生事实不得有权威存储」要求的性质。

## 证据

| 检查                        | 命令                                                                                                                                                                     | 结果                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| types / lint / format / docs | `npm run check`, `npx eslint …`, `npm run format:check`, `npm run docs:check`                                                                                               | clean（docs：185 个文件，0 错误）                                                |
| complexity                   | `npm run complexity:gate`                                                                                                                                                   | `7 changed code file(s) … 0 method(s) above 15`                                  |
| product suite                | `node --experimental-strip-types --test --test-concurrency=2 "tests/**"`                                                                                                    | 1231 pass, 0 fail                                                                |
| round suites                 | `… "evals/ooo-execution/*.test.ts"`                                                                                                                                         | 88 pass, 0 fail（此前为 86）                                                         |
| mutation teeth               | `node <shared-checkout>/.nmg/teeth-check-task-semantics.mjs`（当时是本地脚本；同样的 mutant 现在位于 `tools/mutation-teeth.ts`，即 `npm run mutation:teeth`） | 15 个 mutant 中 15 个按名称被捕获，覆盖 4 个 target，每个都逐字节还原 |

round 级用例正是该前提本身：一个 artifact 被接受后，用超过 store 中所有 TTL 的时间戳执行 prune，然后断言被引用的 entry 仍然存在，且 `accepted()` 仍派生 `["P"]`；接着 `reopen()` 该任务，并断言 pin 已消失、该 entry 最终可被 prune。第二个用例取消该 round，并断言没有任何 pin 存活。

## 两个 teeth 存活，且都是我测试的问题

这是值得保留的部分。扩展 teeth 检查的第一次运行报告了两个什么都没击中的 mutant：

- **`prune-ignores-retention`** 未被捕获，因为 retention 测试只调用了 _全局_ prune；带自己的 DELETE 的 channel 作用域路径从未被走到。该用例现在两条都调用。
- **`round-never-releases-its-pin`** 未被捕获，因为 round 测试只走到 `reopen`，而该 mutant 移除的是 `fenceRow` 内部的释放——正是 `cancel` 走的路径。补上一个 cancel 用例后，暴露出代码里的一个**真实缺陷**，而不只是测试的缺口：`fenceRow` 只按 artifact digest 释放，因此 round 发布过但从未使用的 handoff 上的 pin，会在 `publishReady()` 清空 `entry_id` 的那一刻成为孤儿。释放现在改为双重释放——按 entry id 与按 artifact digest，统一经 `releaseRowRetention()` helper——并由 cancel 用例钉住。

## 本变更不做的事

- `ooo_probe_tasks` 仍把不可变输入（`input`、`revision`）、candidate 字节（`artifact`）与可派生状态（`entry_id`、`attempt`，以及现在已退役的 `accepted_entry_id`）放在同一张表里。本次变更去掉的是一个派生列的_使用_；拆表是设计的后续切片，与共享事务 store 和多 round 命名空间一起做。本段早于[任务表重算审计](ooo-task-tables-2026-09-13.zh-CN.md)；其笼统的派生状态标签不证明所列每个字段都能由 board 重建。
- 没有 `retainedUntil` 的 pin 只能显式释放，因此一个在未 fence 的情况下死掉的 round 会留下可见的 pin。这是有意为之——证据不得消失——而 `listTaskBoardRetentions` 是运维找到它的方式。不应有人把这点读成自动清理。

## 复现

本区块是历史重放配方，不是当前可执行回执。本记录没有提供 `<shared-checkout>` 或当时的本地一次性脚本，本轮也未确认其可用性。重放前须按目标源码 revision 确认具名 mutation 检查；本轮文档工作未执行这些重放。

```bash
cd <worktree on this branch>
npm run prompts:generate
npm run check && npm run complexity:gate && npm run format:check && npm run docs:check
node --experimental-strip-types --test --test-concurrency=1 tests/core/task-board-retention.test.ts
node --experimental-strip-types --test --test-concurrency=1 "evals/ooo-execution/*.test.ts"
node <shared-checkout>/.nmg/teeth-check-task-semantics.mjs   # local one-off at the time; see tools/mutation-teeth.ts
```
