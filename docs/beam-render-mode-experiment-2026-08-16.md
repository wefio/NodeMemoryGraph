# BEAM 渲染模式实验与默认选型（2026-08-16）

## 问题定义

记忆检索呈现层（search_context 的行前缀/链块格式）对 LLM 回答质量的影响——尤其对 **event_ordering**（事件时序判断）维度。数字序号（`1. 2. 3.`）会让模型把检索排名当成时间顺序，污染时序判断；需要找到对时序最友好的呈现格式。

## 实验设计

- **数据**：BEAM smoke8 小样本（conv 1-8，probing 只留 `event_ordering`，16 问）
- **Judge**：3-run LLM-as-a-Judge 平均（`nugget_score = mean(run_scores)`），消 judge 噪声
- **同参数**：全部模式用同一组评测参数（新参数：**思考关闭** + `max_tokens=1000`——answer 34s + judge 17s，旧参数小时级，几十倍提速）
- **6 渲染模式**（`MemoryRenderMode`）：`numeric` / `none` / `alpha` / `id` / `idbare` / `idtime`

## 结果（同参数 3-run，event_ordering）

| 渲染 | 行格式 | Nugget |
|---|---|---|
| numeric | `1. 2. 3.` | 0.2106 |
| none | 无前缀 | 0.2181 |
| idbare | `<短id> [time]` | 0.2265 |
| alpha | `A. B. C.` | 0.2284 |
| id | `<A:短id>`（temporal 无 [time]）+ timeline 块 | 0.2484 |
| **idtime** | `<A:短id> [time]`（无 timeline 块） | **0.2549** |

## 结论

1. **数字序号最差**（0.211）——`1. 2. 3.` 前缀让模型把检索排名当时间顺序，实测伤害 event_ordering。
2. **字母有真实正面价值**：idtime（带字母 0.255）> idbare（无字母 0.227）——字母承担读序提示且不触发"序号=时间"联想，不只是中性。
3. **短id 是有效引用不是噪声**：`<A:短id>`（0.248-0.255）> 纯 `A.`（0.228）——真实 memory_id 引用让模型能对应行与链块。
4. **`[time]` 在行上比 timeline 块更直接**：idtime（行 [time]，0.255）> id（timeline 块，0.248）——模型不用去独立块找时间。
5. **最优组合**：`<A:短id> [time]`（字母读序 + 短id 引用 + 行上时间，无 timeline 冗余）。

**决策**：默认渲染 `numeric → idtime`（commit `3838eece`）。

## 相关论文调研

### RAG 位置偏差（数字序号的伤害机制）
- **Do RAG Systems Really Suffer From Positional Bias?**（EMNLP 2025, aclanthology.org/2025.emnlp-main.1422）——位置偏差同时影响模型利用相关段落的能力与对干扰段的抵抗力。
- **Lost in the Evidence? Reproducing Document Position and Context Size Effects in RAG**（arxiv 2605.27105）——文档位置/上下文大小效应的系统性复现（lost in the middle 类现象）。
- **Dynamic Context Selection for RAG: Mitigating Distractors and Positional Bias**（arxiv 2512.14313）——干扰物 + 位置偏差的上下文选择缓解。

### 时间推理（[time] 标注的意义）
- **Are Large Language Model Temporally Grounded?**（NAACL 2024, 2024.naacl-long.391）——LLM 对文本叙事的常识时间结构/事件排序/时间线的一致性。
- **TimeBench: A Comprehensive Evaluation of Temporal Reasoning**（ACL 2024, 2024.acl-long.66）——层次化时间推理基准（含事件排序）。
- **Test of Time: A Benchmark for Temporal Reasoning**（arxiv 2406.09170）——时间推理评测。
- **Discrete Minds in a Continuous World: Do Language Models Know Time Passes?**（EMNLP Findings 2025, 2025.findings-emnlp.1016）——Token-Time Hypothesis：LLM 把 token 数映射为墙钟时间。

### 上下文顺序敏感（呈现格式影响推理）
- **Where to show Demos in Your Prompt: A Positional Bias of In-Context Learning**（EMNLP 2025, 2025.emnlp-main.1503）——demo/系统提示位置漂移导致预测与准确率大幅波动。
- **Addressing Order Sensitivity of In-Context Demonstration Examples in Causal Language Models**（ACL Findings 2024, 2024.findings-acl.386）——因果 LLM（自回归掩码）对示例顺序更敏感——对应我们"数字序号诱导顺序联想"的机制。
- **What Makes a Good Order of Examples in In-Context Learning**（ACL Findings 2024, 2024.findings-acl.884）——示例顺序从近随机到近 SOTA 的波动。

## 与文献的关系

- 数字序号的伤害 = **位置/顺序偏差**（RAG positional bias + ICL order sensitivity）：显式序号把"列表排名"固化为语义顺序，因果 LLM 自回归掩码放大其影响。
- `[time]` 的直接标注 = 把**时间信息显式化**（时间接地性，temporal grounding），减少模型从文本隐含推断的负担。
- 字母 + 短id 引用 = 呈现格式影响推理（context placement / structured presentation），字母规避"数字=顺序"联想、短id 提供稳定实体引用。

## 评测参数（顺带落地）

- BEAM answer/judge 全部 LLM 调用：**思考关闭**（`extra_body={"thinking":{"type":"disabled"}}`，deepseek-v4-flash 默认思考开）+ `max_tokens=1000`——answer 34s + judge 17s（旧参数小时级）。
