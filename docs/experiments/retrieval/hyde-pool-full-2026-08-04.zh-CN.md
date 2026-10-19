# LongMemEval 上的池感知 HyDE——全语料结果

[English](hyde-pool-full-2026-08-04.md) | [简体中文](hyde-pool-full-2026-08-04.zh-CN.md) · [术语](hyde-pool-full-2026-08-04.terms.yaml)

证据边界（2026-10-17 文档审阅）：本带日期记录属于历史研究材料，不是当前 runtime 契约，也不授权运行 provider 实验。本轮未重跑所引实验，未独立复核原始运行产物。

日期：2026-08-04 · 分支：nmg_search 高级语法 + 多子句融合

## 测试内容

用户指定的面向 agent 的流程——*先取推荐池，再用以池为依据的假设答案做第二次检索*：

```
① auto-recommend: searchContext(question)            → recommendation pool
② pool-aware HyDE: LLM reads question + top-10 pool → hypothetical answer
③ second search:  searchContext(hyde clause)
④ fusion:         baseline ∪ hyde-only results (memory.id dedup)
```

## 召回结果（官方指标对齐）

检索配置精确复现了官方 bridge（除 assistant-evidence 查询外 sourceActor=user，limit 20，secondPass 关闭，bge-en embeddings），因此重算的基线与官方固定 top-20 运行逐位相同：

| 指标 | 基线 | + 池感知 HyDE | Δ |
|---|---|---|---|
| 任一证据召回 | 94.15%（451/479） | **96.66%**（463/479） | **+2.51pp** |
| 证据召回 | 87.95% | **92.52%** | **+4.58pp** |
| 挽回的问题 | — | 12（8,30,108,134,288,291,295,302,305,445,456,498） | — |
| 回退 | — | 0 | — |
| 错误 | — | 0 | — |

召回表的分母为 479 题，后面的答案／判定阶段报告 500 题成功；其余 21 道已判定题未计入该召回分母，本页未给出逐题映射。另外，显示的四舍五入后 evidence-recall 数值相减为 4.57pp，而原表报告 +4.58pp。底层数值舍入可能解释 0.01pp 差异，但本轮未重新核对底层计数；+4.58pp 按原报告保留，不表示已独立验证。

挽回集中度：temporal-reasoning（HyDE 从池中恢复出问题本身没有提及的日期／实体锚点）。成本：每题 +1 次 LLM 调用（deepseek-chat，约 200 个输出 token）+ 1 次融合检索。

已记录的坑：更早一次未加 sourceActor 过滤的运行复现出 89.35% 的基线（混合来源的 candidate 池），并高估了 HyDE 的差值（+3.97pp）；对齐之后真实差值为 +2.51pp。

## 判定准确率（真实 LongMemEval 分数）

答案 + 判定在融合后的上下文上运行（`results/lme/nmg-hyde-pool/`），回答与判定均使用 deepseek-chat，使用与官方固定 top-20 基线（81.2%）相同的提示词和相同的 `audit-lme-judged.py`。

| | 基线固定 top-20 | + 池感知 HyDE | Δ |
|---|---|---|---|
| **总体准确率（官方 LLM-as-a-Judge）** | **81.2%** | **85.0%** | **+3.8pp** |
| knowledge-update | 84.6%（78） | 85.9%（78） | +1.3 |
| multi-session | 74.4%（133） | **82.7%**（133） | **+8.3** |
| single-session-assistant | 94.6%（56） | **100.0%**（56） | +5.4 |
| single-session-preference | 66.7%（30） | 63.3%（30） | **−3.4** |
| single-session-user | 92.9%（70） | 94.3%（70） | +1.4 |
| temporal-reasoning | 77.4%（133） | 80.5%（133） | +3.1 |
| 上下文 tokens / 题 | 856 | 1100 | +28% |

注：判定温度 0，两步均报告 500/500 成功。温度 0 不保证托管模型输出在重跑时逐次一致；回答与判定使用同一模型，因此不构成独立质量验证。multi-session 是最大收益（HyDE 把跨会话细节缝合进上下文）；preference 是唯一回退的类别（假设性推荐可能引入噪声）。运行产物：`results/lme/nmg-hyde-pool/`。

## 工程产物

- `evals/omnimemeval/research/probes/hyde-probe.mjs`——小批量探针（在官方失败集上比较普通 vs 池感知 HyDE：28 题中分别挽回 +5 与 +9）
- `evals/omnimemeval/research/probes/hyde-full.mjs`——全语料召回探针（可续跑，与官方指标对齐）
- `evals/omnimemeval/research/probes/hyde-context.mjs`——生成融合检索结果产物（与 bridge 一致的渲染），供答案 + 判定使用
- `src/core/store/advanced-query.ts` + `nmg_search queries[]`——引擎的通用多查询接口，用于提交调用方生成的 HyDE 子句；HyDE 生成本身仍在 NMG 之外
