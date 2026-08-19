# 节点摘要加速检索：三方案权衡与调研（2026-08-19）

## 问题

检索候选生成是全库扫描（FTS / 向量）。超大规模（单 store 数千记忆）时全库候选 + 排序成本高。节点级语义摘要（每节点一条画像，`memory_node_fts` 已索引）可作启发式加速检索。经讨论收敛为**三个候选方案**（用户：剪枝长期有用、渐进单次更快、可能有混合）。

## 三方案

### A. 剪枝（pruning）— 缩小搜索池

```
routeNodesByFts(query, k) → 命中节点
ftsCandidatesInNodes(nodeIds) → 只搜命中节点（跳过其余）
```

- 收益：搜索空间全库→top-k 节点，长期索引/维护层面稳定
- 风险：漏召回（节点摘要不完整/过期）——需误差控制
- 文献：Certified Error Control of Candidate Set Pruning (EMNLP 2022)——剪枝可用用户指定的误差上界保证；Selective Pruning (SIGIR 2013)——按查询自适应剪枝强度避免过度牺牲效果

### B. 启发式渐进（progressive / heuristic ordering）— 只改搜索顺序

```
round 1: routeNodesByFts → 节点内候选（快速第一轮）
不够 → round 2: 全库候选（搜索池/排序完全不变）
```

- 收益：单次搜索更快（多数查询早停命中）；**零召回损失**（兜底全库）
- 文献：FUNNELRAG: Coarse-to-Fine Progressive Retrieval (NAACL 2025 Findings)；Progressive Searching for Retrieval in RAG (arxiv 2602.07297)
- 类比：A* 启发式 + 完备性——启发式决定先探索哪，不丢弃区域

### C. 混合 / 级联（cascade）— 渐进为主 + 选择性剪枝

```
round 1: 节点启发式渐进（先高潜力节点）
若置信/预算允许 → 早停（等效剪枝收益）
若不足 → 选择性扩大（per-query 决定剪枝强度/范围）
```

- 收益：单次快（渐进） + 长期稳（选择性剪枝）；置信决定搜索深度
- 文献：Efficient Cost-Aware Cascade Ranking (SIGIR 2017)；Cascade Ranking (SIGIR 2011)；Muppets: Effectiveness–Efficiency Tradeoffs in Multi-Stage Ranking (SustainLP 2021)
- 对应 NMG 现状：QPP 渐进披露已有（先 top-1 再扩展）——检索侧加节点启发式 = 同一思想的检索侧对应

## 权衡维度（调研结论）

| 维度 | A 剪枝 | B 渐进 | C 混合 |
|---|---|---|---|
| 单次延迟 | 快 | 快（早停） | 快（早停 + 自适应） |
| 召回风险 | 有（需误差控制） | **零**（兜底） | 低（置信控制） |
| 长期/维护 | 优（池变小） | 无影响 | 优（可选择性固化） |
| 实现复杂度 | 低 | 低 | 中 |
| 理论保证 | Certified 可给 | 完备性天然 | 需校准置信阈值 |

工业 ANNS 实践（Helmsman/LANNS/Recall What Matters）印证核心权衡：**以 recall 换 latency 是主流，但必须参数化/可调**——对应 C 的置信门控。

## 推荐

**C 混合（渐进为主 + 选择性剪枝）**：round 1 节点启发式渐进（复用现有 QPP 渐进披露），早停用现有置信/预算机制；不足时全库兜底。剪枝作为**长期可选项**（维护/索引层预剪枝 + per-query 自适应），不默认启用（避免无控制的召回牺牲）。实现前需大数据 profile：早停率（多少查询 round 1 足够）+ 加速比 + 零召回损失验证。

## 可学习路由剪枝（用户追问）

节点权重 = 嵌入空间的“相关查询原型”（`update` 在线质心移动），`score = cos(embed(query), 原型)`。用学习路由剪枝：低分节点跳过。

**优势**：经验驱动（真实反馈）；`examples` 计数天然是剪枝置信门槛。

**致命缺陷（必须门控）**：未学节点 `weights=0` → `score=cos(q,0)=0` → **全被剪（冷启动灾难）**；查询分布外时原型匹配无意义。

**安全剪枝条件（同时满足）**：`examples ≥ N`（学过足够、原型稳定）∧ `score < θ`（明确低相关）∧ 查询词与节点历史查询词重叠（词法 guard，分布内）——否则不剪，冷启动节点靠摘要兜底。

**互补闭环**：学习剪枝（收敛后启用，长期）＋ 摘要兜底（冷启动/未学节点，单次）＝ 混合方案“选择性剪枝”的落地；`examples` 门控防冷启动灾难。

## 分层解耦（用户定案，取代融合）

用户定案：**不直接混合**，而是渐进为主 + 选择性剪枝，剪枝由可学习路由“慢慢减”驱动——两把刀分工、无直接作用。

```
单次搜索 → 渐进式：摘要 + 词法即时排序（早停、兜底）—— learned 不参与
学习路由 → 只拿走反馈信号做剪枝（长期缩小搜索池）
长期 → 渐进（在缩小的池上）+ 剪枝（持续缩小池）共同作用；learned 不直接碰单次排序
```

**优势（vs 融合 α·learned+β·summary+γ·lexical）**：
- 单次确定性：即时信号独立——可复现、易评测（学习状态不污染排序）
- 冷启动：渐进纯即时，无未学节点排序问题
- 风险隔离：学习坏只影响剪枝（可回退不剪 = 全库），不破坏单次逻辑
- 独立验证：渐进测召回 / 剪枝测加速——互不污染
- 长期累积：剪枝收敛 → 池小 → 渐进自然快

**落地**：
```
长期（反馈回路，维护期）:
  trainRouter(query, usedNodeIds) → 原型 → 剪枝强度 s(examples) 慢慢减
  剪枝资格：examples ≥ N ∧ score < θ(s) ∧ 分布内（词法 guard）
  自愈：兜底找回 gold → 负反馈降该节点 s
单次（searchContext）:
  pool = pruneNodePool(learned)      ← 学习间接作用（范围）
  round 1 渐进：摘要+词法排序 → 早停（置信/预算）
  不足 → 兜底含被剪节点（零召回最后防线）
```

## 验证协议（大数据）

1. **规模**：LongMemEval 500 问 / LoCoMo（取单 store 记忆最多 user 代表大数据）。
2. **指标**：早停率（round 1 命中率）；全库 vs 节点内候选规模/耗时；加速比；**召回损失**（gold 命中对比——C 必须零损失）。
3. **通过标准**：早停率显著 && 召回零损失 → 实现 C（渐进默认 + 剪枝可选）；否则记录结论。

## 最佳实践调研（2026-08-19）

5 角度 web 调研，多数直接支持分层解耦设计：

1. **单次 stateless + 长期累积学习 = 前沿共识**：RAG without Forgetting (arxiv 2602.05152) 明确 query-time adaptations 是 stateless（每次重算、无累积），只有 index-side 才有持久累积学习——我们的渐进（单次 stateless）＋ 学习剪枝（index-side 累积）正是此方向。GAM-RAG (arxiv 2603.01783) 从重复查询累积经验（training-free）。
2. **级联尾段收益递减（生产警示）**：The Neural Base 2026：2-stage→cascade 尾收益 <0.3% 但 +50-200ms；dense retriever recall@100 已 85-92%——**渐进轮数要克制（1-2 级 + 兜底，勿无限加深）**。
3. **聚类/块级剪枝 = 节点剪枝同构**：ASC (EMNLP 2024) 聚类级动态剪枝 + 概率 rank-safeness 保证（两参数控制）；Block-Max Pruning (arxiv 2405.01117) 块级剪枝——**剪枝阈值可借鉴概率保证而非纯经验阈值**。
4. **从反馈学剪枝已验证**：MICO (COLING 2022) 从搜索日志学选择性搜索（最小监督）——正对应“从反馈学剪枝”；FLAIR (Microsoft) / DMA (Online RAG Alignment) 反馈学习。
5. **scope-before-routing**：ShardMemo (arxiv 2601.21545) 先定范围再路由——对应我们“剪枝（定范围）先于渐进（搜索）”。

**对设计的确认与微调**：分层解耦保持（前沿共识）；渐进轮数克制（1-2 级）；剪枝阈值借鉴概率保证；防遗忘用 examples 衰减 + hysteresis（已有，参照 L2R 终身学习 CIKM 2023）。
