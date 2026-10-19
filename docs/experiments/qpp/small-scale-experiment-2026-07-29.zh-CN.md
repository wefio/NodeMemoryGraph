# QPP 小规模配对实验（2026-07-29）

[English](small-scale-experiment-2026-07-29.md) | [简体中文](small-scale-experiment-2026-07-29.zh-CN.md) · [术语](small-scale-experiment-2026-07-29.terms.yaml)

> **状态：**历史方向性研究，仅使用 LongMemEval-S 连续 10 个 multi-session 样本（原始索引 70–79）。这不是完整 benchmark；答案由人工对照，未由官方 judge 评分；本轮文档整理没有重新运行实验。实验中的 `NMG_QPP_SECOND_PASS` 开关属于历史配置；当前各调用方默认值见[QPP 设计](../../design/retrieval-confidence-controller.zh-CN.md)。

## 目标

验证同池重选是否能在不进行第二次 ANN 搜索的情况下，找回被正常 `topK`／token 预算截断的多 session evidence。

## 对照设置

两组使用相同的数据、BGE embedding、候选池和 `topK=20`：

- Normal：`NMG_QPP_SECOND_PASS=0`
- Adaptive：`NMG_QPP_SECOND_PASS=1`

Adaptive 在扩展预算下从首趟检索已生成的候选池重新选择，不重新计算 embedding，也不进行第二次 ANN 搜索。

回答阶段每组各调用 10 次，使用相同的官方 LongMemEval answer prompt 和 `deepseek-chat`（当时标注为 DeepSeek v4-flash），temperature 沿用官方流水线设置。没有运行额外的 LLM judge。

## 检索结果

| 指标 | Normal | Adaptive | 变化 |
| --- | ---: | ---: | ---: |
| 严格 evidence 命中 | 22 / 32 | 27 / 32 | +5 |
| Evidence recall | 68.75% | 84.38% | +15.63 pp |
| 至少命中一条 evidence 的问题 | 9 / 10 | 9 / 10 | 0 |
| 命中全部 evidence 的问题 | 5 / 10 | 8 / 10 | +3 |
| 平均上下文字符数 | 3,470 | 7,421 | 2.14× |
| 平均搜索延迟 | 3,789 ms | 3,782 ms | -7 ms |

配对结果：4 个问题增加了 evidence 命中；5 个问题保持完整；1 个问题两组都没有命中 evidence；没有问题出现 evidence recall 退化。

延迟差异小于该样本预期的测量噪声，不能据此主张性能提升。可观察到的代价是 reader 上下文增长，而不是池内重选本身。

## 回答结果

人工对照参考答案后，Normal 约为 8/10 正确，Adaptive 约为 9/10。最明确的改善是一道自行车支出题：Normal 缺少头盔记录，回答 `$65`；Adaptive 找回该证据后回答参考答案 `$185`。

两个反例限定了结论边界：

1. 项目数量问题在两组中都缺少证据并保持错误；重选无法找回候选池之外的记录。
2. 衣物数量答案仍然错误，尽管 Adaptive 多检索到一条 evidence；检索覆盖不能替代 reader 的聚合或计数能力。

答案准确率未由官方 LLM judge 评测，因此这些答案只能作为方向性诊断，不能作为可比较的 LongMemEval 分数。

## 结论

该实验报告了一种有限能力：如果正确 evidence 已经进入过采样候选池、只是被常规展示预算隐藏，同池重选可以用很少的本地计算提高 evidence recall。

实验也显示了无条件扩展的代价：平均上下文增长到 2.14 倍，10 个上下文全部变长，一个样本从 2,928 字符膨胀到 16,534 字符。一些额外 evidence 没有改善答案。因此报告建议先提升触发选择性，再继续扩展预算。

## 当时工程审查记录

1. 当时使用的 OmniMemEval bridge 没有启用 `secondPass`，因此此前的 benchmark 结果没有测试该功能。报告增加了 `NMG_QPP_SECOND_PASS=1` 显式 opt-in；当时默认仍关闭。
2. Stage 0 是同池重选，不是第二次检索。
3. `expandActiveGraphBudget()` 会增加 `maxGraphHops`，但关系扩展在预算升档前已经执行，升档后没有重跑；因此该实验实际上没有增加图跳数。
4. benchmark memories 全部存为 `conversation_evidence`，所以这些数据中的 `intentCoverage` 几乎是常数，无法有效区分触发条件。
5. “首次选择发生截断”出现得太频繁，不足以成为选择性触发器，Adaptive 因而近似于无条件扩展。

以上是当时代码与实验的发现；当前实现边界和调用方默认值见[QPP 设计](../../design/retrieval-confidence-controller.zh-CN.md)。

## 历史后续实验提案

原记录建议在不增加 LLM 或 embedding 调用的前提下：

1. 区分 `evidence-truncated` 与 `token-truncated`，测量哪种截断与召回增益相关。
2. 比较扩展前后的边际分数、冗余度以及新增 evidence 的多样性。
3. 离线回放 `1.25×`、`1.5×`、`2×` 扩展倍率，而不是固定一种倍率。
4. 在改变可见上下文前，先以 shadow policy 记录触发决策。
5. 只有离线结果显示具备选择性时，再进行另一批 10–20 个配对模型样本。

这是历史提案，不是当前实施计划。