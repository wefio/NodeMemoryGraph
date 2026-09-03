# 将构建产物纳入版本控制

[English](2026-09-02-track-build-artifacts-in-git.md)

**Status:** rejected  
**Date:** 2026-09-02

## Problem

仓库中存在若干可再生的输出：`dsh/dsh-nmg/lib/`（DSH 宿主插件的 tsdown 构建产物）、`src/prompts/nmg-prompts.generated.ts`（由 `scripts/generate-prompts.ts` 从 `nmg-prompts.yaml` 生成）、`.nmg-search-scope`（运行时热区清单）。很长一段时间里，工作树一直带着已修改但未提交的 `lib/` 与 `package-lock.json` 副本——因为 PR 只提交 `src/`，而被跟踪的产物持续落后于源码。

这造成了最差的两难：产物被跟踪（全新 clone 会拿到过时副本），却从不与其源同步更新（被跟踪副本是错的，工作树永远脏）。漂移以真实故障形式暴露——过时的 `lib/index.js` 仍在讲旧 `anchors` RPC 表面，而 daemon 与 CLI 早已迁到 `tesserae`。

## 提案

将构建产物（`dsh/dsh-nmg/lib/`、生成的 prompts）与其源放在同一提交中入库，使仓库从干净 clone 即可构建、工作树始终干净。

## 考虑过的替代方案

- **忽略产物但仍像现在这样跟踪它们。** 拒绝：这正是造成工作树永久脏、被跟踪副本过时的现状——被跟踪却从不与其源同步。
- **生成到仓库外的独立位置。** 暂拒：`dsh/dsh-nmg` 由 `link:` 安装消费，期望 `lib/` 与 `package.json` 相邻；移动输出会破坏 DSH 插件契约。

## 为什么拒绝

- **生成产物不是源码。** 它们不携带设计意图，无法被有意义的评审；对 `lib/index.js` 的 diff 是淹没真实 `src/` 变更的噪音。
- **它们按构造就会漂移。** 每个产物随机器与工具链版本以不同的时间戳/内容哈希再生，因此"每次源码变更都随提交"是无法执行的纪律，会像过去一样悄然失效。
- **正确的保证是可构建性，而非提交产物。** 干净 clone 必须能再生一切——这是**验证**属性，由 CI 与 Repository Control Plane（`verify:packages`、`verify:static`）拥有，而非工作树的内容属性。
- Lockfile 是刻意的例外：`package-lock.json` / `pnpm-lock.yaml` 固定依赖图，是配置而非可再生的构建输出。它们保持跟踪；`package.json` 与 lockfile 的漂移由 `npm ci` 与 `check:lock` 捕获。

## Consequences

- `dsh/dsh-nmg/lib/`、`src/prompts/nmg-prompts.generated.ts`、`.nmg-search-scope` 不再跟踪并被忽略。
- `dsh/dsh-nmg` 的新消费者必须先运行 `pnpm install --frozen-lockfile && pnpm run build` 才能使用该包（见 `skills/repo-development/SKILL.md`）。
- CI 通过 `verify:packages` 在干净 checkout 上验证子包可构建性，因此产物排除不会悄然腐蚀构建。
