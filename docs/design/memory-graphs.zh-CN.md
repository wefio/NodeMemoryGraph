# 三张记忆图：STG / LTG / AG

[English](memory-graphs.md) · [共用术语](memory-graphs.terms.yaml)

**Status:** current
**Updated:** 2026-10-16
**Related:** [设计基线](design.md)、[STG 共享存储](stg-shared-store-v2-2026-08-12.md)、[会话 AG 运行时](session-active-graph-runtime-design.zh-CN.md)、[分层披露](tiered-disclosure-design.md)、[边激活](edge-activation-design.md)

用本生命周期参考区分暂定记忆、持久事实和会话工作上下文。实现 owner
区分已有机制和目标；归并提案不等于已交付的默认行为。

## 按任务阅读

| 问题 | 入口 |
| --- | --- |
| 哪些内容私有、持久或当前可见？ | [三张图](#三张图) |
| 新候选应放在哪里？ | [STG](#stg暂定记忆) |
| 哪些结构可成为持久记忆？ | [LTG](#ltg持久记忆)与[提升](#提升与降级) |
| AG 与一次检索结果有何区别？ | [AG 与投影修订](memory-graphs/session-runtime-graph-and-projection-revisions.zh-CN.md) |
| 哪些已实现、哪些仍延期？ | [实现状态](#实现状态)及其合同 owner |

## 三张图

| 图 | 语义归属 | 内容 | 生命周期 |
| --- | --- | --- | --- |
| **STG** | 一个 Agent 会话的私有暂定内容 | 新信息、任务局部信息、尚未归并的信息 | 会话级；过期由策略决定，不要求仅存 RAM。 |
| **LTG** | 共享的权威语义记忆 | 持久原子记忆与已归并结构 | 持久。 |
| **AG** | 一个 Agent 会话；非权威 | 可变、有预算约束的 STG/LTG 引用、帧、观察、激活和临时推理 | 活图驻留内存，随会话释放。 |

AG 不是第三张共享或权威语义图。激活或检索不会发布私有 AG/STG 内容。
持久共享须通过获准的 LTG 写入；临时协作用独立 Task Board，其视图投影到
各调用者的私有 AG。冻结的投影修订标识某次检索／披露面，不等于可变 AG。

当前 STG 实现按 `projectDir` 使用一个 SQLite 文件：
`<project>/.nmg/stg.sqlite`。暂定行带所属 `sessionId`；会话为空、带
`cached_from_ltg` 的行是项目共享提示，不是另一份共享真值。物理共用文件
不意味着会话之间可见暂定记忆。[共享存储 owner](stg-shared-store-v2-2026-08-12.md)
与 `src/core/stg.ts`／`src/cli/service.ts` 拥有这条边界。

下图描述生命周期模型，不是所有集成均已完成的清单：

```text
HistoryRecord
  - immutable evidence during normal maintenance
  - stable session/message/tool source identity
  - exact content and timestamp
       | mandatory provenance
       v
Semantic memory store
  |- STG
  |    - provisional/task-local MemoryRecord and MemoryNode
  |    - observed/candidate relations and pending structure
  |    - persistent when crash recovery is required; short-term is a
  |      semantic lifecycle, not necessarily volatile RAM
  |
  `- LTG
       - durable atomic fact | state | event | preference | constraint
       - consolidated strategy | derived concept | typed relation
       - stable semantic addresses and bounded leaf/block hierarchies

STG + LTG + current query/task belief + tool observations
       |
       | budgeted selection, update, activation and temporary reasoning
       v
Session Active Graph (mutable, memory-resident, non-authoritative)
  - bounded task frames, selected references and local evidence content
  - temporary tool state, activation edges and reasoning artifacts
  - total token/node/edge/depth/reasoning/task/latency budget ledger
       |
       | freeze visible subset
       v
ProjectionRevision
  - immutable selection/disclosure/feedback boundary

Task Board (shared coordination, not a memory graph)
  - task-scoped attributed goals, blockers, results, handoffs, and decisions
  - cursor reads, TTL expiry, explicit resolution
  - never enters LTG search; each caller receives a private AG projection
```

STG/LTG 驻留属性区分暂定与持久语义生命周期，不区分 RAM 与磁盘。
AG 维护当前工作图，投影选择可见面；激活记录当前使用，稳定性控制归并。
驻留、激活、归并是不同决策。

## 理论沿革

[理论沿革](memory-graphs/theoretical-lineage.zh-CN.md)拥有与经典、现代记忆理论的比较。
类比解释设计选择，不证明实现，也不授权提升。

## STG：暂定记忆

除非受控规则立即接纳持久原子记忆，否则新候选先进入 STG：

```text
HistoryRecord
  -> governed extraction
  -> STG semantic inbox
       |- confirmed durable atom -> admit to LTG with provenance
       |- high-confidence match  -> attach to an existing STG/LTG node
       |- explicit new concept   -> create provisional STG node
       `- ambiguous              -> remain searchable and unassigned
```

- 已确认的用户事实、偏好、约束、可替换状态、明确记忆请求及工具验证事实，
  可走受控的即时原子接纳。这不会同时接纳推测结构。
- 由共现、推理或单次任务推导的关系，先保留为观察或候选，达到结构归并条件后
  才能归并。
- 暂定记录和孤立节点仍可经 FTS、精确、近因及可选向量检索进入候选。
  图遍历扩展候选，不是唯一入口；可检索性仍受下述会话隔离约束。
- SQLite 持久化支持恢复与跨回合连续性；过期仍由策略决定。一次成功动作只是
  事件或暂定策略，不证明通用策略；归并需要独立且关联结果的多次经历。

### 隔离

“全局”STG 检索指所属会话内的全部获准检索方式，不是读取另一会话的暂定行。
多 Agent harness 必须提供不可伪造的运行时／会话身份，逻辑模型中称
`runtime_id`、`session_id`。搜索、精确访问、每条暂定行、临时边、AG trace
及反馈事件都必须遵守该归属。`semantic_task_id` 用于证据去重，不是隔离键。

当前隔离在项目 STG 文件内按行实现，不是每会话一个物理数据库。daemon
应用调用者的会话过滤，另行接纳共享 LTG 缓存提示。可信 harness／客户端边界
负责认证所声称的会话；行过滤既不签发身份，也不是数据库内核级行安全。
测试通过 daemon 和适配器覆盖不同会话，不证明能抵抗恶意可信调用者。

### STG 与索引 Delta

STG 跟踪暂定含义；索引 `Inbox/Delta` 跟踪派生叶／向量索引尚未压实的记录。
持久记忆可以仍在 Delta，短期记忆也可以已有压实索引。语义生命周期与索引维护
相互独立。

## LTG：持久记忆

LTG 保存持久事实、状态、事件、偏好、约束，以及获准的策略、概念和有类型关系。
整图不必连通；无关项目、人物、偏好或主题可以分属不同连通分量。

三类连接采用不同接纳规则：

1. **来源连接**：即时且必需；每条记忆可追溯到精确来源。
2. **确定性身份连接**：已知时即时建立，如显式 scope、匹配的
   `stateKey + scope`、有依据的接替。
3. **推断语义连接**：延后；`related_to`、因果、依赖、合并／拆分提案需要累积证据或
   明确确认。

一般语义关系可成环，推导和接替依赖必须无环。即使持久图有环，有界查询也可借助
visited set 构成局部 DAG。孤立节点以后可变为别名、细化、连接其他概念，
也可继续孤立。加关系不等于合并身份；区别由[边激活设计](edge-activation-design.md)拥有。

## AG：会话运行时图与投影修订

[AG 参考](memory-graphs/session-runtime-graph-and-projection-revisions.zh-CN.md)拥有
预算、投影、披露与 trace 限制。`agId`、`taskFrameId`、`projectionId` 和协调频道
身份不同；`boardChannelId` 是设计名称，board API 通过 `taskId` 选择频道。
运行时核心已存在；统一预算、语义切换及推理集成仍未全部完成。

## 提升与降级

须区分同库内的驻留变更与跨库归并。同库 `promoteMemory`／降级保留记录身份和
来源。项目 STG 与权威 LTG 是两个数据库：`consolidateStgMemoryToLtg` 通过
`remember` 物化或去重 LTG 记录，保留证据，并用 `consolidated_from_stg` marker
的 `attributes.sourceMemoryId` 指回来源。它不保证两库的物理记录／节点 ID
相同。缓存的 LTG 提示不能再次归并回 LTG。这是 `src/core/stg.ts` 的当前边界，
不是任意复制暂定内容的许可。降级／过期不改写底层历史证据。

归并设计随 scope 广度与影响强度提高提升门槛：
会话／任务 < 项目／工作区 < 用户 < 团队／组织；
交互提示 < 推理上下文 < 有作用域的约束。范围越广、越能改变行为，所需独立证据和
来源保证越强，并须有明确纠正／回滚路径。

局部结构只有在独立证据、效用、scope 一致性、来源覆盖和稳定性足够，且未解决冲突
足够少时才有资格归并。以下是符号模型，不是已校准的默认阈值：

```text
consolidate(G') iff
  stability(G')       >= high_threshold
  independent_tasks   >= min_tasks
  evidence_coverage   >= min_coverage
  observed_utility    >= min_utility
  unresolved_conflict <= max_conflict
```

迟滞将提升门槛与较低的降级／重开门槛分开，避免来回振荡。操作须版本化、可审计，
保留证据，并能通过从历史重建语义投影来撤销。原子接纳另行判断：清楚的持久原子
记忆可立即进 LTG，新结构、聚合策略及合并／拆分则须更强的稳定性过程。

## 信息论解释

编解码器类比用于解释设计，不是字面实现声明：

```text
Historical stream       information source
Memory extraction       source encoder into STG
LTG nodes/relations     consolidated semantic codebook
Node/leaf headers       progressive access codes
SQLite/index            storage channel
Query/current context   decoder side information
Active Graph builder    query-conditioned decoder
Raw evidence            lossless fallback and error check
```

STG 保留结构编码稳定前的暂定符号；LTG 是归并后的语义码本；AG 按任务解出有界
工作集。header 是有损访问码，关系提供侧信息，原始历史保留回退。只有预期检索
失真下降足以抵偿复杂度与维护成本，结构变更才合理。这是率失真目标，不能仅凭类比
声称已测得质量改善。

## 实现状态

由各合同 owner 区分实现与目标：

| 表面 | 当前边界与 owner |
| --- | --- |
| 驻留、原子写入、过期、历史 | core store 合同拥有显式 STG/LTG 驻留、受控原子接纳及只追加证据；跨库归并例外见上。 |
| STG 物理存储 | [共享存储 v2](stg-shared-store-v2-2026-08-12.md)：项目文件、会话行过滤、LTG 缓存提示和会话清理，不是每会话私有文件。 |
| 会话图与不可变投影 | [运行时蓝图](session-active-graph-runtime-design.zh-CN.md)：已有会话图、分离的身份、帧、有界 item、冻结／来源、释放及宿主中立披露。已有 `ActiveGraph` 检索对象表示投影，不是会话容器。 |
| 工作状态 | [状态空间合同](state-spaces.zh-CN.md)：`nmg_state` 是普通 AG／board 入口；内部租约／RPC 兼容不意味着日常状态仍是面向模型的 Lab 操作。 |
| 分层访问与预算 | [分层披露](tiered-disclosure-design.md)：确定性顺序披露、深证据预算及账本。自然校准的 SPRT、将学习预算提升为 Lite 默认，仍有独立证据门槛。 |
| 边机制 | [边激活](edge-activation-design.md)：有类型的有界传播、fan dilution、调节通道、trace、关联结果的更新。学习方向、反学习和自动压缩须分别解释成熟度与证据。 |
| 协调 | [Task Board](memory-graphs/session-runtime-graph-and-projection-revisions/shared-task-board.zh-CN.md)：任务隔离、归属、游标、TTL、解决／租约、私有投影、可选唤醒和 world 发现；不意味着已有 ACL 或多设备传输。 |

仅 LTG 的 L4 Dormant/Unindexed、L5 Quarantine、Pi 身份传递及回合末过期／重平衡，
不证明目标整图已经集成。[运行时验收缺口](session-active-graph-runtime-design.zh-CN.md#决策中的验收条件)
包括统一语义／观察预算、完整切换／恢复覆盖及有界推理集成。Lab AG 预算边界默认
为 `shadow`；显式启用 Lab 不等于自然校准或提升为 Lite 默认。

## 开放问题

1. 如何校准 STG 保留／过期／降级先验，既保住有用暂定含义，又不变成无界档案？
2. 如何在自然工作中分配统一的 token、节点、边、证据、帧、推理、跳数和层级预算？
3. 哪些独立自然矛盾／逆转证据足以校准 LTG 关系的降级／重开迟滞？
4. 定期 STG replay 可执行，还是只用于解释提升门槛的类比？
5. 在学习激活前，哪种确定性切换基线已足够？保留多少冷却帧才有正边际价值？
