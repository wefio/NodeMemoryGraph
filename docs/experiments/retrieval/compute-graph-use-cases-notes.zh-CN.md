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

## 案例 3：五层关系库底座、上下文安全缓存与真 BM25F + 时间邻域计算图晋级（2026-11-23）

- **底层架构与缓存修复**：
  - 在 [`sqlite-relational.ts`](../../../src/core/memory/sqlite-relational.ts) 中落地以记忆为中心的 5 层关系表（`nmg_sources`、`nmg_memories`、`nmg_memory_evidence`、`nmg_memory_relations`、`nmg_memory_markers`），为透视查询提供零 `JSON.parse(payload)` 的原生索引过滤与分页；新增 `time`、`evidence`、`actor` 透视维度、隐式/显式 `semantic` 语义边及不依赖预设 `MemoryNode` 的 `engine.linkMemories`。
  - 修复 [`compute-graph.ts`](../../../src/core/compute-graph.ts) 中 `ComputeMemoCache` 的缓存键，将执行 `context` 签名（含函数属性哈希与 `WeakMap` 数组签名缓存）及 `ComputeRegistry` 算子重注册指纹纳入节点签名。
- **2,000 条记录关系透视性能压测**：
  - **写入开销（2,000 条，batch=100）**：`906.84 ms`（`2,205 rows/s`），同一事务内同步写入 5 层关系表与双路 FTS5。
  - **带过滤分页透视查询（`eventTimeFrom..To` + `sourceActor` + `memoryType`，`limit=200`）**：5 层原生索引路径 **`p50 = 5.43 ms`（均值 `5.49 ms`）**，对比全表扫描解析 `JSON.parse(payload)` 的 **`p50 = 8.62 ms`（均值 `8.77 ms`）**，在仅 2,000 条规模下即实现 **1.60x 加速**，且随总库容量扩大保持 $O(\text{limit})$。
- **1,867 查询 BM25F 与新邻域计算图消融实验**：
  - 在 LoCoMo（1,532 条）、BEAM（235 条）和 LongMemEval（100 条）共 1,867 条冻结查询上，使用 [`bm25f-neighborhoods.ts`](../../../src/core/memory/bm25f-neighborhoods.ts) 与 [`piecewise-rerank.ts`](../../../src/core/memory/piecewise-rerank.ts) 对比 11 组计算图配方：

| 配方 (`Pipeline`)          | `replaceGraphNode` 改动点                                                   |      All@1 |     All@20 |    All@100 |     MRR@20 | 净胜/负@1 | 净胜/负@20 | 净胜/负@100 |
| -------------------------- | --------------------------------------------------------------------------- | ---------: | ---------: | ---------: | ---------: | --------: | ---------: | ----------: |
| `G4_DEFAULT_BASE`          | 基线默认（`R3 + R1R5 + w_session(0.20)`）                                   |     35.22% |     65.32% |     78.71% |     0.5957 |       0/0 |        0/0 |         0/0 |
| `B1_BM25F_ONLY`            | Head -> `bm25f_field_score(0.12)`                                           |     35.27% |     65.32% |     78.71% |     0.5974 |       5/8 |        0/0 |         0/0 |
| `B2_HEAD_BM25F_R3`         | Head -> `bm25f(0.10) -> r3(0.12)`                                           |     35.36% |     65.32% |     78.71% |     0.5980 |       5/4 |        0/0 |         0/0 |
| `B3_HEAD_BM25F_R3_18`      | Head -> `bm25f(0.18) -> r3(0.12)`                                           |     35.36% |     65.32% |     78.71% | **0.5993** |       8/7 |        0/0 |         0/0 |
| `N1_TAIL_TEMPORAL`         | Tail -> `w_session(0.20) -> w_temporal_pivot(0.10)`                         |     35.22% |     65.32% |     78.75% |     0.5957 |       0/0 |        0/0 |         2/0 |
| `N2_TAIL_CONCEPT`          | Tail -> `w_session(0.20) -> w_concept_pivot(0.10)`                          |     35.22% |     65.32% |     78.57% |     0.5957 |       0/0 |        0/0 |         1/2 |
| `N3_TAIL_LINEAGE`          | Tail -> `w_session(0.20) -> w_lineage_pivot(0.14)`                          |     35.22% |     65.32% |     78.71% |     0.5957 |       0/0 |        0/0 |         0/0 |
| **`J1_BM25F_R3_TEMPORAL`** | **Head `bm25f(0.10)->r3(0.12)` + Mid + Tail `w_session->w_temporal(0.10)`** | **35.36%** | **65.32%** | **78.75%** | **0.5980** |   **5/4** |    **0/0** |     **2/0** |

- **缓存与帕累托合入结论**：
  - 11 组实验共 `110,153` 次节点求值（总耗时 `54.53 s`），`ComputeMemoCache` 命中 **`52,276` 次（命中率 47.5%）**。
  - `findParetoOptimalGraphs` 在 `(All@1, All@20, All@100, MRR@20)` 上选出 `['B3_HEAD_BM25F_R3_18', 'J1_BM25F_R3_TEMPORAL']`。
  - **`J1_BM25F_R3_TEMPORAL`** 在 `All@1`（`+0.14%`）、`All@50`（`71.90% -> 72.18%`）、`All@100`（`2W/0L`）与 `MRR@20`（`+0.0023`）上相对 `G4_DEFAULT_BASE` 零回退全面占优，已合入线上默认 **`DEFAULT_PIECEWISE_RERANK_GRAPH`**（`HEAD_BM25F_R3_SUBGRAPH` + `MID_DEDUP_RECENCY_SUBGRAPH` + `TAIL_SESSION_TEMPORAL_SUBGRAPH`）；而出现 `1W/2L` 抖动的 `w_concept_pivot` 继续作为可选实验算子保留，不进默认图。

## 案例 4：轮次邻域算子（`w_turn_pivot`）与 PersonaMem / HaluMem 全量评测（2026-11-23）

在 5 个冻结数据集共 **2,719 条查询**（LoCoMo 1,532 + BEAM 235 + LongMemEval 100 + PersonaMem 500 + HaluMem 352 [其中 272 题含金标，共 496 条证据]）上，验证轮次邻域算子（[`bm25f-neighborhoods.ts`](../../../src/core/memory/bm25f-neighborhoods.ts) 中的 `w_turn_pivot`）以及 PersonaMem 的上下文调优（`forget` 标记准入与偏好 `recall_trigger` 索引）。

- **图结构差异（`replaceGraphNode`）**：
  - 在 `RerankCandidate` 上扩展 `turnOrdinal?: number | null`，并在生产链路中通过 [`sqlite-relational.ts`](../../../src/core/memory/sqlite-relational.ts) 的 `readSourceTurnMetadata` 从 `nmg_sources.ordinal` 批量注入 `SqliteMemoryBackend.hybridCandidates` 与 [`engine.ts`](../../../src/core/memory/engine.ts)。
  - 在 **Mid**（`weight: 0.55, anchorTopK: 5, maxRadius: 1`）与 **Tail**（`weight: 0.35, anchorTopK: 6, maxRadius: 1`）串联 `w_turn_pivot`（提升同会话 $\pm 1$ 相邻对话轮次），保持 `Head`（`[1..5]`）不动。
- **5 数据集离线对比（`J1_DEFAULT` vs 合入默认方案 `W_055_035_R1`）**：

| 数据集（查询数 / 模式）                  | 图配方             |    R@1 |    R@5 |       R@10 |       R@20 |  All@1 |     All@20 |
| ---------------------------------------- | ------------------ | -----: | -----: | ---------: | ---------: | -----: | ---------: |
| LoCoMo (1,532)                           | `J1_DEFAULT`       | 25.47% | 48.25% |     56.77% |     66.27% | 31.14% |     69.45% |
| LoCoMo (1,532)                           | **`W_055_035_R1`** | 25.47% | 48.25% | **57.84%** | **67.50%** | 31.14% | **71.41%** |
| BEAM (235)                               | `J1_DEFAULT`       |  6.48% | 15.73% |     23.89% |     33.13% |  8.94% |     28.51% |
| BEAM (235)                               | **`W_055_035_R1`** |  6.48% | 15.73% | **24.49%** | **34.21%** |  8.94% | **30.21%** |
| LongMemEval (100)                        | `J1_DEFAULT`       | 55.29% | 86.47% |     94.71% |     97.65% | 66.00% |     98.00% |
| LongMemEval (100)                        | **`W_055_035_R1`** | 55.29% | 86.47% |     94.71% |     97.65% | 66.00% |     98.00% |
| HaluMem (352 / 272 有金标，无尾插)       | `J1_DEFAULT`       | 27.22% | 59.27% |     70.97% |     78.43% |      - |     72.79% |
| HaluMem (352 / 272 有金标，无尾插)       | **`W_055_035_R1`** | 27.22% | 59.27% | **71.98%** | **79.84%** |      - | **74.63%** |
| HaluMem（+ 尾插 2 个 `adjacentSources`） | **`W_055_035_R1`** | 27.22% | 59.27% | **71.98%** | **81.05%** |      - | **76.47%** |
| PersonaMem (500，隐藏 `forget`，无尾插)  | `J1_DEFAULT`       |  6.26% | 21.87% |     30.04% |     38.01% |      - |     11.00% |
| PersonaMem (500，隐藏 `forget`，无尾插)  | **`W_055_035_R1`** |  6.26% | 21.87% | **30.76%** | **38.54%** |      - | **12.20%** |
| PersonaMem（+ 尾插 2，隐藏 `forget`）    | **`W_055_035_R1`** |  6.26% | 21.87% | **30.76%** | **39.13%** |      - | **14.40%** |

- **PersonaMem 上下文调优分析（`forget` 标记与偏好 `recall_trigger`）**：
  - **隐私过滤 vs 撤回金标召回（`ask_to_forget`，共 100/500 题）**：预构建库中用户明确要求遗忘的记忆带有 `markers: [{ kind: "forget" }]`（默认被 `visibleMemory` / `searchableMemory` 拦截，共隐藏 97 条金标）。若仅准入脱敏改写后的 `statement` 约束摘要，无法匹配逐字对话金标（`R@20 = 38.21%`）；而采用 **`forget` 上下文准入 + 偏好 `recall_trigger`（`WmTqKO`）+ `W_055_035_R1`（`w_turn_pivot`）+ 尾插 2** 后，PersonaMem-500 整体指标提升至 **`R@1 = 6.59%`、`R@5 = 23.52%`、`R@10 = 34.39%`、`R@20 = 43.68%`（`+5.67%`）、`All@20 = 27.00%`（`+16.00%`）**，其中 `ask_to_forget` 类别 `R@20` 从 `68.11%` 跃升至 **`84.69%+`**（`w_turn_pivot` 将用户撤回轮与助手确认轮成对拉入前 20）。
- **帕累托与合入结论**：
  - `W_055_035_R1` 在全部 5 个数据集上相对 `J1_DEFAULT` 零回退严格占优（LongMemEval 全分位保持 `97.65% R@20` / `98.00% All@20` 持平），已正式合入线上 **`DEFAULT_PIECEWISE_RERANK_GRAPH`**。

### 端到端 HTTP + LLM 真实评测（`auto/deepseek-v4-flash`，并发 8，关闭思考）

将上述改动连同 [`local-memory-http.ts`](../../../src/cli/local-memory-http.ts)（接入 `createEmbeddingClientFromEnv()` 混合检索）、`nmg_sources.ordinal` 轮次注入、Head 段 `r5_recency_boost(0.02)` 及 [`model.ts`](../../../src/core/memory/model.ts) 的未来 `eventTime` 可见性修复接入真实 HTTP 服务（`BAAI/bge-small-en-v1.5` + `http://127.0.0.1:3425/v1` `auto/deepseek-v4-flash`）：

- **Suite 1 — `ADD -> Search -> ADD 更新 -> Search` 交替状态链路**：10/10 步全部正确（**`100.0%`**，覆盖变量 `A: 1 -> 2 -> 3`、城市搬迁 `Austin -> Seattle -> Tokyo`、数据库迁移 `SQLite -> PostgreSQL`、端口变更 `8080 -> 9443`）。该真实测试暴露并修复了 [`model.ts`](../../../src/core/memory/model.ts) `timeFields` 中当写入携带未来 `eventTime` 时 `validFrom > now` 导致记录被 `visibleMemory` 屏蔽的问题。
- **Suite 2 — HaluMem User 1 真实 HTTP 端到端（67 会话 / 164 题，OmniMemEval 官方 Prompt 与 Judge）**：
  - **Batch（全量写入后统一检索，`240` 字符摘要 / `5,500` 预算）**：**`139/164 = 84.76%`**（较历史 `trial17` 的 `81.10%` 提升 `+3.66 pp`，平均检索 `255.2 ms`，均值 `1,924` prompt tokens）。
  - **Interleaved（逐会话 `ADD -> Search` 交替作答，`240` 字符摘要 / `5,500` 预算）**：**`146/164 = 89.02%`**（较 `trial17` 提升 **`+7.92 pp`**，平均检索 `189.7 ms`，均值 `1,912` prompt tokens）：`Memory Boundary` `97.44%`、`Basic Fact Recall` `82.50%`、`Memory Conflict` `92.31%`、`Generalization & Application` `90.32%`、`Multi-hop Inference` `88.89%`、`Dynamic Update` `50.00%`（未命中样本如 `s52-q3` 实为第 2 名 `[B]` 已召回原轮次，但具体薪资数字 `23,000` 位于 240 字符摘要截断之后）。
  - **控制变量 A/B — 紧凑预算（`240 / 5,500`）vs 不截断预算（`searchPreviewCodePoints: 0`、`searchMaxCharacters: 32000`，`NMG_EMBED_CHUNK_CONCURRENCY=1`，`hybrid: 164/164`，0 报错）**：紧凑预算 **`147/164 = 89.63%`**（平均 `18.1` 条、`123` 次查询被压到不足 20 条、均值 `1,800` prompt tokens），不截断预算 **`146/164 = 89.02%`**（平均 `19.9` 条、均值 `2,383` prompt tokens，仅 4 题退化 vs 3 题提升，并找回了 `s2-q2` 宠物偏好等截断细节）。此前冷启动复测出现 `75.00%`（`123/164`）实为默认 `chunkConcurrency=4` 并发打挂本地单线程 `bge_server.py`（`ECONNRESET`），导致 `backfillVectors()` 吞掉 500 错并静默降级为纯词法检索所致，与上下文长度无关。
- **Suite 3 — PersonaMem v2 真实 HTTP 抽样评测（前 5 人设 / 129 道四选一）**：
  - **基线（`240` 字符截断、原文 `/add`）**：**`32/129 = 24.81%`**（`ask_to_forget = 28.00%`、`therapy_background = 29.41%`、`neutral_preferences = 29.63%`、`health_and_medical_conditions = 29.41%`、`sensitive_info = 25.00%`）。
  - **开启写入预处理 + 全文摘要预算（`preprocessMessages: true` 提取 `recall_trigger=221, forget_directive=85`，`searchPreviewCodePoints: 0`、`searchMaxCharacters: 32000`）**：准确率大幅提升至 **`61/129 = 47.29%`（`+22.48 pp`）**，其中 `ask_to_forget` `28.00% -> 56.00%`、`therapy_background` `29.41% -> 58.82%`、`health_and_medical_conditions` `29.41% -> 58.82%`、`anti_stereotypical_pref` `12.50% -> 33.33%`、`sensitive_info` `25.00% -> 50.00%`。

## 案例 5：几何盲区子块向量、`MaxP+AvgP` 聚合与 PersonaMem v2 帕累托扫参（2026-11-23）

- **工程实现与配置汇总（`planEmbeddingWindows`、`0.8·MaxP + 0.2·AvgP` 与 HTTP 配置表）**：
  - 新增 [`text-chunking.ts`](../../../src/core/text-chunking.ts)（`planEmbeddingWindows`，默认 `NMG_EMBED_CHUNK_CHARS=2000` 对齐句界并丢弃主向量已覆盖的第 `0` 窗；`sentenceAlignedPreview`）、[`sqlite-vectors.ts`](../../../src/core/memory/sqlite-vectors.ts) 的 `nmg_memory_vector_chunks` 伴随表与 `0.8·MaxP + 0.2·AvgP` 段落聚合、[`search-projection.ts`](../../../src/integration/search-projection.ts) 句界裁剪、[`local-memory-http-config.ts`](../../../src/cli/local-memory-http-config.ts) / [`local-memory-http.ts`](../../../src/cli/local-memory-http.ts) 可选 `sortResultsByTime` 时序输出，以及 [`onlion/README.md`](../../../onlion/README.md) / [`onlion/README.zh-CN.md`](../../../onlion/README.zh-CN.md) 双语配置汇总。
- **PersonaMem v2 纯净对照（5 人设 / 129 题，`NMG_EMBED_CHUNK_CONCURRENCY=1`，`proxyErrors=0`，`hybrid: 129/129`，`auto/deepseek-v4-flash` 关闭思考，`preprocessMessages=false`，不截断）**：
  - **纯净不切分基线（`W=0`）**：**`63/129 = 48.84%`**（`1,118` 条主向量，`avgTokens=4,376`，`ask_to_forget=68.00%`、`neutral_preferences=40.74%`、`anti_stereotypical_pref=37.50%`）。排查并发超时后确认，`W=0` 在纯净 100% hybrid 下已具备 `48.84%` 基线。
  - **1024 字符重叠切分（`sortResultsByTime=false`）**：`58/129 = 44.96%`（多出 `648` 块子向量，`avgTokens=4,901`），因 Max-of-K 长度偏置把长助手回复挤进前 20 而回退（开 `sortResultsByTime=true` 后 `top_k=20` 为 `54/129 = 41.86%`、`top_k=100` 为 `59/129 = 45.74%`）。
  - **`W=2000` 几何盲区窗 + 纯 `MaxP`**：`61/129 = 47.29%`（仅多出 `133` 块，`avgTokens=4,936`），提升了 `anti_stereotypical_pref`（`37.50% -> 41.67%`）与 `neutral_preferences`（`40.74% -> 44.44%`），但 `ask_to_forget` 回落至 `56.00%`。
  - **`W=2000` 几何盲区窗 + `0.8·MaxP + 0.2·AvgP`**：**`64/129 = 49.61%`**（`133` 块，`avgTokens=5,134`），将 `ask_to_forget` 拉回至 **`72.00% (18/25)`**，并把 `stereotypical_pref` 推至 **`45.45% (5/11)`**、`neutral_preferences` 保持 **`44.44% (12/27)`**。
- **零 LLM 纯召回 `Recall@5..100` 与 15 组计算图帕累托扫参（`12.7s`）**：
  - 离线召回与端到端 QA 方向一致（`W=0`: `R@20=48.74%`、`Any@20=61.24%` vs `W=2000 0.8·MaxP+0.2·AvgP`: `R@20=49.25%`、`Any@20=62.02%`），且 **`R@100 = 79.15%`、`Any@100 = 85.27%`**（剔除 8 条非逐字 `sensitive_info` 题后，其余 121 题中 `Any@100 = 110/121 = 90.9%`）。
  - 在 15 组计算图（`p_role_length`、`p_rocchio_prf`、`p_semantic_prior` 串联 `DEFAULT_PIECEWISE_RERANK_GRAPH`）中，帕累托前沿为 **`['SEM_100', 'SEM_200', 'COMBO_ALL']`**：`SEM_100` 零回退严格支配基线（`R@5`: `32.16% -> 32.66%`，`MRR@20`: `0.3544 -> 0.3558`），`Rocchio PRF` 被噪声锚点拖累证伪，所有线性重排在 `R@20` 均收敛在 `50.00%–50.25%`——说明 `R@20` 与 `R@100` 之间近 `30 pp` 的落差来自 33M `bge-small-en-v1.5` 双塔模型本身的语义辨别天花板。

## 案例 6：权威关系型 SQLite 切换、规模基准测试与存储–计算图解耦（2026-11-24）

- **架构迁移差异**：将 SQLite 记忆存储从 `nmg_memory_entities` 双写彻底切换至规范化关系 v2 权威表（`nmg_sources`、`nmg_nodes`、`nmg_memories`、`nmg_memory_evidence`、`nmg_memory_relations`、`nmg_memory_markers`、`nmg_tesserae`、`nmg_receipts`、`nmg_schema_migrations`）及 22 个核心关系索引；实现带备份校验的幂等 `nmg_memory_entities` 退役、删除/`forget`/`quarantine` 索引与向量即时清理、跨页显式 `boundaryRelations` 以及 SQLite 与 `ComputeGraph` 零跨层导入隔离（波次并行异步执行、`sideEffect` 隔离与深冻结缓存安全检查）。
- **130 个迁移冻结库检索一致性校验（`1,867` 题：`1,532` LoCoMo + `235` BEAM + `100` LongMemEval，`62.13s`）**：
  - 所有 130 个历史 SQLite 冻结库通过 `openMemoryBackend` 完成事务级迁移并删除 `nmg_memory_entities`（`130/130` 库均满足 `hasUnmigratedEntityTable === false`），并抽样执行 `rebuildDerivedIndexes()`。
  - **`J1_BM25F_R3_TEMPORAL` 与迁移前基线全指标零回归（差异 `0.0000`）**：`R@1=29.08%`、`All@1=35.36%`、`R@3=42.57%`、`R@5=50.15%`、`All@20=65.32%`、`R@20=65.68%`、`R@100=84.44%`、`All@100=78.75%`、`MRR@20=0.5980`、`MRR@100=0.6010`。
- **2,000 / 10,000 / 100,000 条记录规模基准对比（`bench-relational-v2`，旧 JSON 实体表 vs 权威关系型 v2）**：
  - **2,000 条**：批量写入 `11,505` vs `18,935 ops/s`；单条读取 `p95=0.305` vs `0.071 ms`；50-ID 批量读 `p95=1.183` vs `0.455 ms`；多条件筛选 `p95=2.087` vs `8.121 ms`（**提速 3.9x**）；`projectGraph` offset 1k `p95=11.567` vs `13.394 ms`；邻域查询 `p95=1.626` vs `12.876 ms`（**提速 7.9x**）；FTS5 重建 `88.51` vs `42.56 ms`；库大小 `8.03` vs `5.10 MB`。
  - **10,000 条**：批量写入 `8,312` vs `15,483 ops/s`；单条读取 `p95=0.280` vs `0.093 ms`；50-ID 批量读 `p95=1.490` vs `0.529 ms`；多条件筛选 `p95=7.283` vs `36.928 ms`（**提速 5.1x**）；`projectGraph` offset 0 `p95=18.704` vs `40.387 ms`；`projectGraph` offset 1k `p95=20.965` vs `39.949 ms`；邻域查询 `p95=2.234` vs `62.177 ms`（**提速 27.8x**）；FTS5 重建 `312.36` vs `173.98 ms`；库大小 `24.85` vs `25.14 MB`。
  - **100,000 条**：批量写入 `4,200` vs `6,258 ops/s`（完整 `engine.rememberMany(100)` 抽样 `p50=57.202 ms`、`p95=61.135 ms`）；单条读取 `p95=0.299` vs `0.152 ms`；50-ID 批量读 `p95=2.226` vs `0.787 ms`；多条件筛选 `p95=121.606` vs `499.521 ms`（**提速 4.1x**）；`projectGraph` offset 0 `p95=24.633` vs `512.026 ms`（**提速 20.8x**）；`projectGraph` offset 1k `p95=21.353` vs `780.557 ms`（**提速 36.6x**）；邻域查询 `p95=8.344` vs `776.884 ms`（**提速 93.1x**）；FTS5 重建 `3,336.98` vs `1,961.58 ms`；库大小 **`220.18` vs `288.36 MB`（缩小 23.6%）**；进程 RSS **`893.21` vs `1,235.36 MB`（减少 27.7%）**。
- **100k `EXPLAIN QUERY PLAN` 结果**：验证了 `sqlite_autoindex_nmg_memories_1`、`nmg_memories_by_event_time`（`projectGraph` 按时间排序无需 `TEMP B-TREE FOR ORDER BY`）、`nmg_memory_evidence`／`nmg_memory_markers` 主键、`nmg_memories_by_scope_state`、`nmg_memory_relations_edge_source` 与覆盖索引 `nmg_sources_by_session_msg` 均走索引检索，无意外全表扫描与逐条 N+1 查询。

## 案例 7：统一记忆计算引擎、物理规划器与生产流程计算图接管（2026-11-24）

- **架构演进差异**：完成逻辑契约与保守能力声明（`compute-contracts.ts`）、逻辑–物理编译器（`compute-planner.ts`，支持 CSE、DCE、契约绑定、`relational_query` 下推改写、线性 `fused_chain` 融合、资源冲突波次调度与引用计数表）、9 项运行时安全修复与零哈希快路径（`compute-graph.ts`）、清理废弃 `rank-fusion.ts`，并将 `MemoryEngine` 与 `HttpMemoryService` 全量检索、读取、投影、写入预处理与变更规划迁移至生产计算图（`search-compute-graph.ts`、`view-compute-graphs.ts`、`write-compute-graphs.ts`、`http-write-preprocess.ts`、`http-profile-view.ts`）。
- **框架开销与粒度基准实测（`bench-compute-engine`，Node `v26.13.0`，2,000 次采样）**：
  - 直接 JS 调用 `p50=0.10 us`；单节点同步零哈希快路径 `p50=0.40 us`（`p95=0.70 us`）；单节点异步执行 `p50=1.00 us`。
  - 5 节点线性链：无缓存零哈希快路径 `p50=0.80 us`（`p95=1.30 us`），对比开启缓存未命中 `p50=9.50 us`／命中 `p50=7.90 us`。
  - 等工作量 20 步划分粒度：`1` 粗节点 `p50=0.40 us`、`5` 节点 `p50=0.70 us`、`20` 细节点 `p50=2.00 us`，开启 `enableLinearFusion` 编译为 `fused_chain` 后降至 **`p50=1.10 us`（-45%）**。
  - 10 阶段 2,000 维 `Float64Array` 流水线经引用计数即时释放，峰值活跃输出槽位稳定在 **`3 / 11`（堆增量 `+532.13 KB`）**。
  - 100 题 × 8 配方实验扫描（`1,500` 命中 / `2,600` 执行，命中率 `36.6%`）：未冻结上下文因安全序列化签名耗时 `627.49 ms`（对比无缓存 `590.49 ms`、`0.94x`）；使用 `Object.freeze()` 固定候选并命中 `WeakMap` 签名缓存后总耗时降至 **`286.11 ms`（2.06x 加速）**。
- **生产延迟、检索一致性与 7 项架构验证**：
  - 2,000 条 SQLite v2 生产读写：`rememberMany(100)` `p50=69.988 ms`（`1,527 rows/s`），`get(50)` `p50=1.459 ms`，词法 `search(20)` `p50=12.746 ms`（`p95=17.949 ms`），混合 `search(20)` `p50=25.091 ms`（`p95=33.691 ms`）对比 `rerankGraph: false` `p50=22.592 ms`（分段重排图开销约 `+2.5 ms`），32 并发混合检索总耗时 `877.71 ms`（`36.5 qps`）。
  - 复测 130 个迁移冻结库 / 1,867 题检索一致性：`J1_BM25F_R3_TEMPORAL` 全部 16 项指标与基线完全一致（`0.0000` 差异：`R@1=29.08%`、`All@1=35.36%`、`R@20=65.68%`、`All@20=65.32%`、`R@100=84.44%`、`MRR@20=0.5980`）。
  - 在不改动 `engine.ts` 与 SQLite 表结构的前提下，在 [`compute-architecture-guardrails.test.ts`](../../../tests/core/compute-architecture-guardrails.test.ts) 中实测通过全部 7 项架构替换与演化任务。

## 案例 8：增量 BM25+QTF、散文数字 Trigram 收紧与 176 图帕累托合入（2026-11-24）

- **图结构与通道改动（`replaceGraphNode` / `surfaceAnchors`）**：
  - 新增按查询动态重算 `N` / `avgdl` / `df` IDF 的增量倒排算子 `incremental_bm25_score`（[`incremental-bm25.ts`](../../../src/core/memory/incremental-bm25.ts)），支持标准 BM25（`k1=1.5, b=0.75`）、BM25L、BM25+、ATIRE BM25 与 BM25+QTF（`k3=8.0`），并配备 `STEM_CACHE`、纯 ASCII 跳过 CJK 扫描以及 `WeakMap` 候选词元缓存。
  - 将 [`piecewise-rerank.ts`](../../../src/core/memory/piecewise-rerank.ts) 中 `DEFAULT_PIECEWISE_RERANK_GRAPH` 的默认头部升级为 `HEAD_QTF_R3_SUBGRAPH`（`bm25_qtf`, `weight: 0.1`），同时保留 `HEAD_BM25F_R3_SUBGRAPH` 导出以供对比与显式配置。
  - 收紧 [`search-ranking.ts`](../../../src/core/store/search-ranking.ts) 中的 `surfaceAnchors`，使散文裸数字、序数词、年代缩写与 12 小时制时间词不再触发 `surface_fts` trigram 噪声，同时完整保留引号短语、路径、带点号版本、字母数字混合标识、错误码、驼峰符号及 3 字及以上中日韩连续片段。
- **176 组计算图 5 基准网格扫描与缓存复用（Track A 纯词法 56 组 + Track B 全链路混合 120 组，2,639 题 / 5,365 金标，总耗时 `992.13s`）**：
  - `ComputeMemoCache` 在 Track A 达到 **76.9%** 命中率（`527,800` hits / `158,340` execs），在 Track B 达到 **79.2%** 命中率（`1,955,499` hits / `514,605` execs）。
  - Track A `paretoQuality8` 全部由跨引擎分段拼包揽（代表配方 `LPW_X_l1_porter20_fqtf100`：`[0..1] inc_bm25l -> [1..20] fts5_porter -> [20..100] RRF(fts5_bm25f, inc_bm25_qtf)`，`MRR` `0.4799 -> 0.4853`，`nDCG@20` `0.4713 -> 0.4745`）；零 SQLite 的纯内存 `LPW_INC_L1_k1225_QTF100` 在 **`0.39ms`** 下取得 `MRR=0.4801`。
  - Track B `pareto2D_nDCG20_Latency` 沿 `HYB_FTS5_HEAD_NONE`（`2.70ms`, `nDCG@20=0.5386`）→ `HYB_PROD_FTS5_BM25F`（`9.69ms`, `0.5391`）→ `GPW_FTS_qtfOnly_006_h4_mdef_m20_t_def`（`16.50ms`, `R@5=46.77`, `0.5392`）→ `GPW_DUAL_fts5_porter_qtf5_m_def_t_def`（`16.78ms`, `MRR=0.5468`, `nDCG@20=0.5402`, `R@100=82.98`）→ `GPW_DUAL_fts5_porter_qtf5_m_qtf_006_t_def`（`21.96ms`, `R@20=63.65`, `nDCG@20=0.5404`）展开。
- **生产双赢方案 5 基准对照实测（`67.80s`，真实独立链路计时）**：
  - `PREV_PROD_BM25F`（旧 `surfaceAnchors` + `HEAD_BM25F_R3_SUBGRAPH`）：`R@1=24.09`、`R@5=46.50`、`R@10=55.91`、`R@20=63.50`、`R@50=74.02`、`R@100=82.96`、`Any@5=65.54`、`Any@10=72.47`、`Any@20=79.87`、`MRR=0.5450`、`nDCG@10=0.5157`、`nDCG@20=0.5391`，`avg=11.44ms`（`p95=16.99ms`）。
  - `NEW_PROD_WINWIN`（收紧 `surfaceAnchors` + `HEAD_QTF_R3_SUBGRAPH`）：`R@1=24.18`、`R@5=46.49`、`R@10=55.91`、`R@20=63.54`、`R@50=74.02`、`R@100=82.96`、`Any@5=65.43`、`Any@10=72.47`、`Any@20=79.87`、**`MRR=0.5461`**、**`nDCG@10=0.5164`**、**`nDCG@20=0.5398`**，`avg=11.78ms`（`p95=17.70ms`，其中 BEAM 因减少散文数字 trigram 扫描从 `23.63ms` 降至 `20.30ms`）。

## 后续实验记录模板

后续新增计算图算子、子图配方或参数搜索实验时，可按以下结构直接追加在本文件末尾：

```markdown
## 案例 N：<实验或算子名称>（<YYYY-MM-DD>）

- **图结构差异（`replaceGraphNode` / `diffGraphSpecs`）**：相对当前基线替换了哪个节点、子图或分段边界。
- **指标与缓存收益**：各档位指标（`All@1`、`All@20`、`All@100`、`MRR`）、`ComputeMemoCache` 命中率与加速比、线上耗时 `p50/p95`。
- **帕累托与合入结论**：`findParetoOptimalGraphs` 前沿筛选结果，以及是否升级为默认 `ComputeGraphSpec`。
```
