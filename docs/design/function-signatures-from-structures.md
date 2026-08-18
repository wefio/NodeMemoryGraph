# 借结构写函数

**Created:** 2026-07-20

借数学物理不是为了证明什么——是为了不用自己发明 API。
一旦认出"这东西就是个 X"，输入输出、边界条件、函数拆分都已经有人替你想好了。

---

## 1. Delta 表 → LSM Tree

**认出结构之后，函数自然长这样：**

```typescript
interface LsmLikeStore {
  // 写入全部进 delta，不直接写 block
  write(delta: DeltaEntry): void;

  // delta 累积到阈值 → 选一个 node 做 compaction
  selectForCompaction(): NodeId | null;

  // 对该 node：读 delta + 旧 block → 重排 → 写新 block → 删旧 delta
  compact(nodeId: NodeId): CompactionResult;

  // 如果 delta 堆积速度超过 compaction，阻塞写入
  maybeStall(): boolean;

  // 各层 delta 条数，用于监控
  levelStats(): LevelStats[];
}
```

**当前 NmgStore 已经有的：**
- `#markIndexDelta` ≈ `write`
- `rebuildDueNodes` ≈ `selectForCompaction` + `compact`
- `acknowledgeIndexDelta` ≈ 确认删除已 compaction 的 delta

**缺少的、按 LSM 模型自然该有的：**
- `maybeStall` — 当前没有背压机制，delta 无限增长时查询越来越慢但没有信号
- `levelStats` — 不知道各 node 的 delta 积压情况

---

## 2. Node redirects → Union-Find

**认出结构之后：**

```typescript
interface RedirectResolver {
  // 追踪 redirect 链，返回当前 active 节点
  resolve(nodeId: NodeId): NodeId;

  // merge: 多个 source 指向一个 target
  merge(sources: NodeId[], target: NodeId): void;

  // split: 一个 source 指向多个 target（歧义 → 抛错，要求具体指定）
  // 由于 U-F 不天然支持 split，这里退化为：查询时发现多个 target → 报错
  splitTargets(nodeId: NodeId): NodeId[];

  // 路径压缩：resolve 时顺便把中间节点的 redirect 直接指向最终 target
  // 摊还 O(α(N))
  compress(): void;
}
```

**当前 NmgStore 已经有的：**
- `upsertNode` 里做了 redirect 追踪 ≈ `resolve`
- 检测多 target 报错 ≈ `splitTargets` 的语义

**缺少的、按 U-F 模型自然该有的：**
- 路径压缩。当前每次 `resolve` 都从头走 redirect 链，O(k) 而非 O(α(N))
- `compress` 可以是一个后台 job，不需要每次查询时实时压缩

**实现极其简单：**

```typescript
// 在 upsertNode 的 redirect 追踪循环里顺便收集链上的节点
// 然后批量更新 redirect 直接指向最终 target
resolve(nodeId: NodeId): NodeId {
  const chain: NodeId[] = [nodeId];
  let current = nodeId;
  while (true) {
    const targets = this.redirectsFrom(current);
    if (targets.length === 0) break;
    if (targets.length > 1) throw new AmbiguousRedirectError(current, targets);
    current = targets[0]!;
    chain.push(current);
  }
  // 路径压缩：链上所有中间节点直接指向 finalTarget
  if (chain.length > 2) {
    this.redirectDirectly(chain.slice(0, -1), current);
  }
  return current;
}
```

---

## 3. State supersession → MVCC

**认出结构之后：**

```typescript
interface VersionedState {
  // 写入新版本，旧版本自动标记过期
  put(key: StateKey, scope: Scope, value: MemoryRecord): VersionId;

  // 取当前可见版本
  getCurrent(key: StateKey, scope: Scope): MemoryRecord | null;

  // 取某个时间点的版本
  getAtTime(key: StateKey, scope: Scope, timestamp: string): MemoryRecord | null;

  // 取所有历史版本（含已 superseded）
  getHistory(key: StateKey, scope: Scope): MemoryRecord[];

  // 两个时间点之间有哪些变化
  diff(key: StateKey, scope: Scope, from: string, to: string): VersionDiff[];
}
```

**当前 NmgStore 已经有的：**
- `remember` 的 automaticPrevious + supersedesId ≈ `put`
- 查询时 `status = 'active'` 过滤 ≈ `getCurrent`

**缺少的、按 MVCC 模型自然该有的：**
- `getAtTime` — "我上周用的是哪个版本？"
- `getHistory` — 看某个 state 的完整演变链
- `diff` — 在两个 session 之间哪些 state 变了

这些对 agent 的上下文感知很重要：用户可能问"我之前用的是 X，为什么现在变成了 Y？"

---

## 4. Co-retrieval → 关联规则挖掘

**认出结构之后：**

```typescript
interface AssociationAnalyzer {
  // 单项支持度
  support(itemset: NodeId[]): number;

  // 规则 A → B 的置信度
  confidence(antecedent: NodeId[], consequent: NodeId[]): number;

  // 提升度 (lift)：排除了 popularity bias 的关联强度
  // lift(A→B) = P(B|A) / P(B) = confidence(A→B) / support(B)
  lift(antecedent: NodeId[], consequent: NodeId[]): number;

  // 找到所有支持度 ≥ minSupport 的频繁 2-项集
  frequentPairs(minSupport: number): PairStat[];

  // 找到给定节点的最强关联节点
  strongestAssociations(nodeId: NodeId, topK: number): Association[];
}
```

**当前 NmgStore 已经有的：**
- `node_pair_signals` 表存了 co_retrieval_count + useful_count
- `proposeTopologyChanges` 用了 minObservations 和 estimatedGain

**缺少的、按关联规则模型自然该有的：**
- **`lift`**。当前 `estimatedGain = useful_count / max(queries)`，
  没有排除 popularity bias。一个热门 node 几乎和所有 node 都有高 co-retrieval，
  但 lift 能区分"真的关联"和"因为都热门所以一起出现"。
- 这段逻辑现在是 `proposeTopologyChanges` 里的一坨嵌套代码。抽成独立模块后，
  函数签名直接告诉读者"这不是在乱算，是在算关联规则的三个标准度量"。

---

## 5. Multi-channel retrieval → Ensemble

**认出结构之后：**

```typescript
interface RetrievalEnsemble {
  // 各信道的原始打分（不融合）
  channelScores(query: QueryEmbedding, candidates: MemoryId[]): ChannelScores;

  // 融合打分（权重可配置）
  combinedScore(scores: ChannelScores, weights?: ChannelWeights): number;

  // 用 labeled traces 拟合最优权重
  fitWeights(traces: RetrievalTrace[]): ChannelWeights;

  // 评估各信道的当前噪声水平（用于自适应权重）
  channelReliability(): ChannelStats[];
}
```

**当前 NmgStore 已经有的：**
- `hybridScore(lexical, vector, route)` ≈ `combinedScore`
- 各信道独立打分 ≈ `channelScores`（分散在各处）

**缺少的、按 ensemble 模型自然该有的：**
- **`fitWeights`**。当前权重硬编码。有了 labeled trace（useful/unuseful），
  这就是一个标准的 logistic regression fit。不需要写新的优化代码，随便一个
  statistical library（甚至手写 IRLS 几十行）就能算。
- **`channelReliability`**。"最近 FTS 的 recall 是不是在下降？向量索引是不是
  该重建了？"——这是运维要看的，目前没有暴露。

---

## 6. MemoryNode → 商集 / 聚类

**认出结构之后：**

```typescript
interface EquivalenceClassStore {
  // 当前划分
  partition(): MemoryNode[];

  // 给定新证据（如新的 co-retrieval pattern），判断是否需要细化
  shouldRefine(nodeId: NodeId, evidence: RefinementSignal[]): boolean;

  // 执行细化：split 一个 node
  refine(nodeId: NodeId, criterion: PartitionCriterion): MemoryNode[];

  // 执行粗化：merge 多个 node
  coarsen(nodeIds: NodeId[], target: NodeId): void;

  // 聚类质量度量
  compactness(nodeId: NodeId): number;
  separation(nodeA: NodeId, nodeB: NodeId): number;
}
```

**当前 NmgStore 已经有的：**
- `splitNode` ≈ `refine`
- `mergeNodes` ≈ `coarsen`
- `candidatePartitions` ≈ 作用等同于 `shouldRefine` 的候选生成

**缺少的、按聚类模型自然该有的：**
- **`compactness` / `separation`**。Silhouette score 或 Davies-Bouldin index
  给出了 split/merge 的定量判据：紧致度低 → split，分离度低 → merge。
  这比当前的 `memory_type | scope` 分组更通用。

---

## 7. Vector cache → CPU Cache 层级

**认出结构之后：**

```typescript
interface VectorCache {
  // 按需加载，不是全量
  load(ids: NodeId[]): void;

  // 单个逐出
  evict(id: NodeId): void;

  // 预热（在 query 之前批量预取）
  prefetch(ids: NodeId[]): void;

  // 逐出策略
  evictLru(count: number): NodeId[];

  // 精确失效，不是整个 kind 全丢
  invalidate(id: NodeId): void;

  // 命中率统计
  hitRate(): CacheStats;
}
```

**当前 Float32VectorCache 已经有的：**
- `upsert` ≈ `load`（但是追加，不逐出）
- `score` ≈ 使用 cache 做检索

**缺少的、按 cache 模型自然该有的：**
- **按需加载 + LRU 逐出**。当前是全量加载全部 node embedding。
  百万级 memory 时 OOM。`load` + `evictLru` 是最经典且足够好的方案。
- **`invalidate(id)` 而非 `invalidateAll(kind)`。** 当前一次 merge 扔掉了
  所有 node cache。改成单 ID 逐出，影响面从全局降到一个节点。

---

## 8. Write policy → IDS 规则引擎

**认出结构之后：**

```typescript
interface WritePolicyEngine {
  // 注册规则
  addRule(rule: WriteRule): RuleId;

  // 移除规则
  removeRule(id: RuleId): void;

  // 列出所有规则
  listRules(): WriteRule[];

  // 评估一段文本
  assess(text: string): AssessmentResult;

  // 规则命中详情（不是只返回 boolean）
  explain(text: string): RuleMatch[];
}

interface WriteRule {
  id: string;
  pattern: RegExp | string;
  action: "reject" | "warn";
  severity: "high" | "medium" | "low";
  category: "secret" | "pii" | "transient" | "custom";
}
```

**当前 write-policy.ts 已经有的：**
- `assessMemoryWrite` ≈ `assess`
- 三组硬编码 pattern ≡ 三条内置规则

**缺少的、按 IDS 模型自然该有的：**
- **可配置规则**。当前规则硬编码在源码中。抽成 JSON 配置或 SQLite 表后，
  用户可以在不修改 NMG 源码的情况下添加自定义规则（如特定 API key 格式、
  公司内部的项目代号过滤）。
- **`explain`**。当前只返回 `{ allowed: false, reason: "secret" }`。
  不告诉你命中了哪条规则、匹配了文本的哪个片段。
  对于 debug（"为什么我的正常输入被拦截了？"）这是必要的。

---

## 9. Graph expansion → 传染病 / 扩散

**认出结构之后：**

```typescript
interface GraphDiffusion {
  // 从起点扩散，maxGenerations 代后停止
  spread(seeds: NodeId[], config: DiffusionConfig): DiffusionResult;

  // 每代被激活的节点
  generation(g: number): NodeId[];

  // 免疫集（已访问、不再参与传播）
  immuneSet(): Set<NodeId>;
}

interface DiffusionConfig {
  maxGenerations: number;         // 传播代数上限
  transmissionProb: number;       // 每条边传播概率 (0..1]
  minActivation: number;          // 低于此阈值的节点不激活
  decay: number;                  // 每代衰减因子
}
```

**当前 `getRelations` 已经有的：**
- `maxHops` ≈ `maxGenerations`
- `visitedSet` ≈ `immuneSet`
- 等权 BFS ≈ `transmissionProb = 1.0`, `decay = 1.0`

**缺少的、按扩散模型自然该有的：**
- **传播概率**。`transmissionProb < 1.0` 让扩散在每一跳以概率停止。
  效果上等价于 PageRank 的重启概率：离起点越远越不可能到达。
- **衰减因子**。`decay < 1.0` 让远程节点的权重自然下降，
  不需要硬截断 hop 数。

**函数化的好处**：`DiffusionConfig` 把当前散落在 `getRelations` 循环里的
magic numbers 集中到一个可读的配置对象中。

---

## 10. 总结：认出结构 → 函数自动生成

流程就是三步：

```
1. 认出这段代码在做什么
   ↓
2. "等等，这不就是个 X 吗"
   ↓
3. X 的标准 API 长什么样 → 照抄函数签名
```

结果：
- 函数名不需要自己发明（`compact`, `resolve`, `lift`, `fitWeights`, `evictLru` 都是现成的）
- 输入输出是明确的（X 的教科书/论文/SOTA 库已经定义好了）
- 边界条件被 X 的理论分析过（"什么时候 compact？""什么情况下 U-F 退化？"）
- 换人维护时，看到 `lift(antecedent, consequent)` 不需要读实现就能猜到在算什么

当前 NMG 在 `hierarchy.ts` 已经享受到了这个好处：`huffmanDepths` 的函数签名和
行为完全由 Huffman 算法定义，不需要设计。这份文档的意思是：剩下的组件也可以这样。
