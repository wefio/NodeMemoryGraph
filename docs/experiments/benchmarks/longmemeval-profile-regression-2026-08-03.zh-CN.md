# LongMemEval 94.15% 基线漂移：Embedding Profile 回归（2026-08-03）

[English](longmemeval-profile-regression-2026-08-03.md) | [简体中文](longmemeval-profile-regression-2026-08-03.zh-CN.md) · [术语](longmemeval-profile-regression-2026-08-03.terms.yaml)

**状态：**历史 benchmark 报告。本次文档审计未复现原始分数。当前源码仍会在模型名包含 `bge` 时默认选择 `bge-en`，除非显式设置 `NMG_EMBED_PROFILE`；这一源码事实不能重新验证历史 benchmark 分数。

> **结论：**报告将回归归因于 embedding 配置漂移，而不是检索机制变化。`NMG_EMBED_PROFILE` 丢失后回退到 `qwen3`；将其 `Instruct: ... Query: ...` 模板套用于 BGE query 会损害排序。报告记载 LongMemEval any-evidence recall 从 **94.15% 降到 76.0%**。恢复 `NMG_EMBED_PROFILE=bge-en` 后，历史 run 报告复现 94.15%／87.95%；修复配置下的 dynamic QPP 报告为 95.19%／89.71%。

## 背景

历史 LongMemEval any-evidence recall 基线为 94.15%，来自 `nmg_lme500_bge_merged_20260728` 与 `nmg_bge_wide20_merged_20260801` 两次 run。后续 checkout 的固定 top-20 重跑得到 76.0%，相差 18 个百分点，最初令人怀疑代码或向量环境回归。本调查将其归因于 profile 配置。

## 诊断证据链

1. **排除代码：**用 wide20 时期的 `ecdd661` commit 固定 top-20 重跑也得到 76.0%，接近当前 B0。报告称 `ecdd661..HEAD` 的 diff 中 `base.ts` 和 selection 逻辑没有变化。
2. **排除数据：**B0 store（user 5）有 469 条记录，向量覆盖率 100%，目标证据记录存在。
3. **实测排序差异：**同一 store、同一 query “What was my last name before I changed it?”：
   - `profile=qwen3`（默认）：证据排名 **14**，被 top-12 token 截断排除；
   - `profile=bge-en`：证据排名 **5**；
   - `profile=plain`：证据排名 **9**。
4. **Hash 来源：**报告称当时的 embedding-cache index hash `e84bb38b824d` 全部于 08-03 生成；`e20245358378`（1,645 条）是 08-01 的调试 session。报告复现 profile 到 hash 的映射：`qwen3` → `e84bb38b824d`；`bge-en` → `1e9807091681`。
5. **全量检查：**使用 `NMG_EMBED_PROFILE=bge-en` 与固定 top-20，报告记录 any-evidence recall **94.15%**、overall **87.95%**，类别结果与历史 run 匹配：knowledge-update 100.00/99.31、multi-session 97.60/85.63、temporal 88.64/83.01。

## 根因与源码修正

报告将问题追溯到 `src/core/embedding-providers/openai.ts` 的 `commonOpenAiOptions`：除非设置 `NMG_EMBED_PROFILE`，无论模型为何都会使用 `qwen3` 默认 profile。BGE 模型（`BAAI/bge-small-en-v1.5`）的 query 模板应为 `Represent this sentence for searching relevant passages: {text}`；Qwen3 模板 `Instruct: {instruction}\nQuery:{text}` 会使 BGE query embedding 偏移并损害排序。历史 run 环境显式设置过 profile（或当时默认值不同），08-02／03 前后重写环境文件时该配置丢失。

报告记录的修复按模型选择默认值：模型名包含 `bge` 时用 `bge-en`，其他模型用 `qwen3`；显式 `NMG_EMBED_PROFILE` 优先。当前 [`src/core/embedding-providers/openai.ts`](../../../src/core/embedding-providers/openai.ts) 和 [`tests/core/embedding-provider.test.ts`](../../../tests/core/embedding-provider.test.ts) 保留了该行为。测试覆盖 BGE 默认值、显式覆盖、非 BGE 的 `qwen3` 和 index-ID 区分。

## 历史 LongMemEval 矩阵（n=479，any-evidence recall）

| 配置 | Any | Overall | Answer accuracy | 平均记录数 | 说明 |
|---|---:|---:|---:|---:|---|
| 历史基线（07-28／08-01 wide20） | 94.15% | 87.95% | — | ~12 | `bge-en` + 固定 top-20 |
| 修复后固定 top-20 | 94.15% | 87.95% | 81.2% | 15.1 | 报告称精确复现 |
| **修复后 dynamic init13（无 strong hit）** | **95.19%** | **89.71%** | **82.3%** | 20.5 | 本次报告高于固定基线 |
| 漂移期固定 top-20（`qwen3` 默认） | 76.0% | 62.3% | — | 12 | 漂移期对照 |

报告称，在该矩阵中，dynamic QPP init13 加 Fibonacci progression、关闭 strong-hit，高于固定 top-20：any +1.04 个百分点、overall +1.76 pp、answer accuracy +1.1 pp（81.2% → 82.3%）。类别 answer accuracy 变化包括 single-session-preference 73.3 vs 66.7（+6.6 pp）、single-session-assistant 98.2 vs 94.6（+3.6 pp）、knowledge-update 86.8 vs 84.6（+2.2 pp）、multi-session 75.8 vs 74.4（+1.4 pp）；single-session-user（-1.5 pp）与 temporal（-0.7 pp）略有回退。平均记录数从 15.1 增至 20.5，因此 QPP progression 期间 token 用量更高。

## 记录的教训

- Embedding profile／template 错误可能是静默的：没有异常，只是排序变差。Index-ID hash 变化和 cache 全失效是配置漂移的早期信号。
- 比较历史基线前，先确认配置可复现。本案例报告将 18 pp 差距归因于配置而非检索机制；同 commit 重跑和类别级对比有助于定位。
- 默认值应考虑模型族：BGE → `bge-en`，不要将 Qwen3 模板应用于所有 OpenAI-compatible endpoint。

本文所有 benchmark 数值仍绑定历史数据集、配置与 run；源码默认值本身不是新的 benchmark receipt。