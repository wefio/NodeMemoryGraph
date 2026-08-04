# Hierarchical Activation Propagation — NMG 图侧设计

> **启用状态：实验性、默认关闭。** 常规节点向量路由使用确定性的余弦相似度。
> 只有显式向 `routeNodesByVector` 传入
> `activationMode = "hierarchical-activation"` 才会运行 HA。只有当持久化训练状态可用，
> 且严格匹配 benchmark 证明收益后，HA 才能进入 active 排序路径。

## 1. 动机

当前 NMG 的激活传播是平面的：

```
query → candidate nodes → activation scores → graph expansion → AG projection
```

所有候选节点在同一层级被评分，缺乏结构化的多尺度信息聚合。

这个设计引入**层次化全局节点（Hierarchical Global Nodes）**，将激活传播升级为：

```
query → g₁(候选池上下文) → g₂(邻域上下文) → g₃(全图上下文) → AG projection
              ↑                  ↑                  ↑
          短期记忆            中期记忆            长期记忆
```

## 2. 核心概念

### 2.1 空间全局节点（g₁, g₂, g₃）

每一层不是简单地"多加几个聚合值"，而是**在激活维度上引入新的抽象层级**。

| 节点 | 输入 | 产出 | 类比 |
|------|------|------|------|
| **g₁** | query + 候选节点池 | 候选池的全局上下文 | 局部模式识别 |
| **g₂** | g₁ + 邻域扩展节点 | 邻域的全局上下文 | 中层抽象 |
| **g₃** | g₁ + g₂ + 图状态 | 全图上下文 | 全局语义 |

### 2.2 时间全局节点（h₁, h₂, h₃）

对应 NMG 已有的三种记忆时间尺度：

| 节点 | 时间尺度 | 对应 NMG 概念 | 更新频率 |
|------|----------|-------------|----------|
| **h₁** | 短期 | 当前 session 上下文 | 每次检索 |
| **h₂** | 中期 | 当前 task 的 STG | 每次 task 结束 |
| **h₃** | 长期 | LTG 稳定节点 | consolidation 时 |

**关键设计原则：h₁/h₂/h₃ 是 NMG 图状态的可微投影，不是独立的编码器记忆。** 它们从 NMG 的 STG/LTG/AG 中读取，不自己维护隐式状态——避免两个记忆系统互相遮蔽。

### 2.3 与编码器的职责边界

```
┌─ VectorEmbedder (可替换实现) ─┐
│  text → 向量（纯粹语义编码）    │
│  不参与时序，不参与图结构        │
└──────────────┬────────────────┘
               │ Float32[128] L2
┌─ Hierarchical Activation (autodiff) ─┐
│  g₁/g₂/g₃: 多尺度空间聚合            │
│  h₁/h₂/h₃: 时间尺度投影               │
│  活在图侧，与 Controller 联合训练      │
└──────────────┬────────────────┘
               │ activation scores
┌─ AG Projection ─┐
│  节点选择 + 边扩展 │
└──────────────────┘
```

## 3. 接口设计

### 3.1 核心类型

```ts
// src/core/hierarchical-activation.ts

/** 单个节点的激活输入 */
interface NodeActivationInput {
  nodeId: string;
  vector: Float32Array;        // L2 向量 [d]
  lexicalScore: number;        // FTS 分数
  initialSimilarity: number;   // 与 query 的余弦相似度
  tier: number;                // 0-3
  activeCount: number;         // 历史激活次数
  lastActivatedAt: string | null;
}

/** 空间全局节点的输出 */
interface GlobalContext {
  vector: Float32Array;        // 聚合后的 L2 向量 [d]
  attentionWeights: Float32Array; // 对每个输入节点的注意力权重
  entropy: number;             // 注意力熵（衡量信息集中度）
}

/** 时间状态投影 */
interface TemporalProjection {
  shortTerm: Float32Array;     // h₁ 投影 [d]
  mediumTerm: Float32Array;    // h₂ 投影 [d]
  longTerm: Float32Array;      // h₃ 投影 [d]
}

/** 层次化激活传播的完整输出 */
interface HierarchicalActivationOutput {
  candidates: NodeActivationInput[];
  g1: GlobalContext;           // 候选池上下文
  g2: GlobalContext;           // 邻域上下文
  g3: GlobalContext;           // 全图上下文
  temporalProjection: TemporalProjection;
  nodeScores: Float32Array;    // 每个节点的最终激活分数
  globalSummary: Float32Array; // 压缩后的全局摘要向量（供 AG 使用）
}
```

### 3.2 主类

```ts
class HierarchicalActivation {
  readonly dimensions: number;

  // 可训练参数（UOp autodiff）
  readonly #g1QueryProjection: Tensor;   // 查询→g₁ 空间的投影
  readonly #g1FusionWeights: Tensor;      // g₁ 融合权重
  readonly #g2FusionWeights: Tensor;      // g₂ 融合权重（g₁ + 邻域）
  readonly #g3FusionWeights: Tensor;      // g₃ 融合权重（g₁ + g₂ + 图状态）
  readonly #temporalGate: Tensor;         // 时间尺度门控
  readonly #scoringProjection: Tensor;     // 最终评分投影

  constructor(dimensions: number);

  /**
   * 层次化激活传播
   *
   * @param queryVector     - 查询的 L2 向量 [d]
   * @param candidates      - 候选节点列表
   * @param neighborhood    - 邻域扩展节点（一阶/二阶邻居）
   * @param graphState      - 当前图状态（活跃节点、边权、STG/LTG 标记）
   * @param temporalState   - 上一轮的时间投影（用于 h₁/h₂/h₃ 更新）
   */
  propagate(
    queryVector: Float32Array,
    candidates: NodeActivationInput[],
    neighborhood: NodeActivationInput[],
    graphState: GraphStateSnapshot,
    temporalState: TemporalProjection | null,
  ): HierarchicalActivationOutput;
}
```

### 3.3 传播流程

```
propagate(queryVector, candidates, neighborhood, graphState, prevTemporal)
│
├─ Step 1: g₁ — 候选池聚合
│   queryVector + candidates
│     → cross-attention（query 关注每个候选节点）
│     → 加权聚合 → g₁.vector + g₁.attentionWeights
│
├─ Step 2: g₂ — 邻域扩展
│   g₁.vector + neighborhood
│     → cross-attention（g₁ 关注邻域节点）
│     → 加权聚合 → g₂.vector + g₂.attentionWeights
│
├─ Step 3: 时间投影更新
│   g₁ + g₂ + graphState.stgIndicators
│     → temporalGate 控制更新幅度
│     → h₁(新) = α·g₁ + (1-α)·h₁(旧)  [短期]
│     → h₂(新) = β·g₂ + (1-β)·h₂(旧)  [中期]
│     → h₃: 从 graphState.ltgStableNodes 读取（不自己更新）
│
├─ Step 4: g₃ — 全图上下文
│   g₁.vector + g₂.vector + h₁ + h₂ + h₃
│     → learned fusion → g₃.vector
│
├─ Step 5: 节点评分
│   for each candidate node:
│     score_i = w_sim·sim(queryVector, node.vector)
│             + w_g1·sim(g₁.vector, node.vector)
│             + w_g2·sim(g₂.vector, node.vector)
│             + w_g3·sim(g₃.vector, node.vector)
│             + w_time·temporalBias(node, h₁, h₂, h₃)
│             + w_graph·graphBias(node, graphState)
│
└─ Step 6: 全局摘要
    g₃.vector → scoringProjection → L2 → globalSummary
```

## 4. UOp 集成

### 4.1 与 autodiff 的对齐

整个传播过程构建在 UOp DAG 中：

```ts
// 伪代码：UOp 链
const q = constant(queryVector);                    // UOp [d, 1]
const C = stack(candidates.map(c => constant(c.vector))); // UOp [d, n]

// g₁: cross-attention(Q, C)
const scores_g1 = softmax(matmul(transpose(q), C) / sqrt(d));  // UOp [1, n]
const g1_vec = matmul(C, transpose(scores_g1));                // UOp [d, 1]

// g₂: cross-attention(g₁, N)
const N = stack(neighborhood.map(n => constant(n.vector)));
const scores_g2 = softmax(matmul(transpose(g1_vec), N) / sqrt(d));
const g2_vec = matmul(N, transpose(scores_g2));

// g₃: fusion
const g3_raw = add(
  multiply(g1_vec, g3Weights[0]),
  add(
    multiply(g2_vec, g3Weights[1]),
    add(
      multiply(h1, g3Weights[2]),
      add(multiply(h2, g3Weights[3]), multiply(h3, g3Weights[4]))
    )
  )
);
const g3_vec = l2Normalize(g3_raw);

// 节点评分
const nodeScores = candidates.map((c, i) => {
  const sim_q = dot(q, constant(c.vector));
  const sim_g1 = dot(g1_vec, constant(c.vector));
  const sim_g2 = dot(g2_vec, constant(c.vector));
  const sim_g3 = dot(g3_vec, constant(c.vector));
  return add(add(add(sim_q, sim_g1), sim_g2), sim_g3);
});

// 损失
const loss = contrastiveLoss(nodeScores, labels);
loss.backward();  // 梯度流过所有 Tensor 参数
```

### 4.2 可训练参数清单

| 参数 | 形状 | 用途 |
|------|------|------|
| `g1FusionWeights` | `[d]` | g₁ 聚合时 query vs candidate 的权重 |
| `g2FusionWeights` | `[d]` | g₂ 聚合时 g₁ vs neighborhood 的权重 |
| `g3FusionWeights` | `[5, d]` | g₃ 融合 g₁/g₂/h₁/h₂/h₃ 的权重 |
| `temporalGate` | `[2]` | α（短期更新速率）和 β（中期更新速率） |
| `scoringWeights` | `[6]` | sim_q / sim_g1 / sim_g2 / sim_g3 / timeBias / graphBias 的权重 |
| `scoringProjection` | `[d, d]` | g₃ → globalSummary 的投影 |

总计约 `d² + 4d + 8` 个参数，对 d=128 约 17K 参数——和现有的 DifferentiableController 同级。

### 4.3 与 DifferentiableController 的关系

```
HierarchicalActivation   ← 新增：多尺度激活
        ↓  nodeScores
DifferentiableController  ← 现有：路径决策（expand/stop）+ 预算管理
        ↓  route + budget
AG Projection             ← 现有：最终节点选择
```

两者职责明确：
- HierarchicalActivation：**哪些节点应该被激活**（评分）
- DifferentiableController：**激活后往哪走**（路径 + 预算）

可以联合训练：

```ts
const haOutput = hierarchicalActivation.propagate(...);
const ctrlOutput = controller.route(haOutput.nodeScores, haOutput.globalSummary);
const loss = add(haOutput.contrastiveLoss, ctrlOutput.routingLoss);
loss.backward();
gradientStep(haParams, lr_ha);
gradientStep(ctrlParams, lr_ctrl);
```

## 5. 图状态快照

```ts
/** 从 NMG store 读取的图状态，不持有所有权 */
interface GraphStateSnapshot {
  /** 当前活跃节点 ID → 活跃度 */
  activeNodes: Map<string, number>;

  /** 稳定边 (source, target) → 稳定度 */
  stableEdges: Map<string, number>;

  /** STG 标记：节点是否在短期记忆中 */
  stgIndicators: Map<string, boolean>;

  /** LTG 稳定节点的向量缓存（只读引用） */
  ltgStableVectors: Float32Array[];

  /** 节点活跃度历史（用于时间衰减） */
  activationHistory: Map<string, number[]>;

  /** 冲突关系 */
  conflictPairs: Array<[string, string]>;
}
```

## 6. 训练信号

### 6.1 来自 NMG 行为反馈

```ts
interface ActivationTrainingSample {
  query: string;
  queryVector: Float32Array;
  candidates: NodeActivationInput[];
  neighborhood: NodeActivationInput[];
  graphState: GraphStateSnapshot;

  // 标签：哪些节点最终被使用
  usedNodeIds: Set<string>;
  // 标签：哪些节点被显式拒绝
  rejectedNodeIds: Set<string>;
  // 标签：哪些节点虽然高分但未被使用（hard negative）
  highScoreUnusedIds: Set<string>;
}
```

### 6.2 损失函数

```ts
L = L_contrastive + λ₁·L_entropy + λ₂·L_temporal_consistency + λ₃·L_graph_smoothness
```

| 损失 | 含义 |
|------|------|
| `L_contrastive` | used nodes 分数 > unused nodes 分数（InfoNCE） |
| `L_entropy` | g₁/g₂ 的 attention entropy 不应极端（避免只看一个节点） |
| `L_temporal_consistency` | h₁/h₂ 更新不应剧烈震荡 |
| `L_graph_smoothness` | 相邻节点（有稳定边）的分数不应差太多 |

## 7. 分阶段实施

### Phase A：g₁ only（最小可行版本）

```
query → cross-attention over candidates → g₁-weighted scores
```

只加一个全局节点 g₁，替代当前的纯余弦相似度评分。
验证：g₁ 加权是否比纯 cosine similarity 提升 used-node 召回率。

### Phase B：g₁ + g₂

```
query → g₁ → g₂ (neighborhood) → combined scores
```

加入邻域扩展。验证邻域信息是否有边际收益。

### Phase C：g₁ + g₂ + h₁

```
query → g₁ → g₂ → scores
                ↘ h₁（短期记忆投影）
```

加入短期时序。验证跨轮一致性是否提升。

### Phase D：完整 g₁/g₂/g₃ + h₁/h₂/h₃

完整层次化激活。与 DifferentiableController 联合训练。

## 8. 与现有代码的对接点

| 现有文件 | 改动 |
|----------|------|
| `src/core/router.ts` | 用 g₁ 加权替代或增强纯 cosineSimilarity |
| `src/lab/differentiable-controller.ts` | 接收 hierarchical scores 而非纯特征向量 |
| `.pi/extensions/nmg/index.ts` | gate 逻辑中传入 graphState snapshot |
| `src/lab/autodiff.ts` | 不变（只用现有的 matmul/softmax/sigmoid/add） |

## 9. 为什么不在编码器里做

| | 编码器内部 | NMG 图侧（本文档） |
|---|---|---|
| 序列长度 | 32-256 tokens，双向 attention 已覆盖 | N/A |
| 节点数量 | N/A | 20-200 候选节点，需要显式多尺度聚合 |
| 图结构 | 看不到边和邻域 | 天然可访问候选池+邻域+全图 |
| 时序状态 | 无（每次独立编码） | 有 STG/LTG/AG 时间尺度 |
| 部署 | ONNX 不支持动态状态 | TypeScript autodiff 天然支持 |
| 联合训练 | 无法与 Controller 联合 | 同一个 UOp DAG |

**全局节点的价值在"图结构的层次化聚合"，不在"短文本编码"。**
