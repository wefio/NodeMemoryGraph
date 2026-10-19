# Memory-Graph Reasoner — 保留的数值 Lab 原型

[English](memory-graph-reasoner.md) · [使用的术语](memory-graph-reasoner.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## Memory-Graph Reasoner — 保留的数值 Lab 原型

`MemoryGraphReasoner` 作为受门控的数值引擎被保留。它不是 NMG Lite 的一部分，也不是[会话推理草稿板](session-reasoning-workspace-and-compaction-checkpoint.md)。Lab 服务把传入的基础图绑定到所属会话的 AG 投影及其声明预算；这种绑定不等于自动的 HA-to-MGR 编排。数值库同时支持旧的全局候选实验与显式有向拓扑。当任何输入节点声明 `outgoing` 时，第一步是全局查询种子，之后每一步都受限于前一节点的 outgoing 邻居；训练会拒绝违反这些边的路径。这证明的是边依从性，不是事实正确性，也不是自动逻辑推理。

### 概念

它不把记忆节点当作由固定函数打分的被动数据，而是让每个节点成为一个**微算子**，在图遍历过程中变换查询状态。遍历路径本身就是计算图——梯度经过每个被访问的节点回传到逐节点参数。

```text
q₀ ──→ [node A] ──→ q₁ ──→ [node B] ──→ q₂ ──→ [node C] ──→ q₃ → path loss
```

### 节点算子

状态更新有三个命名自由度，灵感来自 Kimi Delta Attention（FlashKDA，MoonshotAI）：

```text
g = σ(v^T @ q + b_log)       absorption — how much of THIS node to take in
A = σ(a_log)                  decay — global forgetting rate (0=wipe, 1=keep)
β = σ(β_log)                  retention — old state vs new state blend

q_tmp = A·q_old + g·v         decay old context, absorb new memory
q'    = β·q_tmp + (1−β)·query  output blend with original query anchor
r     = q'^T @ v              local relevance score
```

| 参数 | 作用域 | 含义 |
| --- | --- | --- |
| `b_log` | 逐节点 | 越高 = 从该记忆吸收得越多 |
| `a_log` | 全局 | 越高 = 跨步骤保留更多过去上下文 |
| `β_log` | 逐节点 | 越高 = 输出更偏向累积状态而非原始查询 |

节点可以声明 `requires: string[]`。在 `traverse` 中，每个具名事实贡献 `sigmoid(factVector · currentState)`，它们的乘积（soft-AND）乘到吸收门 `g` 上。这些值是数值相似性，不是经验证的真值或硬准入检查。缺少事实时回退为零向量，因此贡献 `0.5`，不是零。该门不会过滤候选；即使吸收为零，保留状态／查询锚点仍参与相关性打分，节点也不会在结构上被排除。`trainPath` 的状态更新没有传入这些前提；它检查声明的路径边，不检查事实是否满足。实现边界见 `src/lab/memory-graph-reasoner.ts` 的 `traverse`、`#reasonStep`、`trainPath`。

### 与 HierarchicalActivation 的关系

| | HA | MGR |
| --- | --- | --- |
| 节点角色 | 被动数据，被打分 | 主动算子，做变换 |
| 打分 | 7 路相似度混合 | 单门 + 局部相关性 |
| 图结构 | 固定候选层级 | 全局种子，之后可选有向邻居 |
| 参数 | 10 个全局标量值：7 个打分权重，加 temperature、temporal alpha、reasoning beta | 遍历为每节点 2 个 + 1 个全局；集合隶属度另有全局 sharpness 参数 |
| 目标实验，不表示已验证的优越性 | 池上批量排序 | 多步数值路径推理 |

它们仍是各自独立门控的引擎，但共享提议中的会话 AG 运行时：HA 选择并维护活动工作集；MGR 可选地把有界选中的子图变换为临时推理产物。效用与推理正确性仍需要各自的证据。显式 Lab 投影绑定已经存在，但不表示这条自动组合路径已经成立。

### API

```ts
const mgr = new MemoryGraphReasoner(64);

// Greedy traversal
const result = mgr.traverse(queryVector, graph, maxSteps);

// What-if simulation: inject hypothetical node, compare traversals
const impact = mgr.whatIf(queryVec, graph, hypotheticalNode, maxSteps);
const summary = mgr.impactSummary(impact, "task-x"); // compact LLM-ready text

// Train on labelled operator sequences
mgr.trainPath({ queryVector, pathNodeIds, graph }, learningRate);

// State round-trip
const json = mgr.toJSON();
const clone = MemoryGraphReasoner.fromJSON(json);
```

示例调用的是数值库，不是 Lab wire API。`trainPath` 更新本地 reasoner 参数，以最大化给定路径的局部分数总和；它不对比其他路径，也不证明贪心选择会走上该路线。`whatIf` 使用 `Map.set`：复用既有 ID 会替换本地副本中的该节点，而不是另加一个节点。

### 实验状态

MGR 在 daemon、CLI、Pi、MCP 与 DSH 适配器上作为会话作用域的 `memory_graph_reasoner` Lab 能力暴露。它产生确定性遍历、模糊集合搜索与 what-if 摘要，包括显式的边约束路径。这里的只读指 Lab 服务对记忆／存储的影响，不表示库对象或训练方法是纯函数。服务仅暴露 `traverse`、`logic_search`、`what_if`，每次调用创建新的 reasoner，并把输出标为 `persisted: false`。它在插入假设节点前，按所属投影检查基础图的节点 ID 及节点／边计数；这不表示插入后的 what-if 图会再次按相同计数复查。遍历和摘要都不是经过验证的 LLM 卸载推理引擎。服务边界见 `src/cli/service.ts` 的 `#invokeMemoryGraphReasoner` 与 `src/integration/lab-capabilities.ts`。

下图是示意，不是实测运行。贪心路径或分数发生变化，不证明因果效果或任务调度的关键路径；LLM 的末句是解释，不是 MGR 认证的结果。

```text
LLM context                    MGR (external)
───────────                    ─────────────
User: "What if we add task X?"
                               ┌────────────────────────┐
LLM → MGR.whatIf(              │ baseline: A→B→C→D      │
  query, graph,                │ with X:   A→B→C→X      │
  hypoNode=X, steps=4          │ D: exited, score +0.24 │
)                              └────────────────────────┘
         ← impactSummary()
         ← "X enters at step 4, D exits, path +0.24"

LLM: "Adding X pushes D off the
      critical path."
```

### 可微集合逻辑

请阅读完整职责说明：[可微集合逻辑](memory-graph-reasoner/differentiable-set-logic.md)。
