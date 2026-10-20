# 增量存储与索引维护

[English](incremental-storage-and-index-maintenance.md) · [使用的术语](incremental-storage-and-index-maintenance.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## 增量存储与索引维护

写入一条记忆绝不能触发全量向量／索引重建。

```text
new MemoryRecord
  -> persist transactionally
  -> add to searchable Delta
  -> mark affected leaf/node dirty
  -> query Base + Delta immediately
  -> compact/rebuild affected regions later
```

`STG/LTG` 与 `Base/Delta` 是彼此正交的维度。STG/LTG 描述语义生命周期与巩固状态。Base/Delta 描述物理索引维护。一条 LTG 事实可以在插入后立即位于 Delta 中，而一个 STG 候选可能已经被压缩进 Base 却尚未成为长期记忆。

维护有三个范围：

1. **局部：** 只重建受影响的 block、leaf 向量或节点 header。
2. **累积：** 当达到记录／token／脏比例阈值时，或在空闲期，进行压缩。
3. **邻域：** 当邻近的脏节点共享记录、embedding 或很可能有拓扑工作时，对它们批量处理。

常驻服务把累积范围实现为一个摊销队列。写入会递增持久的逐节点 `memory_index_delta` 行，精确记忆使用会递增 `pending_access_count`；一个进程内小计数器避免每次调用之后都做数据库到期检查。在 daemon 启动后的第一个信号处、以及此后仅在越过阈值时，事件循环的一个维护切片会检视至多有界数量的节点。它为到期的访问变化重新平衡层级、压缩到期的 leaf block、确认其 Delta 行，并记录 `maintenance.batch` 延迟与被触及行数。默认值集中在 `src/integration/config.ts`，可用 `NMG_MAINTENANCE_WRITE_THRESHOLD`、`NMG_MAINTENANCE_ACCESS_THRESHOLD` 与 `NMG_MAINTENANCE_NODE_LIMIT` 覆盖。一个单独设界的语义阶段在第一次 daemon 积压检查时运行，之后每经过配置数量的产出式本地批次运行一次（`NMG_MAINTENANCE_SEMANTIC_EVERY`）。它使有限数量的 STG 记录过期、调和有限数量的独立观察关系对，并生成——但从不自动接受——有限数量的拓扑提议。失败的切片保持持久计数器不变以便稍后重试，且绝不把一次成功的 `remember` 变成失败的写入。

到期检查有意采用双触发。单个热节点在它自身的写入或合格访问计数器达到相应阈值时立即被选中。访问压力只统计已索引、活跃或处于争议状态的记录，因为层级再平衡消耗的正是这些记录的待处理访问计数器；逐节点与全局访问总量使用同一资格规则。不合格记录保留自己的计数器与历史，既不触发也不延长维护回路，重新激活的已索引记录可以再次贡献压力。空的本地检查照样返回其结果并更新性能聚合，但不追加 `maintenance_runs` 行；有产出的本地运行与语义运行各自保留日志，因此 `rowsTouched` 为零的语义结果仍可排空 trace 信号。若许多稀疏节点使每个本地计数器都低于阈值，但它们的全局待处理总量达到阈值，同一有界切片会选出积压量最大、其次最旧的节点。当消费了一个完整的 `nodeLimit` 批次时，常驻服务会再调度一个有界切片，使压力降到全局阈值之下而不需要无界的同步遍历。低于阈值的尾部保持延后；它是有界的，而不是永久增长。这保留了局部的 Huffman 式再平衡，同时防止小节点图饿死 Base 压缩。

拓扑提议的接受仍是一次显式语义审阅。边稳定性可以支持可逆的关系合并或降级，但它无法确立节点身份，因此不能授权节点合并。

SQLite 是权威的，应当拥有事务、内容哈希、版本标记、脏队列、FTS 与崩溃恢复。NMG 决定语义分组、summary 失效与拓扑变更。一个进程内连续 `Float32` 矩阵可以缓存活动记录、节点或 leaf 的 embedding；它是可丢弃的，并且可以依据存储中的带版本二进制向量重建。

每个模型的 record、node 与 leaf embedding 在 `vector_blob` 保存一份 little-endian Float32 payload；`vector_json` 是空 `[]` 兼容占位，不是另一种导出格式。旧 JSON-only 行仍可读。首次可写迁移补齐缺失二进制值，且只在二进制字节长度匹配声明的正 dimensions 时移除重复 JSON。三个表与完成标记原子提交；已完成迁移不在每次打开时重扫。preferred-vector 查询只返回一种存储形式；纯 FTS 检索不连接或解码 embedding。binary-aware 读者兼容；JSON-only 集成必须用 stored-embedding API 或解码 BLOB。迁移不改 page size、持久性，也不运行 `VACUUM`。

即时 record-vector 评分仅在 little-endian 宿主、四字节对齐的完整 payload、私有且不可 resize 的 ArrayBuffer 上借用 Float32 view。cosine similarity 同步消费它；不得流入公共结果、缓存、异步工作或跨 WASM memory growth 存活。其他 payload 保留 decoder 优先级与兜底，公共 stored-vector 读取仍返回独立普通数组。存储字节、精度、候选选择与排名权重不变。

词法 `memory_fts` 使用 contentless-delete FTS5：保留 postings、positions 与 BM25 文档长度，不再保存一份全文。history content 与记忆 statement 即使字节相同仍是独立权威字段；Han bigram、recall trigger 与无内容 surface trigram 的文本变换不变。`memory_fts_registry.lexical_rowid` 将词法行映射到稳定记忆 ID，registry 自身 rowid 仍映射 surface 行。迁移保留两种 rowid 顺序，从权威字段一次重建，并在一个 savepoint 提交索引、registry schema 和格式标记；刷新原子更新双索引与映射。已删除记忆重开后不重建索引，dormant／恢复记录遵循存储状态。当前只读查询兼容旧全文表而不迁移，并能在 writer 升级后解析小 registry。按 `memory_fts.memory_id` 读写或删除的旧可执行文件与 SQL 不兼容，须一起升级读写方或采用 registry-aware 查询；仅支持二进制向量还不够。FTS 迁移不自动压缩或调整 page size。

同一权威边界适用于写入时候选加速。一个可选的进程内按作用域索引可以保留原始与规范化陈述、预分词词项、当前状态与稳定记忆 ID。它存在的唯一目的是避免重复的精确、近似重复与取代候选扫描；SQLite 仍是真值来源。该索引惰性构建、在成功写入后更新，并在回滚、删除、保留、过期或节点变换使增量更新不确定时失效。

`rememberMany` 是一个有序事务原语，而不是无序批量加载器。每一项都能观察到同一事务中更早的写入，因此重复与状态替换语义与重复调用 `remember` 完全相同；任一失败会回滚整批。调用者可以批量记忆写入，同时保留一种不同的历史会话模型。它们不得仅仅为了分组证据而复用一个记忆 `sessionId`，因为该字段控制 STG 所有权与检索可见性。

常驻 daemon 把这个原语暴露为增量式、经能力协商的 `rememberBatch` RPC（`batch-remember`），且不改变协议兼容 epoch。一次请求被限定为 512 项，且必须指向一个物理 LTG 或归会话所有的 STG store，这保持了一次事务回滚与有序去重。交互式 Agent 写入仍走单个 `remember`；集成只在自然的批量边界使用批量 RPC。Pi 在分块重放崩溃安全的会话归档暂存积压时使用它，块大小为 32，且只有整块提交后才删除已暂存文件。连接到不公布该可选能力的同 epoch 旧 daemon 时，它回退为顺序幂等写入。会话关闭本身仍是一次延迟敏感的单一写入。

ANN 是可选的。在精确与 ANN 的召回审计显示出可接受质量、且规模上精确扫描违反延迟预算之前，它不得替代精确向量扫描。当前近似重复测试与 LoCoMo 记录向量运行不足以支持默认启用原型 USearch 路径或单独的向量数据库。

长期存储在已索引冷层之后增加了两个生命周期状态：

```text
L0 Hot -> L1 Warm -> L2 Cool -> L3 Cold
        -> L4 Dormant/Unindexed
        -> L5 Quarantine
        -> physically deleted
```

L4 保留权威内容与最小查找元数据，但把记录从普通 FTS、向量／ANN、自动召回、推荐与 Active Graph 构建中移除。它仍可通过稳定 ID 与显式归档检索寻址。embedding 与其他可重建缓存可以丢弃。显式复用不必立即晋升记录：重复使用、一个活动项目，或用户恢复请求都可以把它带回已索引层级并重建必要索引。

L5 是删除候选区，不是普通记忆层级。记录只有在经过又一个保留间隔与依赖／保护审阅之后才进入其中。它在可配置的恢复窗口内对检索不可见，之后其内容与依赖索引可以被物理清除。资格必须结合年龄、时间衰减使用、重要性、生命周期状态与依赖覆盖情况；仅访问次数不足。固定（pinned）记忆、当前状态、关键约束、冲突／例外、用户保护的记录、活动引用，以及某个存活结论的唯一证据，都不自动具备资格。

普通保留清理遵循 `indexed -> dormant -> quarantine -> purge`。显式隐私删除可以绕过恢复窗口，并且必须贯穿证据链、summary、FTS／向量／ANN 条目、cache 与学习信号传播。在初始实现中，这些状态可以保留为一个 SQLite 数据库中的行；物理冷分区是未来可选的优化。历史在被保留期间不可变，但不保证被永久保留。

当前 store 把这些状态实现为 `memory_records.storage_state = indexed | dormant | quarantine`，与检索 `tier = 0..3` 独立。`setMemoryStorageState` 执行显式转换：进入 L4/L5 会移除 FTS、记录 embedding、待处理索引增量、leaf 成员关系与内存向量缓存条目；恢复到 `indexed` 会立即重建 FTS 并排队可重建的语义索引。稳定 ID 的 `getContext` 对 L4/L5 恢复仍可用。保守的 `retentionCandidates` API 仅做 dry-run，并保护 STG 记录、偏好、状态、约束、矛盾／例外、被标记记录、高价值或频繁使用的记录，以及有存活派生关系的证据。自动清除被有意不实现。

保留保护与常驻注入是两件不同的事。当记录类型为 `constraint`、`preference` 或 `state`；其证据角色为 `contradict` 或 `exception`；它支撑某个存活派生；或它携带 `critical`、`pinned`、`protected`、`safety_constraint` 或 `user_defined` 标记时，该记录受保护而不被自动 L4/L5 迁移。这种保护并不会把该记录注入每个 prompt。常驻内核更窄：只有活动的、已索引的、重要性至少 `0.8` 且由用户／工具／系统来源断言或验证的 tier-0 约束才具备资格，且宿主仍应用一个小的全局上限。因此一条罕见的安全约束不会因基于热度的保留而消失，而普通受保护历史也不会占用永久上下文。

物理隐私擦除是一项独立的显式操作，其契约强于逻辑撤回。它的实现必须作为一个受审阅作业运行，并产生一份只含非敏感标识符与计数的擦除回执。要求的传播顺序是：

1. 计算失去支持的派生记忆闭包并冻结并发写入；
2. 移除记忆／证据链接，只有在没有任何存活记忆、关系或审计义务引用某个 HistoryRecord 正文时才删除该正文；
3. 移除向量、FTS 行、leaf 成员关系、ANN／cache 条目、脏增量、claim 事件／后验，以及基于被擦除证据的提议；
4. 删除引用了目标的检索 trace，而不是仅仅编辑结果数组，因为它们的查询文本可能重复该私有事实；
5. 使 summary、关系证据、别名以及其材料依赖被擦除内容的空节点失效并重建；
6. 为受影响身份重置不可减除的学习节点／边／控制器聚合，并调用适配器特定的擦除钩子处理 shadow 日志／缓存；
7. 物理删除目标行与失去支持的派生行，然后按部署威胁模型使用 SQLite secure-delete/VACUUM 或加密密钥销毁。

在那个完整作业与适配器钩子契约存在之前，`forget`/`memory delete` 必须把自己描述为逻辑撤回。逻辑路径已测试可移除普通检索、FTS、记录 embedding、leaf 成员关系、索引增量、claim 状态、证据链接、失去支持的派生、进程内向量缓存条目、Active Graph 引用，以及待处理的证据相关提议。
