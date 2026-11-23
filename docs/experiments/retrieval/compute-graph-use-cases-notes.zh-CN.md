# 计算图生产使用案例（滚动记录）

[English](compute-graph-use-cases-notes.md) · [使用术语](compute-graph-use-cases-notes.terms.yaml)

## 目标与范围

本滚动笔记记录 NMG 可组合分层计算图（[`compute-graph.ts`](../../../src/core/compute-graph.ts)）的真实生产使用案例，持续追踪三大核心组件——**正交因果分段拼接**、**共享前缀缓存加速**与**多目标帕累托自动选优**——如何从离线消融直接转化为线上默认配置。后续新增的计算图方案与实测记录可直接追加在同一文档中。

## 计算图三大核心组件

| 组件               | 核心符号 / 所属文件                                                                                                                                                            | 在检索闭环中的作用                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正交因果分段拼接器 | [`piecewise-rerank.ts`](../../../src/core/memory/piecewise-rerank.ts) 中的 `causal_band_stitch`、`DEFAULT_PIECEWISE_RERANK_GRAPH`、`createPiecewiseRerankGraph`                | 将排名区间切分为互不干扰的并行支路（`[1..5]`、`[6..20]`、`[21..100]`），使头部意图精度、中段去重多样性与尾部会话捞底能够无损叠加。                  |
| 共享前缀缓存器     | [`compute-graph.ts`](../../../src/core/compute-graph.ts) 中的 `ComputeMemoCache`、`runGraphExperiments`、`runSyncGraphExperiments`、`VALIDATED_GRAPH_CACHE`、`INPUT_SIG_CACHE` | 基于 `(op \| params \| subgraph \| upstream signatures)` 拓扑签名及 WeakMap 拓扑/输入缓存，在多配方对比与生产重跑中直接复用共享上游召回与分支结果。 |
| 帕累托自动筛选器   | [`compute-graph.ts`](../../../src/core/compute-graph.ts) 中的 `findParetoOptimalGraphs`、`replaceGraphNode`、`diffGraphSpecs`                                                  | 通过单节点或子图替换生成候选配方、比对结构差异，并在准确性与延迟多目标上自动剪除严格被支配方案，无需人工拍脑袋配权重。                              |

## 案例 1：三层嵌套检索与重排消融实验（2026-11-23）

- **实验设置**：基于 LoCoMo（1,532 条）、BEAM（235 条）和 LongMemEval（100 条）共 1,867 条冻结查询，组装 8 组两阶段管道 `[召回节点] -> [重排子图节点]`；其中 `DEFAULT_PIECEWISE_RERANK_GRAPH` 内部中段又嵌套第三层子图 `MID_DEDUP_RECENCY_SUBGRAPH`（`r5_recency_boost -> r1_incremental_dedup`）。
- **三数据集宏平均实测结果**：

| 配方 (`Pipeline`)          | `replaceGraphNode` 改动点                     |      All@1 |     All@20 |    All@100 |     MRR@20 | 净胜/负@1 | 净胜/负@20 | 净胜/负@100 | 缓存后耗时 p50/p95 |
| -------------------------- | --------------------------------------------- | ---------: | ---------: | ---------: | ---------: | --------: | ---------: | ----------: | -----------------: |
| `A0_2COL_ID`               | 2 列 FTS + `identity_rank`                    |     34.69% |     64.18% |     78.36% |     0.5908 |       0/0 |        0/0 |         0/0 |     1.55 / 2.62 ms |
| `G0_3COL_DATES_ID`         | 召回替换为 3 列 `dates` FTS                   |     35.15% |     64.75% |     78.58% |     0.5957 |      27/6 |       27/1 |        11/1 |     1.50 / 2.59 ms |
| `G1_HEAD_R3_ONLY`          | 仅开启 `[1..5]` `r3_intent_boost`             |     35.22% |     64.75% |     78.58% |     0.5961 |      29/5 |       27/1 |        11/1 |     0.14 / 0.61 ms |
| `G2_MID_R1R5_ONLY`         | 仅开启 `[6..20]` `MID_DEDUP_RECENCY_SUBGRAPH` |     35.15% |     65.04% |     78.58% |     0.5958 |      27/6 |       26/1 |        11/1 |     1.66 / 2.68 ms |
| `G3_TAIL_WS020_ONLY`       | 仅开启 `[21..100]` `w_session_pivot(0.20)`    |     35.15% |     64.75% |     78.71% |     0.5957 |      27/6 |       27/1 |        17/1 |     0.16 / 0.20 ms |
| **`G4_DEFAULT_PIECEWISE`** | 生产默认三段全开 (`R3 + R1R5(40) + WS(0.20)`) | **35.22%** | **65.04%** | **78.71%** | **0.5962** |  **29/5** |   **26/1** |    **17/1** | **0.13 / 0.17 ms** |
| `G5_PIECEWISE_WS040`       | 尾段权重改为 `0.40`                           |     35.22% |     65.04% |     78.65% |     0.5962 |      29/5 |       26/1 |        21/2 |     0.16 / 0.22 ms |
| `G6_WIDE_MID_WS040`        | 中段扩展为 `poolSize=80, endRank=30`          |     35.22% |     65.04% |     78.65% |     0.5962 |      29/5 |       26/1 |        21/2 |     3.34 / 5.58 ms |

- **三大组件实测收益拆解**：
  1. **分段正交无损叠加**：`G1` 只提头部 `All@1`（不伤 20/100）；`G2` 只提中段 `All@20`（`64.75% -> 65.04%`，不伤 Top-1）；`G3` 只提尾部 `All@100`（`78.58% -> 78.71%`，不扰前 20）；`G4_DEFAULT_PIECEWISE` 将三者拼接后同时保留三段最高指标。
  2. **共享前缀缓存加速**：8 组管道在 1,867 条查询上共进行 `85,882` 次节点求值，`ComputeMemoCache` 命中 **`37,341` 次（命中率 43.5%）**，总耗时由 **33.16 s 降至 12.70 s（2.61x 加速）**；后续配方直接复用上游召回与分支缓存，`G4` 耗时仅 `p50 = 0.13 ms / p95 = 0.17 ms`。
  3. **帕累托自动选优结论**：无论 3 维质量前沿 `(All@1, All@20, All@100)` 还是 4 维质量-延迟前沿 `(All@1, All@20, All@100, -p95Ms)`，`findParetoOptimalGraphs` 均唯一选出 **`G4_DEFAULT_PIECEWISE`**（已直接固化为生产默认 `DEFAULT_PIECEWISE_RERANK_GRAPH`）。

## 案例 2：HTTP 多子句融合与尾部上下文拼装图（`DEFAULT_HTTP_SEARCH_GRAPH`）

- [`http-search-graph.ts`](../../../src/integration/http-search-graph.ts) 将 HTTP 多子句融合与尾部邻接拼装（`fuse_clause_hits -> select_supplemental_tail -> stitch_http_page`）抽象为独立可替换的 `ComputeGraphSpec`，并通过 `options.searchGraph` 注入 [`HttpMemoryService`](../../../src/integration/memory-http-service.ts)。
- HTTP 写入去除伪造的 `AML session` 图节点后，通过 `sourceSessionId` 保留来源会话；`w_session_pivot` 按 `sessionId -> sourceSessionId -> aml_session -> nodeId -> evidenceId -> id` 的优先级稳定聚合，`stitch_http_page` 确保补充尾部邻居分数严格低于主命中下界。

## 后续实验记录模板

后续新增计算图算子、子图配方或参数搜索实验时，可按以下结构直接追加在本文件末尾：

```markdown
## 案例 N：<实验或算子名称>（<YYYY-MM-DD>）

- **图结构差异（`replaceGraphNode` / `diffGraphSpecs`）**：相对当前基线替换了哪个节点、子图或分段边界。
- **指标与缓存收益**：各档位指标（`All@1`、`All@20`、`All@100`、`MRR`）、`ComputeMemoCache` 命中率与加速比、线上耗时 `p50/p95`。
- **帕累托与合入结论**：`findParetoOptimalGraphs` 前沿筛选结果，以及是否升级为默认 `ComputeGraphSpec`。
```
