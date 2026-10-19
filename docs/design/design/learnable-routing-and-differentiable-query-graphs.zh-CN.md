# 可学习路由与最小可微查询图

[English](learnable-routing-and-differentiable-query-graphs.md) · [使用的术语](learnable-routing-and-differentiable-query-graphs.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## 可学习路由与最小可微查询图

NMG 包含一个零依赖、针对 CPU 优化的 UOp 自动微分引擎，完全建立在 Float32Array 之上。它遵循 tinygrad 的关注点分离：Tensor 是 UOp DAG 之上的建图前端，求值是惰性的，梯度构建与图执行分离。NMG 有意省略调度器、kernel lowering、代码生成、JIT 与设备运行时，因为控制器负载（约 280 KFLOPs/查询）不足以支持它们。

这个引擎是 Lite 的基础设施，并不主张 STG、LTG 或 AG 本身可微。那些图是语义与运行时数据结构。控制器可以从它们的数值特征构建一个临时可微投影、优化其参数，然后把结果交回普通的受预算图选择。

Pi 适配器在带类型的运行时策略通道之后有一个惰性控制器桥。`NMG_CONTROLLER_SHADOW=1` 启用有界收集；它不会决定运行时权限。`NMG_CONTROLLER_RUNTIME_MODE=off|shadow|controlled|active`（默认 `shadow`）决定权限（[模式要求](../../../skills/nmg-memory/references/optional-capabilities.zh-CN.md)）：`off` 不进行任何学习打分；`shadow` 可以打分与记录但不能执行；`controlled` 只能在一个显式标记的受控评测内执行；而 `active` 还额外要求一份经审阅的激活回执。该回执绑定精确的训练状态哈希、特征协议版本、检索／控制器／产品门禁产物，以及一个当前运行时可以加载用于回滚的不同先前控制器状态。缺失、被修改或无法加载的产物 fail closed。因此 QPP1/QPP2 的 `active` 与 `NMG_CONTROLLER_RERANK=active` 暴露的是能力，而不是自身即权限。零步控制器是惰性的，且所有活动输出都保持在硬性最小／正常／扩展包络之内。

只有带类型的数值 `allocate`、`fold` 与稳定的 rerank 决策跨越该通道。候选策略文本、激活元数据、控制器协议与门禁产物永不进入回答 Agent 的 prompt。受控与活动执行日志包含模式、特征协议版本与候选哈希，使一次运行可以归因到精确的学习产物。

该桥在 `NMG_DATA_DIR` 下的一个有界日志中记录基线与学习后的节点顺序。从归会话所有的 Active Graph 取回的精确记录被记录为披露；自动召回所用的保守答案到记忆匹配器被记录为诊断归因。二者都不训练控制器。证据排序与预算 head 只从离线连接的已验证用户／工具／官方 benchmark 证据训练。注入、排名位置、单纯暴露、答案重叠与沉默永远不是正标签。显式 `nmg_remember action=feedback`
标签仍是任务成功、证据充分性、扩展有用性、噪声与 no-memory-needed 判断的独立来源；跨会话图 ID fail closed。缺失的显式反馈保持未知。因此 shadow 模式不能改变检索，而活动 QPP 模式是显式的实验性产品选择，而不是自动的校准晋升。

所有普通客户端通过一个数据路径契约解析 shadow 日志与数据库：显式 `NMG_DATA_DIR` 优先，否则使用用户级 `~/.nmg` store。受控／无头评测传入项目本地 `.nmg` 兜底，或显式设置 `NMG_DATA_DIR`。Pi 扩展、daemon 客户端、CLI 服务、shadow 导出器与非 Pi 适配器共享该解析器。**已实现，并由路径契约测试覆盖。** 这一区分防止普通长期记忆按工作目录碎片化，同时保持 benchmark 状态隔离。

由于答案质量标签只有在 Agent turn 之后才可观察，Pi 桥把证据确实被披露、但显式任务标签缺失的已完成检索保留在会话本地状态中。诊断性答案重叠不参与这一选择。在下一个不同的用户 turn，该桥最多暴露一条一次性
审阅提醒，其中含 AG ID 与稳定的查询任务 ID。具有相同用户 prompt 的内部 Pi 工具循环不能消费该提醒。Agent 可以通过既有 remember 反馈动作提交 `evidenceSufficient`、`expansionUseful`、`excessiveNoise` 与 `noMemoryNeeded`。缺失审阅保持未知；完成、沉默、暴露或没有纠正本身都不是标签。

提醒暴露被记录为一条非训练性的 `tool_flow/feedback_nudge_shown` 事件。这把「Agent 跳过了可观察提醒」与「没有提醒被呈现」区分开，同时不把任一情形变成相关性标签。由查询派生的任务 ID 建立的是生命周期分离，而不是语义多样性；校准必须额外要求足够多样的自然任务，且不得把同一决策的改写计为宽泛证据。

稳定 daemon 已经拥有与 agent 无关的 `search -> get(activeGraphId)` 披露跟踪与诊断答案归因。更丰富的反馈动作留在 Pi 适配器，因为只有宿主能观察到答案完成、用户纠正、工具轮次与模型用量。未来的第二个适配器应实现同一带版本 shadow 事件契约，而不是给稳定 daemon 协议增加一个依赖 Lab 的反馈方法。

控制器激活证据使用一个打分产物契约，而不是拼接无关的 benchmark 摘要。每条匹配的 Pi 行记录从 prompt 到结算与整答案延迟、工具派发次数、含工具的模型轮次，以及来自精确 Pi 事件流的 provider 输入／输出／cache token 用量。官方评分器增加一个 `rowScore`，它始终保留 benchmark 的数值任务分数，同时让二值 `taskSuccess` 可为空：PersonaMem 与 LongMemEval 提供二值任务标签，而 BEAM 的部分 rubric/Kendall 分数与 LoCoMo 的连续官方分数不提供。证据充分性同样可为空，并按 provenance（`id` 或诊断性 `text`）带上类型；缺失标签永不被转换为零。

只有完整的同 case／同 repeat 双臂配对才可以聚合进 `ControllerMatchedProductMetrics`。聚合在缺少某一臂、缺少二值任务标签、缺少全证据标签、证据种类不匹配、缺少 token／工具／延迟遥测，或某个候选并未实际影响检索时 fail closed。匹配 runner 要求一个显式的冻结候选状态，检查其特征协议与非零训练步数，把它哈希进报告，并只把它复制进候选臂。运行时 `allocate|fold|rerank` 动作是带类型事件；评分器从这些事件派生因果资格，并拒绝任何基线执行，而不是信任报告里写的一个布尔值。一个门禁安全指标非空的官方分数产物可以通过 `NMG_CONTROLLER_MATCHED_PRODUCT_REPORT` 送入离线控制器评测；[评分与校准命令](../../../evals/README.md#real-use-controller-calibration)以及[控制器校准指南](../../../skills/nmg-memory/references/qpp-calibration.zh-CN.md)记录了确切用法。畸形或仅诊断的产物仍缺席产品门禁。一个单问题因果烟测证明的是这条执行路径；它不确立候选质量，也不授权 active／默认路由。

同一有界日志把宿主级渐进披露干预记录为独立的 `tool_flow` 事件。特别是，一次未加载证据的第三次显式 search 被记录为 `search_suppressed`；它不被计为一次检索、一次任务成功或一个相关性标签。这使 prompt／工具循环可测量，同时不污染控制器训练目标。

检索事件保留既有 AG 查询指纹、QPP 组件与扩展阶段，以及逐选择分数。离线控制器数据集导出器按图连接检索／披露／归因／结果／反馈，只接受被单独标注的行，并按整组 `semanticTaskId` 做按时间顺序的划分。查询指纹仍是诊断标识符，永不被晋升为语义任务标签。稀疏日志产生显式 blocker，不能授权策略变更。

仅按任务分组不是足够的泄漏屏障。由查询派生的任务 ID 对于共享同一证据的改写可能不同。因此校准只从已验证 claim 支持派生一个保守的**主证据目标**，绝不从加载或答案重叠派生。激活门禁要求在训练中具有足够多的不同主目标，同时不让一个多证据任务虚增多样性计数。泄漏则针对完整的已验证证据集合更严格地检查：任何同时被训练与验证使用的记忆都会拒绝该划分，即使它在任一行中都不是主记录。主目标是多样性代理，并不主张一条记录完整代表一个语义任务；多证据问题在 replay 行中保留其完整的已验证证据集合。

每个新的检索事件还存储精确的 `CONTROLLER_FEATURE_PROTOCOL_VERSION` 特征快照，以及同期的 Active Graph 硬预算包络。这是离线 replay 所必需的：标签、QPP 分数与观测成本本身无法重建控制器输入或其归一化预算目标。缺少任一快照的旧行被报告并排除。

`npm run eval:controller-calibrate` 只消费完全标注的按时间顺序训练／验证行。它训练一个新的候选、评估基线与残差学习节点排序加上通用 stop/expand head、报告检索／控制器／端到端／token／工具成本，并写出一个可审计候选产物，含来源日志指纹、特征版本、有效配置、数据窗口、指标与回滚状态指纹。该产物永不自动安装，且始终报告 `eligibleForActivation: false`；激活仍是后续的匹配门禁。

该后续门禁现在是显式的，并有三个独立部分。检索门禁保护上游候选召回；控制器门禁保护留出排序／控制质量与推理延迟；产品门禁要求一次具有足够配对 case 的基线／候选匹配比较。产品门禁在缺少匹配证据时 fail closed，并要求任务成功与证据充分性不退化和有界的平均工具轮次、token 与端到端延迟。这些产品成本不被加入 AG 分配 head：工具轮次包含非 NMG 工具，且观测式任务成功并不识别记忆动作的因果效应。硬性 AG 与宿主限制留在可微图之外。

渐进披露还约束工具序列，而不仅是返回文本。在一个 Pi 用户 turn 内，自动召回是免费的，但在两次显式 search 之后仍未加载所选证据时，适配器会把再一次 search 折叠为要求调用 `nmg_get` 或使用当前来源工具的请求。一次成功的精确 get 会为一次互补跳跃重新开放 search。该守卫以 Pi 会话加用户 prompt 为键，因为 `before_agent_start` 在内部工具循环中也会触发；只在那个生命周期事件上重置会使该界限失效。这是宿主成本／安全边界，不是相关性判断，也不是 QPP 的替代。

### UOp op 目录

请阅读完整职责说明：[UOp op 目录](learnable-routing-and-differentiable-query-graphs/uop-catalogue.md)。

### 性能优化

逐元素算子使用裸 `for` 循环。Matmul 使用 ikj 循环顺序以获得 cache 局部性。`Negate` 在编译期由 `multiply(x, Constant(-1))` 折叠。`SumN` 把链式加法序列融合进单个 N 输入算子。`Tensor.fromBuffer()` 支持零拷贝常量构建。控制器在阈值 B≥8 时把输入自动批处理为 `[F,B]` 矩阵。

### 架构

持久语义图、会话 Active Graph、不可变投影修订与可微计算图是彼此不同的对象：

```text
persistent STG + LTG in SQLite
  → retrieve candidates for a session/task frame
  → HierarchicalActivation.propagate(query, candidates, neighborhood, AG state)
     ├─ g₁: query → candidates cross-attention (learnable temperature)
     ├─ g₂: g₁ → neighborhood cross-attention
     ├─ g₃: L2Normalize(g₁+g₂+h₁+h₂+h₃)  spatial fusion
     ├─ h₁: EMA of g₁ across propagate() calls  (short-term temporal)
     ├─ h₂: mean of medium-term stable vectors   (from graphState)
     ├─ h₃: mean of long-term stable vectors     (from graphState)
     └─ 7-weight blended scoring → nodeScores
  → update the memory-resident session AG under hard budgets
  → optional MGR traversal over a bounded selected subgraph
  → HA rescore + DifferentiableController(node/edge/control/budget scores)
  → freeze a discrete ProjectionRevision for model exposure
```

自动微分计算图是临时的——每次 propagate/train 调用创建并在之后丢弃。会话 AG 也非持久，但可以在其所属会话内跨多个 turn 与压缩生存。SQLite、语义 provenance、合并、不可变投影修订与硬预算强制仍是普通的确定性系统组件。

可变语义粒度仍是一个实验性问题。仅层级、记录向量，以及独立排序的并集检索被保留为诊断模式，但在一次匹配的、带指纹的、重复的 benchmark 证明质量／成本优势之前，它们都不是 NMG 的强制表示。
