# BEAM 100K 完整评测（2026-08-13）

[English](beam-100k-evaluation-2026-08-13.md) | [简体中文](beam-100k-evaluation-2026-08-13.zh-CN.md) · [术语](beam-100k-evaluation-2026-08-13.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史实验记录。下文的配置、测量、实现描述和后续建议均限于当时实验。本轮未重跑实验，也未独立复核原始产物；这些内容不是当前测试回执、默认策略决定或通用保证。

## 状态

首次完整的 OmniMemEval BEAM 100K NMG run，以及一个匹配的空记忆对照，均已完成。两组使用相同的 400 个问题、相同的 answer prompt、reader 与 judge。NMG 得分为 **0.6422**，无检索记忆时为 **0.2724**，配对均值增益为 **+0.3698**。这证明的是在这组固定 BEAM run 上，检索到的 NMG 上下文具有价值；它并不单独区分检索、存储、图或 QPP 各机制各自的作用。

## 固定配置

- dataset：官方 OmniMemEval BEAM，`100k` 规模；
- 问题：400 题，分布在 20 段对话中；
- memory backend：`nmg`；
- 检索：top-K 20，使用 `BAAI/bge-small-en-v1.5` record embeddings；
- QPP second pass：关闭；
- answer model：`deepseek-v4-flash`；
- judge model：`deepseek-v4-flash`，每个 rubric 条目执行一次 run；
- memory workers：2；
- NMG 组 LLM workers：32；
- 空记忆对照：自适应 worker 池，最小／初始为 16、最大为 32，按 4 题一组 checkpoint；
- 跳过失败的 search／answer／judge：全部关闭。

被忽略的本地 artifact 为：

`results/beam/nmg-nmg_beam100k_bge_records_20260726/exp_report.md`

它位于本地 OmniMemEval checkout 下。该 artifact 的 replay config 与环境快照包含当时记录的可复现元数据，且不含真实凭据。路径后缀 `20260726` 按原记录保留；它本身不能确定执行日期。运行日期应由原始 manifest 确认，而不是从文件名推断。

## NMG 结果

总体 Nugget Score：400 题上为 **0.6422 ± 0.3974**。

| 维度 | 分数 | 题数 |
|---|---:|---:|
| abstention | 0.6125 | 40 |
| contradiction resolution | 0.7500 | 40 |
| event ordering | 0.2606 | 40 |
| information extraction | 0.7776 | 40 |
| instruction following | 0.8438 | 40 |
| knowledge update | 0.5750 | 40 |
| multi-session reasoning | 0.6276 | 40 |
| preference following | 0.9187 | 40 |
| summarization | 0.3433 | 40 |
| temporal reasoning | 0.7125 | 40 |

流水线完整性方面，search、answer 与 evaluation 各自都有 400 条成功记录，没有失败或跳过的记录。

## 匹配的空记忆对照

对照保留了全部问题、rubric、prompt、reader 与 judge 设置，只把检索到的上下文替换为空字符串。因此它是一个 **empty-retrieval-context 对照**，不是官方的 raw-session／full-history reader。Answer 与 evaluation 均完成 400/400，没有失败或跳过的记录。

| 维度 | NMG | 空记忆 | 差值 |
|---|---:|---:|---:|
| **总体** | **0.6422** | **0.2724** | **+0.3698** |
| abstention | 0.6125 | 1.0000 | -0.3875 |
| contradiction resolution | 0.7500 | 0.1156 | +0.6344 |
| event ordering | 0.2606 | 0.0056 | +0.2551 |
| information extraction | 0.7776 | 0.1365 | +0.6411 |
| instruction following | 0.8438 | 0.5750 | +0.2688 |
| knowledge update | 0.5750 | 0.0000 | +0.5750 |
| multi-session reasoning | 0.6276 | 0.1129 | +0.5147 |
| preference following | 0.9187 | 0.7063 | +0.2125 |
| summarization | 0.3433 | 0.0471 | +0.2963 |
| temporal reasoning | 0.7125 | 0.0250 | +0.6875 |

在 400 道匹配问题上，NMG 胜 251 题、平 123 题、负 26 题。对逐题分数差做一次 20,000 样本的确定性配对 bootstrap，得到描述性的 95% 区间 **[+0.3205, +0.4183]**。该区间是在 run 结束后计算的，不是预先注册的验证性检验。

abstention 方向反转在预期之内：没有任何上下文时，拒绝回答缺乏支持的问题往往是正确的。NMG 的 abstention 分数更低，意味着检索到的上下文也会让 reader 回答某些本应拒绝的问题。这是一个真实的 precision／safety 回退，需要检查，而不是把它藏在为正的总体均值内部。

## 检索成本

| 指标 | 平均 | P50 | P95 |
|---|---:|---:|---:|
| add latency | 77.9 ms | 73.9 ms | 112.1 ms |
| search latency | 146.6 ms | 40.9 ms | 185.1 ms |

均值被 abstention 类别抬高（search 平均 1,072.6 ms）；其他报告维度的平均搜索耗时大多在 40–44 ms 左右。对本次 run 而言，P50 是更能代表普通查询的数字。

## 模型用量

| 阶段 | 调用数 | Prompt tokens | Completion tokens | Total tokens |
|---|---:|---:|---:|---:|
| answer | 400 | 398,392 | 952,205 | 1,350,597 |
| judge | 878 | 740,966 | 392,322 | 1,133,288 |
| 合计 | 1,278 | 1,139,358 | 1,344,527 | 2,483,885 |

judge 对每个 rubric 条目发一次请求，event-ordering 问题例外，该类使用一次 ordering 请求。因此 400 道被判定问题并不意味着 400 次 judge 调用。

## 流水线耗时与工程发现

- answer 生成：11,549 s（85.3%）；
- judge：1,974 s（14.6%）；
- metric：17 s；
- 原流水线总计：13,540 s。

该 wall time 不能代表 NMG 检索的耗时。answer 阶段主要由上游连接失败、加上 600 秒请求超时与四次重试所主导。judge 还暴露出一个调度缺陷：对外宣称的并发度作用在整个问题上，而同一问题内的 rubric 条目是串行执行的。

本地 OmniMemEval 分支现在：

1. 通过一个受限的 API 池执行 rubric 调用；
2. 使用 2–4 题一组（默认 4）的 checkpoint 分组；
3. 每完成一题就原子写入；
4. 支持一个有界的自适应 LLM worker 池（最小／初始 16，最大 32）：持续成功时池会扩大，遇到 429、超时和 5xx 拥塞信号时池会收缩，但不低于配置的最小值；
5. 在 Windows 上显式以 UTF-8 读写报告；
6. 对 replay 环境差值的两端都做脱敏。

用九个 rubric 条目与四个 API slot 做 mock 验证，观察到峰值并发为四，0.179 s 内完成，且分数聚合正确。

## 解释与下一道 gate

匹配对照支持一个有界的结论：在这组固定的 BEAM 100K run 上，NMG 提供的上下文提升了答案质量。增益最大的类别是 temporal reasoning、information extraction、contradiction resolution 与 knowledge update——这些正是最需要既有 evidence 的类别。event ordering 与 summarization 虽相对对照有所提升，绝对水平仍然偏弱。

这一对结果不支持 token 对比。NMG 组在单个进程中运行，其 tracker 包含全部调用；而空记忆的 answer 阶段需要多次 checkpoint 续跑，每个进程都覆盖了 `token_usage_answer.json`，因此最终文件只保留最后一次单题调用。空记忆的 judge 文件是完整的，因为 judge 在一个进程内完成。后续续跑的 run 必须合并 token 账本，而不是覆盖它们，然后才能提出 token 效率方面的结论。

下一个 benchmark gate 不再是再做一次空记忆 run。它依次是：(1) 检查那 26 道配对回退题，尤其是 abstention；(2) 增加跨续跑的累计 token 记账；(3) 若目标结论是 NMG 对比另一种记忆表示，而不是 NMG 对比无检索 evidence，则重复该匹配对照，或增加一个官方 raw-session／full-history 组。
