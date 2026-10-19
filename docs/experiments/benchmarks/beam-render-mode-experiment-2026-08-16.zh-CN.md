# BEAM 渲染模式实验与选型（2026-08-16）

[English](beam-render-mode-experiment-2026-08-16.md) | [简体中文](beam-render-mode-experiment-2026-08-16.zh-CN.md) · [术语](beam-render-mode-experiment-2026-08-16.terms.yaml)

**状态：**历史 16 问渲染实验。下方数值和所记录的选型来自 2026-08-16 笔记；本次文档审计未复现原始 run artifacts。原实现章节不是当前源码契约：当前 checkout 中没有 `MemoryRenderMode`、`idtime` 或 `renderMode` 标识符。不能只凭本实验推断当前输出格式。

## 问题与 protocol

实验询问检索记忆的呈现方式——行前缀与链块——是否影响 BEAM `event_ordering`。假设是数字列表前缀可能被误认为时间顺序。实验使用 BEAM `smoke8`（对话 1–8），只保留 `event_ordering`（16 问），报告三次 LLM judge run 的 Nugget 均值。六种模式均使用相同参数：关闭 thinking，`max_tokens=1000`。

## 报告中的结果

| 模式 | 记录的行格式 | Nugget |
|---|---|---:|
| `numeric` | `1. 2. 3.` | 0.2106 |
| `none` | 无前缀 | 0.2181 |
| `idbare` | `<short-id> [time]` | 0.2265 |
| `alpha` | `A. B. C.` | 0.2284 |
| `id` | `<A:short-id>`（temporal 行无 `[time]`）加 timeline 块 | 0.2484 |
| `idtime` | `<A:short-id> [time]`，无 timeline 块 | **0.2549** |

在这个样本中，`numeric` 得分最低，`idtime` 最高。笔记记录的选择是用 `idtime` 替代 `numeric`（commit `3838eece`）。这些结果不能证明普遍的呈现效应、回答质量提升或当前默认值。

## 解释边界

原笔记提出：字母标签可能减少数字顺序启动；短 ID 可能帮助对应行与链成员；行内 `[time]` 可能比独立 timeline 块更易使用。这些解释没有通过单独的因果实验隔离；六种格式在多个特征上有差异。应将它们视为与观察排序相符的假设，而非已确立机制。

原笔记还报告，实验实现的类型保留了六个值，但运行时只渲染 `idtime`，其他分支以注释形式保留。这只是历史实现证据。断言当前默认值前，必须检查当前 formatter owner。

## 原笔记记录的研究参考

以下引用作为原笔记的书目保留，本次未独立重新评估：

- *Do RAG Systems Really Suffer From Positional Bias?*（EMNLP 2025，`2025.emnlp-main.1422`）
- *Lost in the Evidence? Reproducing Document Position and Context Size Effects in RAG*（`arXiv:2605.27105`）
- *Dynamic Context Selection for RAG: Mitigating Distractors and Positional Bias*（`arXiv:2512.14313`）
- *Are Large Language Model Temporally Grounded?*（NAACL 2024，`2024.naacl-long.391`）
- *TimeBench: A Comprehensive Evaluation of Temporal Reasoning*（ACL 2024，`2024.acl-long.66`）
- *Test of Time: A Benchmark for Temporal Reasoning*（`arXiv:2406.09170`）
- *Discrete Minds in a Continuous World: Do Language Models Know Time Passes?*（EMNLP Findings 2025，`2025.findings-emnlp.1016`）
- *Where to show Demos in Your Prompt: A Positional Bias of In-Context Learning*（EMNLP 2025，`2025.emnlp-main.1503`）
- *Addressing Order Sensitivity of In-Context Demonstration Examples in Causal Language Models*（ACL Findings 2024，`2024.findings-acl.386`）
- *What Makes a Good Order of Examples in In-Context Learning*（ACL Findings 2024，`2024.findings-acl.884`）

当前实现和产品行为应以当前 renderer 源码及其测试为准，而不是本文历史实验。