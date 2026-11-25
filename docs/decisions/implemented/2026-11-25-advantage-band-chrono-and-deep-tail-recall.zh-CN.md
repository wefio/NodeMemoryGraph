# 优势分段时序演化枢轴与深尾邻域召回

[English](2026-11-25-advantage-band-chrono-and-deep-tail-recall.md) · [术语](2026-11-25-advantage-band-chrono-and-deep-tail-recall.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [统一记忆计算引擎与生产流程计算图接管](2026-11-24-unified-memory-compute-engine.zh-CN.md)

## 问题

跨数据集诊断显示，多跳问答与状态演进查询在 `DEFAULT_PIECEWISE_RERANK_GRAPH` 的不同名次区间存在两类互不重叠的召回缺口：

1. **中段（`[6..20]`）跨时间步状态连续性不足**：项目进展、偏好迁移与多日状态演进查询常有一条证据位于前 5，而其前置或后继状态落于 `15..40` 位；若直接按单条记录时间戳与 ID 排序，会扰动单时间戳会话（如单会话评测集）的排序精度，且作用于头部（`[1..5]`）或尾部（`[21..100]`）会损失精密排序。
2. **深尾（`[81..100]`）零重叠存储邻域缺失**：与查询词和向量无字面/语义重叠但属于同一状态线索（`same_state`）或相邻源对话轮次（`previous_turn` / `next_turn`）的证据无法进入常规候选池，若在重排前强行注入或对 `limit <= 20` 注入则会挤占高置信结果。

## 决策

NMG 按五数据集消融验收的优势区间边界，将两项机制精确限制在各自零回退的名次段生效：

1. **严格多时间戳时序演化枢轴（`src/core/memory/bm25f-neighborhoods.ts` 与 `src/core/memory/piecewise-rerank.ts` 中的 `w_chrono_seq_pivot`）**：按 `stateKey`、`nodeId` 或会话键分组，将相同 `eventTime ?? createdAt` 时间戳归入同一时间步桶，并直接跳过不同时间戳少于 2 个的分组（`byMs.size < 2`）。对多时间戳分组按时间升序建立离散步索引，对前 5 锚点前后 `+-2` 步内的相邻演化记录加权（`weight: 0.18`）。仅接入 `MID_DEDUP_RECENCY_SUBGRAPH`（`[6..20]`），不改动头部（`[1..5]`）与常规尾部（`[21..100]`）子图。
2. **深尾（`[81..100]`）存储邻域补充（`src/core/memory/search-compute-graph.ts` 中的 `collectDeepTailNeighbors`）**：在 `expand_search_neighbors` 内仅当 `semantic.mode === "hybrid"`、未开启 `evidenceShortlist` 且 `limit > 80` 时触发。保持 `1..80` 名冻结不变，从前 5 锚点收集未曾出现的相邻源轮次（`adjacentSources`）与 `same_state` 关系邻居，按可见性水合至多 `min(20, limit - 80)` 条，将其得分上限约束在 rank 80 之下并补入 `81..limit` 区间；`limit <= 80` 的请求保持完全不变。

## 考虑过的替代方案

1. **不要求 `byMs.size >= 2` 的无差别时序步排序**：拒绝，同一时间戳的候选会按记录哈希 ID 决胜并导致单时间戳评测集（LongMemEval）的 `R@20`/`All@20` 出现回退。
2. **重排前注入相邻轮次、全局 `CombMAX`、三路 RRF 或向量余弦 MMR**：拒绝，经五基准帕累托消融（`locomo`、`longmemeval`、`beam`、`personamem`、`halumem`，共 2,639 题 / 5,365 个黄金答案），全局融合和 MMR 均会拖累头部或多个黄金证据召回率；而分段方案 `[B0 | chrono_distinct | chrono_distinct | B0 | tail_store_adj]` 在 5 折留一交叉验证（5/5 LODO）中全票胜出且五个数据集均零回退（`R@10 +0.39pp`、`R@20 +0.23pp`、`All@20 +0.46pp`、`R@100 +0.56pp`）。
3. **基于工具连败爆发的规则提示词注入**：按用户明确决策排除，该类行为改进随基座模型演进收益有限且会增加无谓上下文长度。

## 后果

- `limit <= 80` 的常规查询与前 5 名精准排序行为保持不变，单时间戳会话零扰动。
- 大窗口混合召回（如 `limit: 100`）在不改动前 80 名的前提下，于 `81..100` 名补充相邻源轮次与 `same_state` 关联记录。
