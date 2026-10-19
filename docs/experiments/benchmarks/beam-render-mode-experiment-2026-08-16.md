# BEAM Rendering-Mode Experiment and Selection (2026-08-16)

[English](beam-render-mode-experiment-2026-08-16.md) | [简体中文](beam-render-mode-experiment-2026-08-16.zh-CN.md) · [Terms](beam-render-mode-experiment-2026-08-16.terms.yaml)

**Status:** Historical 16-question rendering experiment. Values and the recorded selection below are from the 2026-08-16 note; raw run artifacts were not reproduced in this documentation pass. The original implementation section is not a current source contract: the current checkout contains no `MemoryRenderMode`, `idtime`, or `renderMode` identifier. Do not infer today's output format from this experiment alone.

## Question and protocol

The experiment asked whether the presentation of retrieved memories—row prefixes and chain blocks—affected BEAM `event_ordering`. The hypothesis was that numeric list prefixes might be mistaken for temporal order. It used BEAM `smoke8` (conversations 1–8), restricted to `event_ordering` (16 questions), and reported the mean Nugget score over three LLM-judge runs. All six modes used the same parameter set: thinking disabled and `max_tokens=1000`.

## Reported results

| Mode | Recorded row format | Nugget |
|---|---|---:|
| `numeric` | `1. 2. 3.` | 0.2106 |
| `none` | no prefix | 0.2181 |
| `idbare` | `<short-id> [time]` | 0.2265 |
| `alpha` | `A. B. C.` | 0.2284 |
| `id` | `<A:short-id>` (temporal rows without `[time]`) plus timeline block | 0.2484 |
| `idtime` | `<A:short-id> [time]`, no timeline block | **0.2549** |

Within this sample, `numeric` scored lowest and `idtime` highest. The note selected `idtime` over `numeric` (commit `3838eece`). These results do not establish a general presentation effect, answer-quality gain, or current default.

## Interpretation limits

The original note proposed that letter labels may reduce numeric-order priming, short IDs may help connect rows to chain members, and inline `[time]` may be easier to use than a separate timeline block. Those explanations were not isolated in separate causal experiments; the six formats differ in more than one feature. Treat them as hypotheses consistent with the observed ranking, not established mechanisms.

The note also reported that the experimental implementation retained six values in a type but rendered only `idtime`, with the other branches commented out. That is historical implementation evidence only. The current checkout must be inspected at its owning formatter before asserting a current default.

## Research references recorded in the original note

These citations are retained as the note's bibliography, not independently re-evaluated here:

- *Do RAG Systems Really Suffer From Positional Bias?* (EMNLP 2025, `2025.emnlp-main.1422`)
- *Lost in the Evidence? Reproducing Document Position and Context Size Effects in RAG* (`arXiv:2605.27105`)
- *Dynamic Context Selection for RAG: Mitigating Distractors and Positional Bias* (`arXiv:2512.14313`)
- *Are Large Language Model Temporally Grounded?* (NAACL 2024, `2024.naacl-long.391`)
- *TimeBench: A Comprehensive Evaluation of Temporal Reasoning* (ACL 2024, `2024.acl-long.66`)
- *Test of Time: A Benchmark for Temporal Reasoning* (`arXiv:2406.09170`)
- *Discrete Minds in a Continuous World: Do Language Models Know Time Passes?* (EMNLP Findings 2025, `2025.findings-emnlp.1016`)
- *Where to show Demos in Your Prompt: A Positional Bias of In-Context Learning* (EMNLP 2025, `2025.emnlp-main.1503`)
- *Addressing Order Sensitivity of In-Context Demonstration Examples in Causal Language Models* (ACL Findings 2024, `2024.findings-acl.386`)
- *What Makes a Good Order of Examples in In-Context Learning* (ACL Findings 2024, `2024.findings-acl.884`)

Current implementation and product behavior belong to the present renderer source and its tests, not this historical experiment.