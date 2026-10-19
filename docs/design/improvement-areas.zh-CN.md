# NMG 改进领域

[English](improvement-areas.md) · [术语](improvement-areas.terms.yaml)

**Created:** 2026-07-20
**Status:** current
**Authority:** 历史缺口分析。当前设计属于
[design.md](design.zh-CN.md)，实现状态属于
[completion-audit.md](completion-audit.md)，未解决的动作属于
[temporary-todo.md](temporary-todo.zh-CN.md)。

本文收集在代码审阅与评估中发现的已知缺口、风险与机会。每一项包含观察到的症状、底层的关切，以及一条或多条具体做法。条目按影响分组，不按优先级分组。

## 状态审计——2026-08-24

请阅读完整职责说明：[状态审计——2026-08-24](improvement-areas/status-audit-2026-08-24.zh-CN.md)。

## Store 文件过大（约 4,100 行）

**症状：** `src/core/store.ts` 在一个类里装下了变更、查询、维护操作、schema 迁移与格式化辅助函数。

**关切：** 一个 2,900 行的单文件难以导航、审阅和单独测试。新贡献者必须先理解整个文件，才能做一处安全的改动。

**做法：**

- **按关注点拆分（推荐）：**
  - `store-mutations.ts`——`remember`、`deriveMemory`、`mergeNodes`、`splitNode`
  - `store-queries.ts`——`search`、`searchContext`、`routeNodes`、`recallCues`、
    `getContext`、`residentKernel`
  - `store-maintenance.ts`——`rebalanceNode`、`rebalanceDueNodes`、
    `rebuildVectorIndex`、`rebuildLeafBlocks`、`acknowledgeIndexDelta`
  - `store-migrations.ts`——`#migrate` 与所有 `#ensure*` 辅助函数
- 保留 `NmgStore` 作为薄的公开门面，委托给拆分后的模块。
- 把独立辅助函数（`mapNode`、`mapSearchResult`、
  `stableLeafBlockId`、`leafBlockSummary` 等）移到 `store-mapping.ts`，或在查询模块内保持模块私有。

**约束：** 所有模块共用一个 `DatabaseSync` 句柄；拆分必须保持事务完整性。显式传递句柄与预编译语句缓存，比打开第二个连接更安全。

---

## 向量缓存失效过粗

**症状：** `#invalidateVectorCaches(kind)` 直接丢掉整个 leaf 或 node 缓存，不区分实际变了哪些 ID。

**关切：** 一次单节点合并或拆分之后，每个节点 embedding 缓存都被丢弃，并在下一次查询时惰性重建。几百个节点时这很便宜；几千个节点时它会带来可测量的延迟。

**做法：**

- **按 ID 失效：** 给 `Float32VectorCache` 增加 `remove(id: string)` 方法，并在
  `mergeNodes`/`splitNode`/`rebuildLeafBlocks` 里对确切受影响的 ID 调用它。
- **代际计数器：** 给每个缓存条目打上代际号，在底层行变化时提升代际。过时条目在打分时跳过并惰性驱逐。
- 推迟：先在目标规模上测量缓存重建成本。如果重建 10,000 条少于 5 ms，粗粒度失效是可以接受的。

---

## OnlineNodeRouter 表达力有限

**症状：** `OnlineNodeRouter` 是查询 embedding 向量的逐节点指数移动平均（EMA）。打分为所存 EMA 向量与新查询向量的余弦相似度。没有负样本的概念，也没有跨节点特征交互。

**关切：** 正查询向量的 EMA 会收敛到「恰好被标为有用」的那些查询的质心。它无法区分「这个节点相关」与「这个查询向量恰好接近某个热门主题的质心」。当多个节点共享相似词汇时，路由器可能给它们全都打高分，不提供任何区分度。

**做法：**

- **逐节点逻辑回归（中等复杂度）：** 存一个同时用正（有用）与负（被检索到但未被标为有用）标签在线学习出的权重向量。`RetrievalTraceInput` 里现有的 `usefulMemoryIds` 字段已经提供了标签来源。
- **跨节点共享的小型两层 MLP（更高复杂度）：** 一个紧凑的查询编码器，投影到与节点 embedding 相同的空间，用对比目标训练。需要一个框架依赖，或自研自动微分实现。
- **先评估当前 EMA：** 在固定检索 benchmark 上做一次受控比较（EMA 对纯余弦对逻辑回归），再决定是否投入复杂度。设计文档本就要求如此：「如果学习式路由器打不过确定性路由，它就保持可选。」

---

## 没有显式隐私删除

**症状：** 没有 API 或工具可以删除一条记忆及其依赖工件。设计文档把它列为 P3。

**关切：** 用户最终需要移除已存信息。部分或不正确的删除会留下孤立派生记忆、悬空关系、过时 embedding 与误导性检索结果。

**删除一条 `MemoryRecord` 时必须清理什么：**

| 工件 | 动作 |
|---|---|
| `memory_records` 行 | 标记删除或移除 |
| `memory_evidence_links` | 移除引用该记忆的行 |
| `memory_derivations` | 决定：级联删除派生记忆，还是重新为之给出理由 |
| `memory_fts` / `memory_fts_registry` | 移除 FTS 条目 |
| `memory_embeddings` | 移除 embedding 行 |
| `memory_leaf_members` | 从 leaf 块移除；把块标记为脏 |
| `memory_index_delta` | 移除 delta 条目 |
| `retrieval_traces` | 清理 JSON 数组中的引用 |
| `topology_proposals` | 清理分区记忆 ID 中的引用 |
| `node_retrieval_signals` / `node_pair_signals` | 没有直接引用，但计数可能变陈旧 |
| 向量缓存 | 使受影响的 ID 失效 |

**做法：**

- **先软删除：** 给 `MemoryRecord` 增加 `deleted` 状态；在所有查询中把它过滤掉。这是最安全的起点，因为没有任何东西被物理移除，回滚很轻松。
- **级联硬删除：** 一个事务性存储过程或方法，遍历依赖图并移除每一个关联工件。必须尊重外键，并显式处理 `ON DELETE CASCADE` 与手工删除之别。
- **派生记忆策略：** 当一条源记忆被删除时，要么级联删除依赖它的每条派生记忆，要么保留那些还有足够多剩余来源的派生记忆。第二种更有用，但更难正确实现。

---

## Gate 决策只依赖正则模式

请阅读完整职责说明：[Gate 决策只依赖正则模式](improvement-areas/gate-regex-boundary.zh-CN.md)。

## 测试覆盖缺口

**症状：** 中文 gate 模式、图扩展正确性、端到端关系遍历覆盖不足。

**具体缺口：**

| 领域 | 风险 | 建议的测试 |
|---|---|---|
| 中文 gate 模式 | 一个正则笔误会静默破坏中文召回检测 | 给每个中文模式喂一个匹配与一个不匹配的 prompt；断言 `mode` |
| 非英文 gate | 不支持语言的假阴性率未知 | 在固定多语 prompt 集上跑 gate 并报告 mode 分布 |
| `searchContext` 图扩展 | 相关节点结果可能重复、漏掉或错误打分 | 插入两个带已知记忆的相关节点；断言 `searchContext` 之后的结果集 |
| 缺少来源时的 `deriveMemory` | 对已删除／不存在源记忆的错误处理 | 用不存在的源 ID 尝试派生；断言错误消息 |
| `mergeNodes` 重定向完整性 | 超过一跳的重定向链可能解析不正确 | 合并 A→B，再合并 B→C；断言 `upsertNode("A")` 返回 C |
| `splitNode` 分区校验 | 「每条记忆必须恰好分配一次」检查的边界情形 | 用重叠分区、缺失 ID 与多余 ID 拆分；断言各自被拒绝 |
| `Float32VectorCache` 容量增长 | 在极小的初始容量下，几何增长可能分配过多 | 插入超过初始容量的条目；断言无错误且分数正确 |

**做法：** 把这些作为聚焦的 `node:test` 用例加入。它们是确定性的、快速的；不需要模型或 Pi 进程。

---

## ANN 召回尚未达到生产质量

**症状：** README 报告在 10K 近似重复负载上，leaf ANN 准确率 87.5%，精确扫描为 100%。设计文档写明「当前 ANN 配置尚不得替代精确本地扫描」。

**关切：** leaf 路由 12.5% 的漏检率对默认使用来说太高。假阴性会级联：查询永远到不了正确 leaf 的记录。

**做法：**

- **调查 USearch 参数：** 当前 HNSW 的 `M`、`efConstruction` 与 `ef` 对 NMG 的向量分布可能不是最优。
- **精确＋ANN 混合：** 把 ANN 当作候选生成器，再用精确余弦相似度对 top-K 候选重排。这保住了召回，代价是一个小的常数因子开销。
- **逐节点 ANN：** 每个节点建一个小 ANN 索引，而不是一个全局索引。实践中局部索引维度更低，在相同参数设置下召回更高。
- 推迟到精确扫描延迟真正违反预算为止。设计文档的规模测试显示，10K 条目下精确 node+leaf 扫描为 10.6 ms P50，远在典型的 agent 单轮预算之内。

---

## Daemon 拥有的阶段并发

**Status:** 在主设计契约中已解决，并由单服务并发探针实际跑过。

一个 daemon 是每个 LTG 数据库及其已打开项目 STG 的应用层权威。SQLite 阶段是同步的，在事件循环上串行；外部 embedding 与摘要调用可以重叠，但没有事务跨 `await` 保持打开。Leaf 摘要会拒绝陈旧的成员指纹，而节点摘要按刷新滞后有意容忍有界陈旧。后台维护被切片，并可从持久的脏／增量状态重试。

WAL 与 `busy_timeout` 仍是韧性机制，不是独立多进程写入者的授权。只读副本或工作线程数据库队列，都推迟到已测量的 event loop 争用违反延迟预算之后再考虑。规范性契约见 `design.md` 第 4.1.1 节，32 会话探针见 `docs/experiments/store/scale-evaluation-2026-08-09.md`。

---

## Pi 证据来源解析带版本且失败可见

**Status:** 在适配器边界已解决。选择性证据准入在尝试来源绑定之前，先经一个严格、带版本的验证器投影 Pi 当前的 `unknown[]` 分支。

历史引用在 `sourceRef` 中记录 provider `pi` 与形状版本 `pi.branch.v1`。用户／工具归因仍然 fail closed，除非绑定了精确来源。Assistant 撰写的兜底证据仍可准入，但现在携带一个 `provenance_degraded` 标记，附上期望的历史引用版本与显式原因（`branch_api_unavailable`、`incompatible_branch_shape` 或 `exact_excerpt_not_found`）。因此它绝不会被静默呈现为经宿主验证的摘录。

**剩余的兼容策略：**

- 当 Pi 更改其分支契约时提升形状版本；只有在必须重新打开旧来源身份时才加迁移解析器。
- 把验证保持在每次 remember 尝试本地。在当前 64 条目窗口下，会话级记忆化没有必要，而且有在扩展热重载之后接受已变分支形状的风险。

---

## 拓扑自动接受已实现但未晋升

**Status:** 执行器存在，位于一个显式、默认关闭的策略之后。语义维护只有在
`NMG_TOPOLOGY_AUTO_MERGE=1` 时才可接受一个经过强门禁的 `same_as` 身份提议；它要求重复的高置信观察、平衡的活动用户／工具证据且共享来源 actor 类别、一个完全相同的作用域身份、无冲突提议，且不存在既有的规范目标。每次执行都记录其变换并使用可逆的合并日志。工作量默认限制为每次维护遍历处理一个提议，硬上限为四个。

**剩余关切：** 确定性测试证明了门禁、审计链接、有界执行与回滚机制，但没有证明自然条件下误合并的代价。因此该特性保持 opt-in，直到自然出现的别名、同名实体、时态状态、纠正与反转能确立一个可接受的精确率下限。待处理的非身份链接与拆分仍需显式审阅。

---

## 小结

| # | 领域 | 严重性 | 工作量 |
|---|---|---|---|
| 1 | Store 文件分解 | 已解决 | 按实测维护成本重新开启 |
| 2 | 粗粒度缓存失效 | 已解决 | 按实测重建成本重新开启 |
| 3 | 路由器晋升 | 开放，有门禁 | 自然匹配证据 |
| 4 | 物理隐私擦除 | 推迟的产品工作 | 高 |
| 5 | 仅正则 gate 校准 | 开放 | 已测量的多语集合 |
| 6 | 自然／集成覆盖 | 开放 | 持续 |
| 7 | ANN 召回质量 | 推迟 | 召回／延迟交叉点 |
| 8 | 并发模型 | 已解决 | 按实测争用重新开启 |
| 9 | 上游 Pi schema 协商 | 部分 | 依赖上游契约 |
| 10 | 拓扑自动接受晋升 | 开放，有门禁 | 自然数据门禁 |

没有任何开放项阻塞当前 opt-in 原型。下一步可行动的工作是为控制器／拓扑晋升收集证据，并测量 gate 覆盖。物理擦除、ANN 替换与不同的并发架构继续推迟，直到各自的产品或规模前提出现。
