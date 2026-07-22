# 数学 / 物理结构相似性

**Created:** 2026-07-20

本文档记录 NMG 中已有工程与某些数学定理、物理模型或经典算法之间的**结构同构**。
不是"用数学推导出设计"，而是"做出来的东西恰好和某种已知结构长得一模一样"。

每个条目标注**相似深度**：
- **同构**：可以逐元素对应，改个名字就是一个东西
- **强相似**：整体结构和关键性质对应，但细节有差异
- **弱相似**：共享抽象模式但具体机制不同

---

## 1. Delta + 压缩 = LSM Tree

**位置**：`store.ts` — `#markIndexDelta`, `rebuildLeafBlocks`, `memory_index_delta` 表

**结构**：

```
NMG                              LSM Tree (LevelDB / RocksDB)
────────────────────────────────────────────────────────────
新 memory 写入 → Delta 表        写入 → MemTable (内存)
Delta 累积 → 标记 node dirty     MemTable 满 → 标记需要 compaction
rebuildLeafBlocks → 重写 block   Compaction → 合并写入 SSTable
compacted = 1 → 确认后删 Delta   合并完成 → 删除旧 SSTable
acknowledgeIndexDelta → 清理     …
```

**相似点**：
- 写入先到快速层（Delta / MemTable），立即可查
- 累积到阈值后，触发本地重写（单 node block rebuild / compaction）
- 旧数据在新数据写完后才清理
- 读写路径不阻塞（除事务锁外）

**差异**：
- LSM 的 compaction 按 key range 合并多个 SSTable，NMG 按 node 重建 block
- LSM 有多层（L0 → L1 → …），NMG 只有 Delta → Block 一层
- NMG 没有 Bloom filter 加速点查

**设计启发**：如果 Delta 累积速度超过 compression 速度（类似 LSM 的 write stall），
可以考虑像 RocksDB 一样对 Delta 本身做分层（Delta L0 / Delta L1），让查询代价
缓慢退化而非突变。

---

## 2. Node redirects = Union-Find / 转发指针

**位置**：`store.ts` — `mergeNodes`, `splitNode`, `node_redirects` 表，`upsertNode` 的 redirect 追踪

**结构**：

```
NMG                              Union-Find
────────────────────────────────────────────────────────────
merge(A, B) → target C          union(A, B) → root C
node_redirects: A → C           parent[A] = C
node_redirects: B → C           parent[B] = C
upsertNode(A) → 追踪到 C        find(A) → 路径压缩到 C
split(C) → {D, E}               （U-F 不处理 split）
node_redirects: C → D           —
node_redirects: C → E           —
```

**相似点**：
- 旧节点不会消失，redirect 链保留
- `upsertNode` 追踪 redirect 链直到 active 节点
- 检测到多个 redirect 目标时拒绝（split 后歧义）

**差异**：
- Union-Find 有路径压缩（摊还 O(α(N))），NMG 不压缩 redirect 链
- NMG 支持 split（一对多），Union-Find 只有 merge（多对一）
- NMG 保留每条 redirect 的历史 transform ID，Union-Find 不保留

**与垃圾回收的相似**：
- `node_redirects` 等价于 Cheney 复制回收中的 forwarding pointer
- 旧节点 (`status = 'merged'/'split'`) 等价于 from-space 中的已复制对象

**设计启发**：如果 redirect 链变长（多次 merge），在 `upsertNode` 中缓存最终
target（类似路径压缩）可以将多次解析从 O(k) 降到 O(1)。

---

## 3. Leaf block 内容寻址 = Git / IPFS / Nix

**位置**：`store.ts` — `stableLeafBlockId`, `rebuildLeafBlocks`

**结构**：

```
NMG                              Content-Addressable Storage
────────────────────────────────────────────────────────────
block ID = SHA256(内容拼接)      object hash = SHA256(content)
block 内容不变 → ID 不变          content 不变 → hash 不变
rebuild 时：旧 ID = 新 ID →       rebuild 时：相同 hash → 命中缓存
  保留已有 embedding 缓存
旧 ID 不在新集合 → 删除           无引用的 object → GC
```

**相似点**：
- 恒等式：相同内容 → 相同 ID（幂等性）
- 增量更新：只重算变化了的 block 的 embedding
- 旧 block 显式删除，新 block 显式写入

**差异**：
- Git 的 object graph 是 DAG，NMG 的 block 集合是扁平的（per-node list）
- Git 用 content hash 做 dedup 和 delta compression，NMG 只用它做缓存键
- NMG 没有 Merkle 树：node → block → memory 的哈希链不存在，block ID 仅依赖内容

**设计启发**：如果给 node 本身加一个内容派生 ID（node hash = hash(block hashes)），
就可以检测"这个 node 的结构是否变了"，进一步减少不必要的 embedding 重算。

---

## 4. State supersession = MVCC / 时态数据库

**位置**：`store.ts` — `remember` 中的 `automaticPrevious` 逻辑

**结构**：

```
NMG                              MVCC (PostgreSQL / etc.)
────────────────────────────────────────────────────────────
stateKey + scope 定位一条状态    (id, version) 定位一行
新 state → old.status =           UPDATE → 旧版本标记过期
  'superseded'
supersedes_id → 指向前一版本      xmin / xmax → 可见性区间
validFrom / validUntil → 时间窗口 事务 ID 范围 → 可见性判断
查询只取 active                   查询只取当前快照可见的行
```

**相似点**：
- 旧值不删除，标记为不可见
- 新旧之间有显式链接（supersedesId / version chain）
- 时间维度（validFrom/validUntil）建模

**差异**：
- MVCC 的可见性由事务 ID 决定（并发控制），NMG 用 status = 'active'
- MVCC 有 vacuum（清理死元组），NMG 没有等效机制
- NMG 的 supersedesId 链是单向链表，MVCC 的 version chain 也是

**与 Event Sourcing 的相似**：
- HistoryRecord（不可变事件流）→ MemoryRecord（投影/状态）
- 新事件 → 新投影覆盖旧投影，事件本身保留
- 这就是标准的 CQRS/Event Sourcing 模式

**设计启发**：可以引入 `valid_time` 和 `transaction_time` 的双时态模型
（bitemporal），区分"事实发生时间"和"系统记录时间"。当前只有一个
validFrom/validUntil。

---

## 5. Co-retrieval = 关联规则挖掘 / Hebbian 学习

**位置**：`store.ts` — `recordRetrievalTrace`, `node_pair_signals` 表, `proposeTopologyChanges`

**结构**：

```
NMG                              Market Basket Analysis
────────────────────────────────────────────────────────────
每个 query = 一次"购物"           每笔交易 = 一次购物
检索到的 node 集合 = "购物篮"     购买的商品 = 购物篮
co_retrieval_count =              co-occurrence count =
  同时检索 A 和 B 的次数            同时购买 A 和 B 的交易数
useful_count = A 和 B 都被标记     （无直接对应，但可用于过滤）
  为有用的次数
────────────────────────────────────────────────────────────
support(A,B) = co_retrieval_count / total_queries
confidence(A→B) = useful_count(A,B) / query_count(A)
```

**相似点**：
- 计数逻辑与 Apriori 算法的第一步完全一致
- `node_pair_signals` 就是关联规则挖掘的 2-itemset 频率表
- proposal 生成时的 minObservations 阈值 = minimum support

**差异**：
- 不做 upward closure pruning（没有 >2 项的 itemset）
- 没有 lift / conviction 等更高级的 interestingness measure
- useful_count 作为质量过滤（比纯 support 多一层筛选）

**与 Hebbian 学习的相似**：
> "Neurons that fire together, wire together."

- node = neuron
- co-retrieval = co-activation
- link proposal = synaptic strengthening proposal
- observation threshold = LTP (long-term potentiation) 需要重复刺激

**设计启发**：
关联规则挖掘有标准的 interestingness 度量（lift、conviction、Jaccard），
可以用来替代当前的 estimatedGain = useful_count / max(queries)，
这些度量对 popularity bias 有更好的校正。

---

## 6. Multi-channel retrieval = Ensemble Stacking

**位置**：`store.ts` — `#searchWithVector`, `hybridScore`

**结构**：

```
NMG                              Stacked Generalization
────────────────────────────────────────────────────────────
FTS5 匹配 → lexicalScore         Base learner 1 → prediction
向量 cosine → vectorScore        Base learner 2 → prediction
路由 score → routeScore          Base learner 3 → prediction
combinedScore =                  Meta-learner:
  weighted_sum(scores)             linear combination of base predictions
```

**相似点**：
- 多个独立信号（base learners）各自打分
- 线性组合（meta-learner）产生最终排序
- 各信号可以独立失效（FTS 找不到、向量有噪声），融合后鲁棒

**差异**：
- 真正的 stacking 的 meta-learner 是用 held-out data 训练的
- NMG 的组合权重是硬编码的，没有从数据学习
- 真正的 ensemble 会有 diversity measure，NMG 没有检验信道独立性

**与 Sensor Fusion 的相似（Kalman filter 的特例）**：
- 多个 noisy sensor 各自给出观察
- 加权融合：高精度 sensor 权重更大
- 如果三个信号独立且各自有 noise variance σ²ᵢ，最优权重 ∝ 1/σ²ᵢ

**设计启发**：如果能够估计每个信道的"噪声方差"（如 FTS 对语义模糊 query
的 recall 低 → 高方差），就可以用 Kalman-like 的自适应权重替代硬编码权重。

---

## 7. MemoryNode = 商集 / 等价类

**位置**：`types.ts` — `MemoryNode`, `MemoryRecord.nodeId`; `design.md §7`

**设计文档原文**：
> "A node represents an observational equivalence class under current evidence:
> records stay together while the system lacks reliable information to
> distinguish their use."

**数学结构**：

```
设 M = 所有 MemoryRecord 的集合
在 M 上定义等价关系 ∼：
  m₁ ∼ m₂  ⇔  当前证据不足区分 m₁ 和 m₂ 的语义用途

MemoryNode = M/∼ 的一个等价类
canonicalName = 等价类的代表元/标签
split = 发现新证据 → ∼ 变细 → 一个等价类分裂为多个
merge = 发现语义重叠 → ∼ 变粗 → 多个等价类合并为一个
```

**相似点**：
- 这就是商集 (quotient set) 的构造，一字不差
- Split / merge 对应等价关系的细化/粗化（refinement/coarsening）
- `node_redirects` 保存了等价类的历史演化

**与统计学中 Identifiability 的相似**：
- "两个参数在给定观测下不可区分" ↔ "两条 memory 在给定证据下不应拆开"
- 新的 query 行为 / 新的 memory → 新观测 → 可区分 → split
- 这就是参数 identifiability 的动态版本

**与聚类分析的相似**：
- MemoryNode = cluster
- canonicalName + summary = cluster centroid
- split = 增加 k（cluster 数）
- merge = 减少 k

**设计启发**：用聚类有效性的 formal criteria（silhouette score、
Davies-Bouldin index）来评估 node 的"紧致度"，决定是否应该 split。

---

## 8. Float32VectorCache 的几何增长 = 动态数组摊还分析

**位置**：`vector-cache.ts` — `#ensureCapacity`

**结构**：

```typescript
// Float32VectorCache
#ensureCapacity(required: number): void {
  if (required <= this.#capacity) return;
  while (this.#capacity < required) this.#capacity *= 2;  // ← geometric growth
  const expanded = new Float32Array(this.#capacity * this.dimensions);
  expanded.set(this.#matrix.subarray(0, this.#length * this.dimensions));
  this.#matrix = expanded;
}
```

**标准摊还分析**：
- 每次扩容成本 = O(N·d)（N 是当前 entries 数，d 是 dimensions）
- 几何增长（×2）→ 摊还每次插入 = O(d)
- 这与 `std::vector`、`ArrayList`、`StringBuilder` 的机制完全一致

**相似深度**：同构。这就是教科书级别的动态数组扩容。

---

## 9. Vector cache = 只读副本 + 惰性加载

**位置**：`store.ts` — `#embeddingCache`

**结构**：

```
NMG                              CPU Cache Hierarchy
────────────────────────────────────────────────────────────
SQLite embedding 表 = 主存        RAM = 主存
Float32VectorCache = L1/L2       CPU Cache = 芯片缓存
惰性加载（首次使用时从 SQLite     Cache miss → 从主存加载
  加载全部 vectors）
失效时整个 cache 丢弃              Cache line invalidation
  (#invalidateVectorCaches)
```

**相似点**：
- SQLite 是 authoritative source（类似主存是 truth）
- Cache 是 disposable（丢弃后可从 SQLite 重建）
- 全量加载而非按需（当前实现是一次 load all）

**差异**：
- CPU cache 按 cache line 粒度（64B），NMG 按整个 kind（node/leaf）
- CPU cache 有替换策略（LRU/PLRU），NMG 不做逐出
- CPU cache 是硬件自动的，NMG 是显式调用的

**设计启发**：如果向量数量增长到百万级，当前"全量加载"策略会 OOM。
需要类似 CPU cache 的按需加载 + 替换策略（如 LRU eviction），
或转用 mmap 直接映射 SQLite 的 BLOB 列。

---

## 10. Write policy regex = 签名式入侵检测

**位置**：`write-policy.ts`

**结构**：

```
NMG                              Snort / Suricata IDS
────────────────────────────────────────────────────────────
SECRET_PATTERNS = [               signature rules = [
  /BEGIN.*PRIVATE KEY/i,           alert tcp any any → any any
  /api[_ -]?key\s*[:=]/i,          (content:"api_key="; …)
  …
]                                 ]
assessMemoryWrite(text) =         detect(packet) =
  遍历 pattern 集合 →               遍历 rule 集合 →
    命中任一 → reject                 命中任一 → alert
```

**相似点**：
- 基于已知模式的签名匹配
- 黑名单模型（默认通过，只拦截已知威胁）
- 正则作为 detection language

**差异**：
- IDS 有 anomaly-based detection（统计模型），NMG 没有
- IDS 规则有 severity、category、reference，NMG 的 pattern 是扁平的
- IDS 可以更新规则库而不改代码，NMG 的 pattern 硬编码

**设计启发**：把 pattern 集移到配置文件或 SQLite 表中（类似 IDS 的可更新
规则库），用户可以自定义规则而不碰源码。

---

## 11. Graph expansion BFS = 传染病模型 / 扩散

**位置**：`store.ts` — `getRelations`

**结构**：

```
NMG                              SIR Epidemic Model
────────────────────────────────────────────────────────────
起点节点 = 感染源 (I₀)           初始感染者
hop 1 邻居 = 第一波传播           直接接触者
hop 2 邻居 = 第二波传播           次级传播
visited set = 已免疫 (R)          已恢复/免疫（不会再感染）
maxHops = 传播代数上限             无（SIR 由 β, γ 决定终点）
```

**相似点**：
- BFS 的逐层扩散与传染病的世代传播结构同构
- visited set 相当于 recovered/immune（不再参与传播）
- 限定的 hop 数相当于有限传播代数

**差异**：
- SIR 的传播概率 β 是随机的（每人以概率 β 感染邻居），BFS 是确定性的
- SIR 有恢复率 γ，BFS 没有"恢复"概念
- SIR 的终点由 β, γ 和网络拓扑共同决定（可能未达全连通），BFS 访问所有 ≤h hops 的节点

**设计启发**：如果用概率性的传播（每条边以概率 p 传播而非 100%），
就等价于带重启的随机游走 / PPR，可以提供更平滑的 relevance 衰减。

---

## 12. 全览表

| NMG 组件 | 相似结构 | 深度 | 设计启发 |
|---|---|---|---|
| Delta + compaction | LSM Tree | 同构 | 分层 Delta 防止 write stall |
| Node redirects | Union-Find / GC forwarding pointer | 同构 | 路径压缩加速长链 |
| Leaf block 内容 ID | Content-addressable storage (Git/IPFS) | 同构 | Node 级哈希链检测结构变化 |
| State supersession | MVCC / Event Sourcing | 同构 | 双层时间（valid + transaction time） |
| Co-retrieval signals | 关联规则挖掘 / Hebbian 学习 | 同构 | Lift 等度量替代 estimatedGain |
| Multi-channel fusion | Ensemble Stacking / Sensor Fusion | 强相似 | 自适应权重 based on noise variance |
| MemoryNode | 商集 / 等价类 | 同构 | 聚类有效性指标判断 split |
| VectorCache 扩容 | 动态数组摊还分析 | 同构 | —（标准做法） |
| VectorCache 架构 | CPU Cache 层级 | 强相似 | LRU 逐出替代全量加载 |
| Write policy | 签名式 IDS | 同构 | 可配置规则库 |
| Graph expansion BFS | SIR 传染病模型 | 强相似 | 概率传播 → PPR |
