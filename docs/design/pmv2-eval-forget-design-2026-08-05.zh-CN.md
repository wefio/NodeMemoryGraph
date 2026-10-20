# PersonaMem v2 评测与 Forget 渲染（2026-08-05）

[English](pmv2-eval-forget-design-2026-08-05.md) | [简体中文](pmv2-eval-forget-design-2026-08-05.zh-CN.md) · [术语](pmv2-eval-forget-design-2026-08-05.terms.yaml)

历史评测与设计记录。下方 run 数值转录自 2026-08-05 报告，本次文档审计没有复跑。旧 runner 的基础设施记录不是当前工作流说明；当前配置请使用 [OmniMemEval 评测 Skill](../../.pi/skills/omnimemeval-eval/SKILL.md)。

## Forget 渲染决策

报告记录了一个选择：为 forgotten memory 保留有限身份元数据，同时从 Agent-facing context 中隐藏 statement。可见标记为 `[forget] (content withdrawn)`。预期边界是：Agent 能识别存在撤销记录，但拿不到可引用或重建的内容。

当前代码 owner 包括 [`src/integration/search-projection.ts`](../../src/integration/search-projection.ts)、[`src/integration/agent-surface.ts`](../../src/integration/agent-surface.ts)、共享提示词 [`src/prompts/nmg-prompts.yaml`](../../src/prompts/nmg-prompts.yaml)，以及[共享披露决策](../decisions/implemented/2026-10-10-shared-disclosure-copy.zh-CN.md)。扩展测试检查 forgotten content 不会出现在 search headers 或格式化后的 exact-lookup context 中（[`tests/extensions/nmg/index.test.ts`](../../tests/extensions/nmg/index.test.ts)）。这些当前 owner 取代历史报告中的旧措辞和 adapter 列表。

## 报告中的 PersonaMem v2 样本

报告描述了 60 问、三次 run：

| 渲染方式 | Run label | `ask_to_forget` 重叠计数 | 整体准确率 |
|---|---|---:|---:|
| 原文加标记 | `155659` | 4/11 | 0.300 |
| 脱敏内容 | `165251` | 4/11 | 0.267 |
| 元数据加脱敏 | `omnimemeval_20260805` | 0/11 | 0.317 |

报告称，脱敏 run 的 11 个 context 均不含 forgotten 原文。但泄漏指标并非脱敏效果的结果指标：选项文本本身包含撤销短语；答案只是多选字母，没有来源信息；三次 run 的准确率也有波动。因此这些数值不能证明某种渲染方式带来了因果行为收益。决策依据是语义边界——不披露已撤销内容——而不是这个噪声较大的指标。

## 评测工作流边界

旧笔记中的临时 CSV 截断、Python 编码、文件锁重试和 runner 命令，描述的是有日期的调试过程，不应照搬为当前说明。当前 benchmark 入口、配置与复用规则归 OmniMemEval Skill 和 `evals/omnimemeval/` owners 管理。历史 benchmark 数值必须绑定其数据集、模型、提示词、judge 和样本；没有可复现 receipt 时，不是当前 baseline。