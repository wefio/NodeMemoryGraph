# BEAM 有链基准设计与报告（2026-08-16）

[English](beam-chained-benchmark-design-2026-08-16.md) | [简体中文](beam-chained-benchmark-design-2026-08-16.zh-CN.md) · [术语](beam-chained-benchmark-design-2026-08-16.terms.yaml)

合成链基准的历史报告。下列数值来自带日期的原记录；本文未链接原始 run artifacts，本次文档审计也未复跑。不得将其视为产品运行时或真实链质量证据。

## 问题与评测设置

原记录记载了一次 400 问的 BEAM `idtime` run，使用一组新参数：整体 Nugget `0.6568`、`event_ordering` `0.1892`、`summarization` `0.4652`。导入的 BEAM memories 没有 chain memberships，因此该 run 没有测量 chain expansion 或 logical-chain presentation。较弱的 `event_ordering` 分数是在无链设置下观察到的，不能归因于链。

实验在 benchmark ingestion 时显式构造了合成链。这属于基准构造，不是运行时推断。它在相同题目和 judge protocol 下比较无链、temporal、logical 和 both 链设置。合成 logical chain 用消息顺序近似因果顺序；这不能证明自然创建的链具有同等质量。

## 报告中的结果

| 注入方式 | 整体 | `event_ordering` | `summarization` | `info_extraction` | `multi_session` | `temporal_reasoning` | `instruction` |
|---|---:|---:|---:|---:|---:|---:|---:|
| none（baseline） | 0.6568 | 0.1892 | 0.4652 | 0.7668 | 0.6595 | 0.6000 | 0.8000 |
| temporal | 0.6755（+1.87 pp） | 0.2173 | 0.6958 | 0.8764 | 0.7363 | 0.5687 | 0.8125 |
| logical | 0.6867（+3.0 pp） | 0.2379 | 0.6891 | 0.8458 | 0.6400 | 0.6896 | 0.8708 |
| both | 0.5624（-9.4 pp） | 0.0269 | 0.3181 | 0.7792 | 0.4530 | 0.6771 | 0.7125 |

这些是报告中的样本限定数值，不是当前 benchmark receipt。本文未链接原始 run 文件。

## 解释边界

- 在这一个 protocol 中，报告的 temporal 与 logical 单链整体分数高于无链分数；`both` 更低。这不能证明普遍的链质量或产品收益。
- 在被研究的 `idtime` 设置中，temporal chains 不渲染为链块，而 bridge 启用了 chain expansion。报告将单链变化主要归因于检索到相邻证据，但设计没有把该因果机制与其他上下文效应隔离开来。
- `both` 的大幅下降与上下文稀释假设相符，但仅凭表格不能证明该解释，也不能自动推广到当前有界追加预算实现。
- “只展开最相关的链”是后续研究假设，不是产品契约。当前 chain expansion 由调用方选择且有界，见[当前链源码契约](temporal-logical-chains-design-2026-08-13/converged-design.zh-CN.md)。

## 当前评测代码边界

当前 OmniMemEval bridge 保留显式合成链注入，并默认设为 `none`。当前活动的注入代码路径处理 `logical`；`temporal`／`both` 分支以注释形式保留为实验历史。Bridge 的链构造与检索选项属于评测 instrumentation，不是产品运行时行为。见 [`evals/omnimemeval/bridge.ts`](../../evals/omnimemeval/bridge.ts)、[`src/core/store/retrieval.ts`](../../src/core/store/retrieval.ts) 和[链设计沿革](temporal-logical-chains-design-2026-08-13.zh-CN.md)。

原协议还列出了长链窗口、logical 顺序近似、DAG 分叉，以及区分检索展开与呈现等开放问题。除非当前 owner 或实验给出结论，它们仍是研究问题。