# Active Graph、激活、稳定性与合并

[English](active-graph-activation-and-consolidation.md) · [使用的术语](active-graph-activation-and-consolidation.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## Active Graph、激活、稳定性与合并

> AG 构建规则已移至 [memory-graphs.md](../memory-graphs.zh-CN.md) 与 [核心数据模型](core-data-model.zh-CN.md#核心数据模型-1)；
> 激活规则设计于 [edge-activation-design.md](../edge-activation-design.zh-CN.md)；
> 分层披露门禁设计于 [tiered-disclosure-design.md](../tiered-disclosure-design.zh-CN.md)。
> 本节保留规范性的激活／稳定性模型。

### 会话 AG 更新与投影修订

请阅读完整职责说明：[会话 AG 更新与投影修订](active-graph-activation-and-consolidation/session-ag-and-projection-revisions.md)。

### HA 激活、MGR 推理与带类型边分层

节点激活管理当前工作记忆。一个目标打分族是：

```text
A_v(t) = w_q * query_relevance
       + w_t * task_relevance
       + w_r * recency
       + w_i * importance
       + w_p * learned_prior
       - w_c * retrieval_cost
```

边激活记录当前的认知／检索路径：

```text
A_e(t) = f(A_source, A_target, relation_type, q_t, task_t, path_cost)
```

激活变化快，且属于会话／任务本地。一个高度活动节点或边并不因此为真、持久或稳定。反之，一条稳定的 LTG 约束在与它无关的任务中可以保持不活动。AG 应分别记录哪些节点与边被选中、哪些精确证据被披露、哪些记录只是与答案重叠，以及哪些证据被独立验证、被反驳或被拒绝。只有最后一类可以监督持久化与控制器学习；选择、披露与 API 答案重叠仍是观察，而不是效用主张。

Hierarchical Activation（HA）管理会话 AG 的准入、冷却、再激活、冗余感知保留与预算分配。其快速的 `h1` 状态属于内存中的 AG，必须按会话与分支隔离。更慢的学习参数（若经验证）属于带版本的 controller/Lab 状态，而不是 AG 本身。Router 运行时实例现在按会话隔离 `h1`，并在会话释放时丢弃该快速状态；学习到的基础参数保持独立。任务帧冷却是确定性实现的。HA 驱动的准入仍是可选启用的，并且有意不接入默认检索，直到自然证据显示它改善的是效用而不只是改变排序。

Memory-Graph Reasoner（MGR）可以消费一个有界的 HA 选中子图，并产出临时假设、算子路径或 what-if 关系。MGR 输出不是记忆写入：每个派生产物都携带来源引用、以 `hypothetical` 起始、消耗同一 AG 预算，并随其任务帧过期，除非另行验证并经受 `remember` 接纳。可选启用的 Lab RPC 现在要求一个归会话所有的 `projectionId`，拒绝该投影之外节点，按 AG 预算限制节点、边、步骤与结果，并把输出标记为非持久／假设。把这些输出物化为受 TTL 约束的 AG 项并由 HA 重新打分的做法仍未完成。

AG 维护三种带类型边层：

1. 从 STG/LTG 引用的语义边；
2. HA 产生的激活／注意边；
3. MGR 产生的推理／算子边。

这些层可以在一次有界运行时迭代中相互提供信息，但激活或假设推理绝不能悄悄提高语义置信度或 LTG 边稳定性。投影账本保留每条被暴露边的层与来源。

### 边稳定性与结构性合并

请阅读完整职责说明：[边稳定性与结构性合并](active-graph-activation-and-consolidation/edge-stability-and-structural-consolidation.md)。

### 自适应语义粒度

节点代表当前证据下的一种观察等价类：当系统缺乏可靠信息以区分记录用途时，这些记录留在一起。新的证据、作用域、时间、关系或查询行为可以提供细化该类别所需的区分信息。

两种不同操作必须保持区分：

- **Leaf/block 拆分：** 节点含义仍然连贯，但其证据规模过大或过于多样，不适合高效的局部检索。
- **节点细化：** 单个 header 不再描述实质不同的实体、作用域、状态或查询行为，因此稳定的子节点／新节点是合理的。

候选细化信号包括：

- 较高的指派或路由熵；
- 若干个稳定的作用域／实体簇；
- 较高的矛盾或陈旧状态率；
- 反复从节点 header 回退到宽泛的记录扫描；
- 查询持续只使用该节点的一个子集；
- summary 对成员证据的覆盖较差；
- 先前分离的节点之间出现稳定的共检索或关系证据。

仅凭规模不是拆分条件。拓扑变更使用滞后：它们要求最小证据数、增益阈值与冷却期，使一次异常查询无法反复拆分并合并该图。

合并／拆分操作保留记录与证据、把旧节点标记为不活动，并保留重定向。拆分要求完整且不相交的记忆划分。

### 节点身份与可逆规范化

请阅读完整职责说明：[节点身份与可逆规范化](active-graph-activation-and-consolidation/node-identity-and-reversible-canonicalization.md)。

### 静态时间与逻辑记忆链

关系回答哪些语义节点相关联。有些召回任务还需要一段有界、有序的精确记忆记录切片：一段状态历史、事件序列、显式依赖路径，或一个分支／合并计划。NMG 把该结构表示为既有 `MemoryRecord` ID 之上的可选 **memory chain**。链不是又一个真值存储，也不复制证据。

```text
MemoryChain
  type: temporal | logical
  topic
  optional ownerSessionId
  ordered member references
  optional directed order edges (DAG)
```

两种类型的写入权限不同：

- **时间链**使用显式事件时间或另一种可归因顺序来排序记录。时间戳顺序可以由机器派生；缺失的事件时间不得被发明。
- **逻辑链**只存储显式或经受自然监督的顺序或依赖。相似性、共检索、消息相邻性或模型推测都不能创建因果边。

一条记忆可以加入多条链。每条链的有向 `order` 边必须保持无环；允许分支与合并。增加一条边会幂等地加入其端点记忆。移除成员会按数据库完整性规则移除相关指针，但绝不删除底层记忆或证据。当某成员被取代时，链读取保留历史成员并暴露其活动 `successorId`，从而同时保留快照语义与活引用语义。

链遵守物理记忆驻留。LTG 链是持久／共享的。项目 STG 中的链归一个会话所有：create/list/get/member/edge 操作被路由到该项目的 STG，并拒绝外来所有者。链本身不晋升 STG 内容，也不绕过普通合并策略。

检索只有在一段普通查询已经找到某个成员之后才使用链。它追加一段有界的相邻成员窗口作为召回补充，而不对原始命中做全局重排。调用者随后可以用普通 Active Graph 预算请求精确证据。因此链扩展改善的是有序上下文；它不证明相关性、因果性、正确性或答案充分性。

链是普通 Agent 披露路径的一部分，而不是仅 Pi 或仅 benchmark 的元数据。`src/integration` 下的宿主中立集成投影器拥有链名称、响应本地标签、边压缩与独立结构预算。适配器 search header 公布有多少条逻辑链被表示、标出哪些候选同属一条链，并引导 Agent 使用精确 `get`。精确 get 会补全每条被选中记录的活动链成员关系，并只返回两个端点都在所选证据集合中的链边。Pi 与 Claude 消费该共享投影：各自把每条完整陈述各输出一次，为该响应分配一个简短稳定标签，并用仅标签的 Mermaid 风格边渲染逻辑结构。CLI 紧凑 search 投影暴露链成员关系与链总数；其精确 JSON 响应携带规范成员关系与边，使仅用 shell 的 Agent 无需 Pi 依赖也能渲染同一结构。扇入与扇出使用更短的精确表示来分组（`A & C --> B`
或 `A --> B & C`）。结构披露有独立的 2048 字符预算，可以在不截断、不移除精确证据的情况下省略。OmniMemEval 保留一个评测格式兼容渲染器，且不定义该产品契约。时间顺序保留在记录时间戳中，不作为第二个时间轴块重复。

稳定的 daemon/CLI 管理边界支持链的 create/list/get、成员 add/remove、边 add/remove、结构化边读取与确定性拓扑排序。这些操作被有意排除在默认 Pi 模型工具面之外：宿主可以在其领域能提供可信链监督时加入更高层工作流。
