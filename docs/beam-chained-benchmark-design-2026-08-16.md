# BEAM 有链基准设计（2026-08-16）

## 背景与问题

- BEAM 全量（400 问，idtime + 新参数，2026-08-16）Nugget **0.6568**；**event_ordering 0.1892 最弱**，summarization 0.4652 次弱。
- **但 BEAM 数据没有任何链**：合成会话导入的记忆无 `chainMemberships`，检索上下文从不渲染链块——链（时间链/逻辑链 + DAG 边 + Mermaid 呈现）的价值**完全测不到**。
- event_ordering 弱是**无链情况**下的时序判断（只靠行 `[time]` 标签）——不能归因于链。

## 目标

把 BEAM 变成**有链基准**（合成注入链，作为基准构建而非系统行为），用**同题有链 vs 无链**对比测链的真实价值，不等 codex-root 真实链数据。

## 方案：bridge 链注入（`chainInjection`）

`OmniMemEvalBridge` 加评测专用构造选项 `chainInjection?: "temporal" | "logical" | "both" | "none"`（默认 `"none"` = 现行为）。在 `#add`（op: add）写入循环**之后**统一建链。

### temporal 注入

同一会话（session）的对话证据记忆，按 `eventTime`（消息 `chat_time`）**升序**建一条时间链：

```
createMemoryChain({ chainType: "temporal", topic: <会话>, ownerSessionId })
→ addMemoryToChain({ chainId, memoryId, position })  按 eventTime 序
```

### logical 注入

同一会话的对话证据记忆，按**消息顺序**（数组 index）建一条逻辑链（因果序近似）：

```
createMemoryChain({ chainType: "logical", topic: <会话>, ownerSessionId })
→ addMemoryToChain({ chainId, memoryId, position })  按消息序
```

- **粒度**：会话级——BEAM 导入时同一会话所有消息同 `nodeName`（`Conversation <id>`），链 = 会话时间线/因果线。
- **过滤**：只对 `conversation_evidence` 记忆建链；forget 边界记忆（`[forget]`）不参与。
- **单次 add 内建链**：BEAM 每会话一次 add，链在本次写入循环后统一创建，不跨 add。

### 存储与检索交互

- 存储：`memory_chain_members`（节点集 + position 插入序）。**先线性序**（position 足够，bridge 渲染走 position 相邻回退）；后续可加 `memory_chain_edges` DAG 边（同会话因果分叉）做增强。
- 检索：`expandChains` 自动生效——命中记忆查到链 → `chainExpansionWindow` 把窗口内成员拉进上下文 → 链块 = 检索结果（命中+展开）中该链的成员。

### 与 idtime 渲染交互（关键）

- **逻辑链**：渲染 Mermaid `flowchart LR`（短 id 边）——因果结构可见。
- **时间链**：idtime 下**不渲染块**（时间在行 `[time]`）——但**链展开仍拉入相关成员** → 上下文增强。

**→ 链注入的价值路径有两条，评测要分别识别**：
1. **检索增强**：`expandChains` 窗口把链上相邻成员带进上下文（即使无块也增强）。
2. **呈现**：逻辑链 flowchart 的因果可视化（时间链在 idtime 无块）。

## 边界（红线合规）

- **合成注入 = 基准构建**（显式构造的评测设置），不是系统运行时自动推断方向——不违反"自动推断方向=污染"红线（该红线约束运行中的记忆写入，不约束基准数据准备）。
- **对比设计防刷分**：同一批题、同参数、同 judge，跑 `chainInjection=none`（现 0.6568 基线）vs `both`（有链）——测的是**增量**，不是绝对值。
- 合成链是近似（逻辑链=消息序因果），结论用于**验证链机制的呈现/检索价值**，不等同于真实链质量。

## 评测协议

- 数据：BEAM 100k（20 conv，400 问），不截断。
- 参数：新参数（关思考 + max_tokens=1000），3-run judge，`--lib nmg`。
- 对比组：
  - `chainInjection=none`（基线，= 0.6568）
  - `chainInjection=temporal`
  - `chainInjection=logical`
  - `chainInjection=both`
- 关键观察维度：**event_ordering**（temporal 链展开是否提升 0.1892）+ 整体 + summarization。

## 预期解读

- event_ordering 提升 → 链的时间关联（展开 + [time]）帮助时序判断。
- 整体提升 → 链检索增强有普遍价值。
- 无提升 → 链机制对 BEAM 合成数据无增量（真实链价值仍需 codex-root 验证）。
- **注意**：idtime 下 temporal 链不渲染块——若 event_ordering 提升，需区分来自**检索展开**还是**行 [time] 已够**（可加 4 组：有链+expandChains 开/关）。

## 开放问题

1. **长链**：会话几十条消息一条链——`chainExpansionWindow` 默认窗口多大？窗口过小丢时间线、过大爆预算（现实现有窗口控制）。
2. **逻辑链语义**：消息序 ≈ 因果序的近似度——合成数据里消息本来就是按时间/因果铺的，近似合理。
3. **DAG 边**：先线性 position；后续要不要对逻辑链注入分叉边（同一 node 多分支）？
4. **expandChains 开关**：为区分检索增强 vs 呈现，是否加 `expandChains=false` 对照？

## 实验结果（2026-08-16，400 问全量，idtime + 新参数）

| 组 | 整体 | event_ordering | summarization | info_extraction | multi_session | temporal_reasoning | instruction |
|---|---|---|---|---|---|---|---|
| none（基线） | 0.6568 | 0.1892 | 0.4652 | 0.7668 | 0.6595 | 0.6000 | 0.8000 |
| temporal | 0.6755 (+1.87pp) | 0.2173 | **0.6958** | **0.8764** | **0.7363** | 0.5687 | 0.8125 |
| logical | **0.6867 (+3.0pp)** | **0.2379** | 0.6891 | 0.8458 | 0.6400 | **0.6896** | **0.8708** |
| both | 0.5624 (-9.4pp) | 0.0269 | 0.3181 | 0.7792 | 0.4530 | 0.6771 | 0.7125 |

### 结论

1. **单链注入提升真实有效**：logical +3.0pp、temporal +1.87pp；event_ordering +2.8~4.9pp；summarization 单链 **+23pp**（0.4652 → 0.69）。
2. **链价值 = expandChains 检索增强**（不是渲染块）：temporal 链在 idtime 下不渲染块也提升——窗口展开把同链相邻记忆拉进上下文。
3. **both 灾难性下降**（0.5624，event_ordering 0.0269 / summarization 0.3181 / multi_session 0.4530）——**双链上下文膨胀稀释 LLM 有效预算**，关键信息被淹没。
4. **单链各有优势维度**：temporal 强 info_extraction / multi_session / summarization；logical 强 instruction / temporal_reasoning / event_ordering——**但不能叠加**。

### 对真实链设计的启示

- **单链策略**：检索只展开最相关的一条链，避免多链同时展开。
- **链展开预算封顶**：`chainExpansionWindow` 是单链内预算；还需要**跨链总预算**（both 就是无跨链预算的教训）。
- 真实链场景（codex-root 自然链）通常天然单链——此结论提示：**检索展开时若命中多条链，选相关性最高的一条**，而非全部展开。
