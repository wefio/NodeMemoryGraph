# LoCoMo QPP safe-prefix 评测（2026-07-29）

[English](locomo-qpp-safe-prefix-2026-07-29.md) | [简体中文](locomo-qpp-safe-prefix-2026-07-29.zh-CN.md) · [术语](locomo-qpp-safe-prefix-2026-07-29.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史实验记录。下文的配置、测量、实现描述和后续建议均限于当时实验。本轮未重跑实验，也未独立复核原始产物；这些内容不是当前测试回执、默认策略决定或通用保证。

## 问题

当 progressive QPP recall 从 Top-20 前缀开始，而不是沿用早先的 Top-1 实验时，它能否改善端到端答案？这里的 “safe prefix” 是起始配置的名称，不保证证据保留或答案安全。

本次 run 在推理阶段有意不使用标签。官方 evidence ID 只用于 run 后的审计。QPP2 压缩保持关闭，因为完整的 evidence 实验显示，其 98% 设置仍然在 77 个问题上移除了 evidence。

## 配置

- benchmark：OmniMemEval LoCoMo，全部 1,540 个问题
- 记忆语料：既有的 NMG record-vector 语料
- embedding：本地 `BAAI/bge-small-en-v1.5`
- answer model：`deepseek-v4-flash`
- judge model：`deepseek-v4-flash`
- 官方 `top-k`：20
- `NMG_QPP_SECOND_PASS=1`
- `NMG_QPP_INITIAL_EVIDENCE_TARGET=20`
- progressive ceilings：在既有有界 candidate 池内做 Fibonacci 兼容的扩展
- result version：`qpp_i20_20260729`
- 结果目录：
  `.benchmarks/official/OmniMemEval/results/locomo/nmg-qpp_i20_20260729`

benchmark 报告的环境快照尚未包含上述两个 QPP 变量。因此它们在此记录，作为可复现契约的一部分。

## 检索 evidence 审计

| 指标                    | 固定 Top-20 参照 | QPP safe prefix |    变化 |
| ----------------------- | ---------------: | --------------: | ------: |
| 任一官方 evidence       |            68.0% |      **79.74%** | +11.74 pp |
| 全部官方 evidence       |            54.1% |      **66.49%** | +12.39 pp |
| Evidence recall         |            52.9% |      **65.55%** | +12.65 pp |
| 平均上下文字符数        |             4,458 |           7,956 |   +78.5% |
| 平均 search latency     |            314 ms |        1,325 ms |    4.22x |
| P95 search latency      |            361 ms |        4,870 ms |   13.49x |

QPP run 的分类 evidence recall：

| 类别               | Recall |
| ------------------ | -----: |
| multi-hop          | 52.95% |
| temporal reasoning | 77.01% |
| open-domain        | 41.62% |
| single-hop         | 78.44% |

固定 Top-20 的数值来自项目记录的先前匹配 BGE K20 审计。它们没有在本次 run 中重新生成，因此延迟对比应视为方向性参考，而不是受控的 microbenchmark。

## 官方答案得分

官方 OmniMemEval judge 评估了 1,536 个问题；有四个问题被 benchmark evaluator 跳过。

| 指标                     | 既有固定 Top-20 | QPP safe prefix |    变化 |
| ------------------------ | ---------------: | --------------: | ------: |
| LLM-as-Judge             |           0.6480 |      **0.7435** | +0.0955 |
| F1                       |                - |          0.3708 |       - |
| ROUGE-L                  |                - |          0.3800 |       - |
| METEOR                   |                - |          0.4226 |       - |
| 平均答案输入 tokens      |                - |         2,481.4 |       - |

QPP 分类答案得分：

| 类别               | LLM-as-Judge |
| ------------------ | -----------: |
| multi-hop          |       0.6559 |
| temporal reasoning |       0.7570 |
| open-domain        |       0.5521 |
| single-hop         |       0.7893 |

+0.0955 的对比使用的是既有固定 Top-20 结果。由于该基线没有在同一 wall-clock 窗口内重跑 answer 与 judge 调用，它表明了一个强烈的端到端信号，但还不是配对的 judge 波动估计。

## 决定

该实验通过了质量 gate：更大的 progressive recall 带来了显著的 evidence-recall 增益，而且该增益在端到端答案生成后依然存在。safe-prefix 模式应继续作为显式的 bridge 选项，而 Pi 默认值保持不变。

它没有通过效率 gate。下一步 QPP 工作不应继续扩大 candidate 池，而应：

1. 在 progressive 循环中批处理或缓存重复的本地 embedding 计算；
2. 在 OmniMemEval 的环境快照中记录 QPP 参数；
3. 让第一阶段的预算头（budget head）更具选择性，因为完整离线审计发现它几乎与 oracle Fibonacci 深度不相关；
4. 在 evidence 保留实际达到无损之前，保持 QPP2 处于 shadow 状态；
5. 仅在需要估计 judge 波动或需要达到发表级对比时，重跑配对的固定 Top-20 answer／judge 组。
