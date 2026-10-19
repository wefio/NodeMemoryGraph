# LoCoMo evidence-mode 信号审计（2026-08-02）

[English](locomo-evidence-mode-signal-2026-08-02.md) | [简体中文](locomo-evidence-mode-signal-2026-08-02.zh-CN.md) · [术语](locomo-evidence-mode-signal-2026-08-02.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史实验记录。下文的配置、测量、实现描述和后续建议均限于当时实验。本轮未重跑实验，也未独立复核原始产物；这些内容不是当前测试回执、默认策略决定或通用保证。

## 问题

来自三路 weighted RRF 路径的、不依赖标签的检索信号，能否区分只需要一条 evidence 记录的问题与需要多条记录的问题？同样的信号能否预测可见的 Top-20 是否已经 evidence-complete？

## 协议

- 数据集：官方 OmniMemEval LoCoMo `locomo10.json`。
- 被评估的问题：1,978 个，其 evidence ID 可解析到对话轮次。
- 标签：`multi_evidence = unique evidence IDs > 1`；`complete@20 = every evidence ID appears in the fused Top-20`。
- 检索：BGE-small record 向量；原始查询、Top-1 反向查找与 QPP2 反向查找；weighted RRF；检索与特征构造过程中都不使用标签。
- 特征：Top-1 cosine、Top-1 gap、route support、RRF concentration、QPP2 Top-1 probability mass、effective candidate count 与 local diversity。
- 评估：按 LoCoMo 对话分组的五折。不调用 LLM。

运行：

```powershell
.benchmarks\omni-venv\Scripts\python.exe `
  evals\omnimemeval\research\audits\audit-evidence-mode-signal.py `
  --data .benchmarks\official\OmniMemEval\data\locomo\locomo10.json `
  --output evals\results\locomo-evidence-mode-signal.json
```

## 结果

| 目标 | 出现率 | AUC | Balanced accuracy |
|---|---:|---:|---:|
| Multi-evidence | 21.44% | 0.513 | 0.509 |
| Complete@20 | 43.88% | 0.665 | 0.617 |

最好的单项完备性信号是 QPP2 Top-1 probability mass（AUC 0.655）。最好的单项 multi-evidence 信号是 effective candidate count（AUC 0.547），它仍然太弱，不能用作决策边界。

## 决定

不要把 `single` 与 `multi` 作为已断言的 NMG prompt 信号暴露出去。当前的分数分布无法识别 evidence cardinality。candidate 数量不是 evidence 数量，而 route 一致性在这里几乎没有信息量。

保留 evidence completeness 作为 shadow 信号。它足以用来测试一个稳定的 prompt 契约，例如 `completeness=low|uncertain|high`，但还不足以用于停止检索或授权回答。应先在 held-out 数据上校准它，并测量 selective risk，然后再接入 Pi adapter。
