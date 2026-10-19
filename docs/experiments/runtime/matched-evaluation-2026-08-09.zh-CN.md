# 配对 LongMemEval 后端探针 — 2026-08-09

[English](matched-evaluation-2026-08-09.md) | [简体中文](matched-evaluation-2026-08-09.zh-CN.md) · [术语](matched-evaluation-2026-08-09.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史记录，其配置、测量结果和实现状态不是当前测试回执，也不授权默认策略。本轮未重跑实验，未独立复核原始运行产物。

## 七问后端探针 — 2026-08-09

这是一次七问的工程探针，不是排行榜结果。它从本地抽样的每个 LongMemEval 类别中各取一个固定案例，重复一次，用 DeepSeek V4 Flash 作答与判定，问题级 worker 为两个。retrieval-sufficiency LLM judge 被关闭；答案判定与官方 session-ID 检索指标保持启用。

结果：`evals/longmemeval/results/2026-08-09T06-02-44.178Z/report.json`

| 组 | 答案 | 官方 recall-any | 官方 recall-all | 平均答题延迟 |
| --- | ---: | ---: | ---: | ---: |
| 无记忆 | 1/7 (14.3%) | n/a | n/a | 3.26 s |
| Flat hybrid | 7/7 (100%) | 本次 run 未记录 | 未记录 | 4.09 s |
| NMG Lite | 5/7 (71.4%) | 85.7% | 71.4% | 10.36 s |
| NMG Graph | 5/7 (71.4%) | 100% | 71.4% | 11.16 s |

样本太小，无法据以做能力排序。它确实确立了配对 protocol 可执行，以及 NMG 相对于无记忆组增加了有用的记忆。在这个小样本中 flat 检索取胜，但每题约注入 3,003 个估算 token，而 Lite 为 1,137、Graph 为 931。NMG 的额外延迟主要来自更多的模型轮次：平均工具执行时间为 104 ms（Lite）与 129 ms（Graph），而模型流式时间为 7.34 s 与 7.94 s。本地检索分段的耗时通常以毫秒计。

两个 NMG 答案失败在诊断上并不相同：

- 一个多 session 的衣物计数问题检索到了相关 evidence，但模型错误地解释了状态／更新序列。
- Graph 为一个时间问题检索到了全部官方标注的 session，但模型拒绝把对话日期当作事件日期。这是答案／推理策略失败，不是 evidence-recall 失败。

这次 run 的第一次尝试暴露了一个 SQLite 表达式深度失败：一条长记录产生了超过一千个 supersession prefilter term。报告记录了把 prefilter 限制为 64 个选择性 term 的修复，以及一个 1,500 个 term 的 regression test。成功的重跑还暴露出错误的 daemon 数量上限告警：旧 descriptor 的 PID 被存活的 Pi 进程复用。daemon 计数现在要求经过认证的 `hello` 响应，并对重叠的扫描根去重；记录称 run 结束后没有 daemon 残留。这些是历史工程观察，不是新回归回执或当前 daemon discovery 契约；当前行为由 [daemon lifecycle owner](../../design/daemon-lifecycle-design.zh-CN.md)负责。

后续报告会为 flat 检索也计算官方 session recall。本次 run 早于那次最终报告改动，因此其 flat 的官方单元格保持 `null`，而不是事后重建。

## 因果 controller protocol 更新 — 2026-08-20

`matched` 现在指因果 controller 对比，而不是只做记录的 shadow 组。它要求一个冻结、已训练的 controller artifact：

```bash
NMG_CONTROLLER_CANDIDATE_STATE=/path/to/controller-shadow-state.json \
  npm run eval:longmem -- matched 1
```

deterministic 组与 candidate NMG 组共享 QPP1／QPP2 机制、语料、prompt、模型、thinking level 与硬预算。只有 candidate 组接收已验证的 controller state。报告记录其 SHA-256、feature protocol、训练步数、各组环境，以及运行时的 `allocate|fold|rerank` 动作。官方计分从这些动作推导因果资格，不再信任静态的 `controllerAffectsRanking` 声明。

单问题 `6a1eabeb` smoke 使用了 25 步的本地 candidate，记录到两个动作，其中一个改变了检索投影。两个 NMG 组都在相同的官方检索下正确作答（recall 0.5，NDCG 0.613）；candidate 的披露文本从 3,368 字符降到 981 字符。这是执行路径检查，不是对 controller 质量的估计，也不是排行榜结果。

## 证据多样的开发对比 — 2026-08-20

下一次因果 run 使用固定的 `development-v1` manifest：14 个 LongMemEval-S 问题，七个问题类别各两个，重复一次，四个问题级 worker，启用 retrieval judging，并使用同一个 25 步冻结 candidate（`sha256:1560273cd79c933a0f733d149ead4e0a328a6279868defe243e4371b4c1441f3`）。全部 14 个 candidate 案例都记录了至少一个改变排序的 controller 动作。run 与官方分数位于 `evals/longmemeval/results/2026-08-20T11-53-32.753Z/` 下；生成的结果文件被 Git 忽略。

| 组 | 官方答案准确率 | 官方 evidence 充分性 | 平均工具轮次 | 平均 tokens | 平均端到端延迟 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 无记忆 | 2/14 (14.3%) | n/a | 0.00 | 766 | 4.69 s |
| Deterministic NMG | 9/14 (64.3%) | 9/14 (64.3%) | 2.07 | 17,850 | 9.00 s |
| 冻结 candidate NMG | 12/14 (85.7%) | 11/14 (78.6%) | 2.36 | 24,068 | 11.26 s |

candidate 相对 deterministic NMG 增加了三次答案胜出，没有答案损失。平均官方 session recall 从 0.762 升到 0.905，NDCG 从 0.769 升到 0.858。诊断性的 retrieval-sufficiency judge 更为乐观（7/14 到 12/14），但晋升使用的是上面那个官方的、基于 ID 的 evidence 指标。这个 14 对的结果达到了产品 gate 的最低案例数，但配对答案差异在统计上仍然很弱（精确双侧 McNemar p=0.25），且该 manifest 是本地开发样本，不是排行榜划分。

这个增益并非免费。相对 deterministic NMG，平均 tokens 增加 34.8%，平均端到端延迟增加 25.2%，平均工具轮次增加 13.8%。因此把官方分数送入 `eval:controller` 虽通过了 controller 质量 gate，却未通过产品 gate 的 token 与延迟界限。独立的 20 案例 LoCoMo 检索 gate 也在 recall 上失败，使资格停留在 `shadow=true`、`active=false`、`defaultPi=false`。这次 run 补上了缺失的、达到 gate 规模且证据多样的因果工程对比；它不替代配对的自然 Pi 观测，也不构成晋升理由。
