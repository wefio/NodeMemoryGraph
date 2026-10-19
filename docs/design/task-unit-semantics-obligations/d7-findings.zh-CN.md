# 历史 D7 转换发现

[English](d7-findings.md) · [术语](d7-findings.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.zh-CN.md).

## 历史 D7 转换发现

本文记录一次对已退役 round runner 的转换尝试，不是当前 daemon `taskRun` 路径的证据；round 对象于 2026-09-18 移除（[决策](../../decisions/implemented/2026-09-18-retire-the-round-instrument.zh-CN.md)）。

1. round 把一个仍会逐项填充的 `specs` map 交给 Store。host-owned Store 看不到这些后续修改，因此首轮转换产生 33 个 `patch task has no host spec` 失败。尝试中的修复在 owner 上增加显式操作 `installPatchTask(id, spec)`，并让 round 调用该操作，而不是修改双方共享的记录。
2. `evals/ooo-execution/round-runner.ts` 有一个本地 `openRoundStore`，用途是验证已有 Store，而非创建 Store。将 Store 创建移至 host 后，调用点必须区分导入的 Store factory 与本地 validator。

记录中的失败数在这些改动后从 33 降至 4；剩余失败都是 `round-runner` 命名冲突。该转换随后被回滚，因此这些结果是那次尝试的历史证据，不是对后续 daemon 运行记录路径的判定。修改 `evals/**` 时，[仓库开发工作流](../../../skills/repo-development/SKILL.md)要求首先运行相关 eval 套件。
