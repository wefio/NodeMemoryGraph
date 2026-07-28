# QPP 工程经验：审计暴露的两个问题

> 伴随 commit dd41829（QPP shadow wiring）→ d86b658（squash 修复）之间的复盘。
> 记录"为什么发生"和可迁移的教训，不重复设计文档（见 retrieval-confidence-controller.md）。

## 问题 1：clamp 归一化饱和，qpp 无区分度

**现象**：在 7 题 LongMemEval run 上跑 `audit-qpp-signal.ts`，qpp 双峰 0.15（空检索）/ 1.35（非空），两桶准确率均 0.33——完全无区分度。

**根因**：`mapSearchResult`（`store.ts:3835`）设 `combinedScore = score`（原始词法分，实测 ~84），**不是 `hybridScore`（≤1）**。而 `contextUsefulness = combinedScore + bonus` 也在词法量纲。QPP 初版对 usefulness 做 `clamp(0,1)` → 非空检索时 usefulness 全部 >1 → 饱和到 1.0 → **top1 恒 1.0、variance 恒 0**。公式塌缩成"检索有没有返回东西"的二元值。

**教训**：
- **不要假设分数尺度**。combinedScore / usefulness 的量纲是从代码路径（mapSearchResult 设值）决定的，不是 [0,1]。归一化实现前必须在真实 trace 上验证分数分布，否则 clamp/sigmoid 这类有界函数会静默饱和。
- 单元测试用的是人造 [0,1] usefulness，掩盖了真实量纲问题。**信号分量的测试要包含真实量纲的样本**（这里就是 ~84 的词法分），不只干净的小数。

**修复**：bounded-squash `s(x)=max(0,x)/(max(0,x)+10)`（同 `boundedLexical` 惯例），替 clamp。84→0.894 / 20→0.667 / 5→0.333，恢复 gradation。见 commit d86b658。

## 问题 2：intentCoverage 在所有 benchmark 上退化

**现象**：7/7 题 intentCoverage=0.5（中性，无信号）。

**根因**：`evals/longmemeval/run.ts:316` 硬编码 `memoryType: "conversation_evidence"`。**所有 benchmark（LongMemEval / LoCoMo / PersonaMem / BEAM）的 ingest 都这么存**——无 preference/fact/event 等类型记忆。intentCoverage 双重失效：查询多不命中意图正则（AutoRecall 的 query 是整段 prompt）；命中时库里也无对应类型。所以该分量在任何 benchmark trace 上恒 0.5/0。

**教训**：
- **benchmark 的 ingest shape 会让信号退化**。intentCoverage 设计上依赖类型化记忆，但 benchmark 全存 conversation_evidence → 信号在目标数据上恒定。信号分量要在目标数据形态上验证，不只单元测试。
- 评估一个分量是否有用，先看它在真实 trace 上的方差——恒常数即无区分度，权重再学也是 0。

**未解**：要验 intentCoverage 必须有类型化 ingest——真实 Pi session（`nmg_remember(memoryType:"preference")`）或改 benchmark ingest 抽类型。当前所有 benchmark trace 都不行。

## 方法论收获（最有价值的部分）

1. **shadow-first 让 bug 廉价暴露**：QPP 先"算+记到 trace"不改检索行为（shadow），使 qpp 在真实检索上可观测却零风险。审计正是靠 shadow 记录的 selections 才离线重算出 qpp、抓到饱和 bug。若直接上线触发，bug 会以"误触发/漏触发"的形式隐秘生效，难定位。

2. **离线重算模式**：qpp 是持久化 `selections_json` + `memory_records` 的纯函数 → 可在历史 trace 上重算，**无需重跑 LLM**（不花 API、不依赖 deepseek judge）。这是标定/审计工具的通用模式：凡纯函数 of 持久化状态，都能离线 replay。`audit-qpp-signal.ts` 即此模式的实例。

3. **审计先于标定**：在学权重/阈值（Stage 1 贝叶斯优化）前，必须先验证各分量在真实数据上有 gradation。否则在小 N（7 题）上学到的是噪声，且分量退化（如 intentCoverage 恒 0.5）会让学出的权重无意义。**标定流程第 1 步永远是"看分量分布"，不是"调权重"**。

## 指向下一步

- intentCoverage 数据缺口 → 需类型化 ingest（独立工作流，非 QPP bug）。
- Stage 0 plumbing（第二趟+expandedMaximum+统一池）→ 才能跑全贝叶斯目标（"触发后变对"需第二趟真跑）。
- 标定前先在更大/更杂的 trace 上重跑审计，确认 top1/variance 有 gradation（squash 后已恢复）。
