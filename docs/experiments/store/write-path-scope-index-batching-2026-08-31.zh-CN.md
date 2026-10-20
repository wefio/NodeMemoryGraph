# 写入路径 scope 索引与批量实验 — 2026-08-31

[English](write-path-scope-index-batching-2026-08-31.md) | [简体中文](write-path-scope-index-batching-2026-08-31.zh-CN.md) · [术语](write-path-scope-index-batching-2026-08-31.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史记录，其配置、测量结果和实现状态不是当前测试回执，也不授权默认策略。本轮未重跑实验，未独立复核原始运行产物。

## 问题

一个可丢弃的内存索引能否消除重复的同 scope 分词与 candidate 扫描，有序事务批次能否摊薄 SQLite 提交成本，同时不改变持久化记忆语义？

## 方法

可复跑的 runner 是 `npm run eval:ingest-ablation`。其签入配置使用 1,000 条确定性记录、每批 32 条、一次丢弃的预热与三次计入的重复。每个组都在全新的子进程与全新的 SQLite database 中运行。history 先追加，与 OmniMemEval bridge 一致；memory 记录随后逐条写入，或通过 `rememberMany` 写入。

四个组分别是：

1. baseline：SQL candidate 发现，每条记录一个 memory 事务；
2. scope-index：进程内按 scope 的 candidate 索引，逐个事务；
3. batch：SQL candidate 发现，一个事务内有序的 32 条批次；
4. both：scope 索引加有序事务批次。

不涉及 LLM，也不涉及外部 embedding 服务。除非所有组都产生相同的语句、status、state key、supersession 目标、节点与 evidence 的稳定投影，否则 runner 拒绝该次运行。

## 结果

在启用写入时 supersession candidate 发现的情况下：

| 组 | 中位 wall time | Records/s | 加速比 | 中位 CPU | 峰值 RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 4,592 ms | 217.8 | 1.00x | 4,656 ms | 167.5 MiB |
| scope-index | 2,539 ms | 393.9 | 1.81x | 2,564 ms | 111.7 MiB |
| batch | 4,063 ms | 246.2 | 1.13x | 4,187 ms | 174.1 MiB |
| both | 2,296 ms | 435.5 | 2.00x | 2,547 ms | 113.8 MiB |

四个组都持久化了 969 条唯一记忆，并通过了等价性 oracle。在该负载下，scope 索引降低而不是提高了峰值 RSS：保留规范化字符串与 token 所避免的短命分配，远多于重复 SQL 扫描与分词所带来的开销。在 history 追加成本仍被计入测量的前提下，批量事务带来了较小但可重复的收益。

在关闭 supersession candidate 发现时，同样的 bridge 形状负载仍然受益：scope-index 为 1.47x，batch 为 1.37x，both 为 2.15x（1,412 records/s，baseline 为 656）。both 组使用 98.1 MiB 峰值 RSS，baseline 为 91.0 MiB：对 969 条已存记忆而言多出约 7.1 MiB 常驻内存，而 CPU 从 1,563 ms 降到 688 ms。第二次运行也通过了同样的持久化输出等价性 oracle。应区分提交记录与唯一持久记忆：方法规定 1,000 条输入，两段结果都报告 969 条已存记忆。本页未另列第二次运行的提交数与逐次 wall time，不能把其吞吐量改称唯一记忆吞吐量。

## 解释与边界

- 按 scope 的索引是一个可丢弃的加速层。SQLite 仍是权威；该索引惰性构建，并在 delete、retention 转换、expiry 与节点变换之后失效。
- `rememberMany` 保持输入顺序。较后的条目能看到较早的批次写入，因此精确重复与 state-supersession 语义与重复调用 `remember` 一致。任何失败都会回滚整个批次，并使涉及的 scope 缓存失效。
- `NmgStore` 让 scope 索引保持可选。OmniMemEval bridge 默认启用它并设 batch size 为 32，因为这个受控负载与其写入形状相符。`NMG_SCOPE_WRITE_INDEX=0` 与 `NMG_WRITE_BATCH_SIZE=1` 保留 baseline 行为。
- 这是受控 benchmark 证据，不是自然长跑 daemon 证据。跨多个 scope 的内存增长，以及罕见维护操作后的缓存重建行为，仍需在普通 Agent 使用中观察。

原始生成的报告位于被忽略的 `evals/results/` 下；签入的 runner、配置与这份总结构成可复现的证据面。
