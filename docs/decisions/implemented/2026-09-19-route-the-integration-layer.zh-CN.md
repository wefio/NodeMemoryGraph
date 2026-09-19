# 给 integration 层配路由，改它才会跑到检查

[English](2026-09-19-route-the-integration-layer.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [当路由自带测试时就拒绝共享检查](2026-09-16-route-declines-shared-checks.zh-CN.md)

## 问题

`src/integration` 虽被 `memory-runtime` 这个 capability 声明，但 `agent-context.yaml` 里没有任何 route 认领它。于是这一层的每次改动都得到 `no verification route matched: src/integration/...`——没有拥有文档、没有测试、没有检查。这一层并不小：它同时拥有 host-neutral 的 Agent Surface（候选 DTO、证据布局、黑板约定、链标签、披露预算）与 OoO/任务执行编排，而这两半本来就各自有拥有文档和测试。

## 决策

在这一层上声明**两条** route，按**拥有文档**划分，而不是按目录划分：

- `agent-surface`——呈现与契约边界：`agent-surface.ts`、`chain-projection.ts`、`search.ts`、`search-projection.ts`、`evidence.ts`、`tool-contract.ts`、`config.ts`、`controller-channel.ts`、`reasoning-workspaces.ts`、`lab-capabilities.ts`；拥有文档 `docs/design/design.md`；测试为对应的 `tests/integration/*.test.ts`。
- `ooo-execution`——执行编排：六个 `ooo-*.ts`、改名后的 `check-ticket.ts` 与 `check-runner.ts`、五个 `task-*.ts`；拥有文档 `docs/design/ooo-execution-bootstrap.md`、`docs/design/task-unit-semantics.md`、`docs/design/ooo-fusion-planning.md`；测试为 `tests/integration/ooo-*.test.ts` 与 `tests/integration/task-semantics*.test.ts`。

两条都声明 `verify: blocking: [check, test:product, build]`、`advisory: []`，与 `core-memory`、`pi-adapter` 已有的声明一致，并保留默认的 `sharedChecks`。

两条 route 之所以逐文件列举，是因为机制只支持这样：`tools/repo-context.ts` 的 `matches()` 把 pattern 里的第一个 `*` 当作**目录前缀的起点**，所以 `dir/**` 与精确路径能命中，而 `src/integration/ooo-*.ts` 这种中间通配**什么都不命中**。一个静默不命中的 pattern 比一张清单更糟，所以清单就是声明，并由一个测试保证它完整。

## 考虑过的替代方案

- **一条 `src/integration/**` 的大 route。** 否决：两半的拥有文档不同，一条 route 会把"一规矩一个家"同时压到两个拥有者身上。
- **用通配写文件名（`src/integration/ooo-*.ts`）。** 否决：在当前匹配器下它什么都不命中，route 看起来声明了却永远不会被选中——正是这次要消除的那种失败。
- **把这一层并进 `core-memory`。** 否决：`core-memory` 拥有的是 `src/core/**`；route 是对"谁拥有这个路径"的声明，不是兜底。
- **让这两条 route 也指向 `evals/ooo-execution/**`。** 否决：eval 驱动是测量面，窄范围验证不该花付费模型调用。

## 后果

`src/integration` 下的改动现在有路由了：`agent:context` 会说出拥有它的 route 与拥有文档，`agent:verify` 会跑该 route 的阻塞检查，而不再回答"什么都没匹配"。这一层的 `desiredRevision` 因此改变，路由读数要重新变干净，需要先跑一次验证。

因为 route 逐文件列举，这一层里新增的文件会**没有 route 认领、且没人抱怨**。所以 `tests/tools/repo-context.test.ts` 断言：两条 route 的路径并集，加上下面点名的四个富化文件，恰好等于目录清单——新增文件会让该测试失败，直到它被认领。

仍然未被覆盖、且刻意不在这里顺手塞进来的：检索索引富化那几个文件（`leaf-summarizer.ts`、`node-summarizer.ts`、`summary-drain.ts`、`openai-completion.ts`）不属于任何一半——外部 LLM 写索引文本、存储层再持久化——它们需要自己的 route 与拥有文档。它们被写在那条测试里，好让这个缺口可见而不是被忘掉。
