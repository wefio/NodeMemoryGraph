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

## 可学习路由融合（用户补充）

NMG 已有完整学习回路：`maintenance` 从检索轨迹 `usedNodeIds` → `trainRouter(query, usefulNodeIds)` → 更新 `router_weights`（隐式反馈驱动）；`routeNodes` 已融合 `learned×0.7 + lexical×0.3`。摘要路由 `routeNodesByFts`（节点摘要 FTS）当前是独立路径。

**统一节点启发式 = 融合三源**（混合方案 round 1 的节点排序打分）：

```
nodePriority = α·learned(router.score) + β·summary(routeNodesByFts) + γ·lexical(lexicalNodeScore)
```

- **摘要（β）**：冷启动 / 语义即时 —— 渐进单次快
- **学习（α）**：反馈积累 / 长期变准 —— 剪枝与优先长期稳（呼应“剪枝长期有用”)
- **词法（γ）**：节点名基础兜底
- 反馈回路已通（retrieval_trace → usedNodeIds → trainRouter）；摘要不参与训练（静态索引），学习只更新 learned 分量——**无需新基建**
- 风险：α/β/γ 权重需实验校准；学习过拟合罕见查询（现有 learningRate clamp + examples 计数可衰减）

## 验证协议（大数据）

1. **规模**：LongMemEval 500 问 / LoCoMo（取单 store 记忆最多 user 代表大数据）。
2. **指标**：早停率（round 1 命中率）；全库 vs 节点内候选规模/耗时；加速比；**召回损失**（gold 命中对比——C 必须零损失）。
3. **通过标准**：早停率显著 && 召回零损失 → 实现 C（渐进默认 + 剪枝可选）；否则记录结论。
