# 跨会话演进回顾：时间链/逻辑链设计 与 memory-graph-reasoner 现状

日期：2026-08-13
状态：设计讨论收敛（未实现）
范围：BEAM 弱项分析 → 业界调研 → 链（时间/逻辑）设计 → 已有推理模块定位

---

## 1. 背景与问题

- **BEAM 弱项**（`nmg_beam100k_bge_records_20260726`）：`event_ordering` 0.2606、`summarization` 0.3433，整体 Nugget 0.6422。
- **弱因不是缺结构，是缺编排方法**：
  - 多记录聚合/演进类查询**召回不足**（event_ordering 平均 0.9 条、summarization 2.0 条，对比 temporal_reasoning 8-9 条 → 0.71）。
  - 时间戳未可靠进上下文（`needsTemporalContext` 正则只覆盖 4/40、8/40 的这两种查询）。
  - 检索按相关度排，非时间线。
- **用户原则**：不为刷分改 benchmark；benchmark 只是改进方向验证；改进以真实能力缺口驱动。

## 2. 业界调研（可借鉴清单）

| 来源 | 类型 | 可借鉴点 |
|---|---|---|
| Mem0 Temporal Reasoning | 平台 | 写时提取时间元数据 + 检索时重排 + `state key`/`event_end` 演进链；**代价：knowledge-update −2.6 回归**（全局重排会伤害其他查询） |
| Mem0 Memory Decay | 平台 | 检索时近期 1.5x / stale 0.3x，不删除只降权 |
| Zep / Graphiti | 论文 | 时序知识图谱，cross-session synthesis 提升 up to 18.5% |
| TH-RAG（ACL'26） | 论文 | 话题层级补稀疏连接——对应 NMG 的 node 聚类 |
| Emmimal/temporal-rag | 工程库 | post-retrieval 时间层（validity/kind/decay/event gate/自适应权重）——**与 NMG supersedes 结构同构，工程化成熟** |
| MMR（1998） | 经典 | 多样性重排 `MMR = λ·Sim(Q) − (1−λ)·max Sim(D_j)`，防单话题占满窗口 |

**综合判断**：NMG 的时间/逻辑链基础设施（`eventTime`、`supersedes_id`+status、`related_memory_ids`+claim_outcome、node 聚类、QPP）**已齐全**，缺的是编排方法，不新建结构。

### 第三轮补强（2026-08-13 追加）
| 来源 | 类型 | 对设计的意义 |
|---|---|---|
| **Chronological Passage Assembling** | 论文 | **按时间组装检索片段**保留事件时间线、提升时序 QA——且"**呈现组织本身是独立准确度驱动**"（检索固定也有效）。落在我们职责划分的**呈现层**（非检索重排）——给"按时间组织呈现"实证依据 |
| **Supersede**（LongMemEval knowledge-update） | 论文 | **丢弃 superseded 事实是独立失败模式**——直接支持 NMG `supersedes` 保留历史的设计 |
| **MemOps** | 论文 | 黑盒 QA 评分混淆失败原因（missing facts / wrong bindings / stale values）——**评估要按失败类型归因**（BEAM 分析已按维度归因） |
| **TrustMem** | 论文 | agent 可写操作（write/revise/delete）会污染记忆/幻觉——**支持红线（推演产物不落库、不自动推断）** |
| **FOREVER / ForgetBench** | 论文 | 艾宾浩斯遗忘曲线启发的重放；遗忘时序动态基准——decay/记忆生命周期维度 |
| **Graphiti（GitHub 工程）/ Letta Memory Blocks** | 工程 | 时序上下文图 + 记忆块作为**离散可整取单元**——链"整链拉起/截取"的工程参照 |

## 3. 设计收敛

### 3.1 检索不全局重排
（借用已有概念：temporal-rag 自适应权重 / Mem0 回归 / MMR / Chronological assembling）
- 正序/倒序/时间段是**查询相关**的三种互斥语义，检索器不知道按哪种。
- 全局时间重排必然伤害其他查询（Mem0 knowledge-update 回归为证）。
- **已有概念依据**：
  - temporal-rag **adaptive weighting**：查询信号（"current"/"recently"）→ **局部调时间权重**、不改排序语义——时间感知是查询驱动，非全局重排
  - **MMR**：检索重排加多样性（λ·相关 − (1−λ)·新颖），防单话题占满窗口 → 保跨话题/跨时间记录
  - **Chronological Passage Assembling**：**呈现层按时间组装**片段保留时间线、提升时序 QA；"呈现组织本身是独立准确度驱动"——排序放呈现层而非检索层
- **职责划分**：
  - 检索器 = 召回**时间完整的链**（同话题多条、时间分散、带时间戳）——recall 问题
  - 呈现层 = 时间戳可靠进上下文
  - 排序 = 交给下游/模型，按查询意图自己决定正序/倒序/时间段

### 3.2 链 = 独立小 DAG 森林 + 节点公用交叉
（借用已有概念：TH-RAG / Graphiti / Letta Memory Blocks / Mem0 state-key / Supersede）
- **时间链**：`eventTime` 序列的静态存档，方向自动（天然无环）。
- **逻辑链**：`requires` 依赖的静态存档，方向写入时显式、可归因。
- 每条链小、独立、内部无环；**节点公用形成交叉**（用户原始直觉：独立/公用/交叉）。
- 互相引用跨链表达（链A: A→B；链B: B→A），每条链无环；`relate` 作链间桥。
- **链只存静态依赖，不推理**（推理推演是已有模块的事）。
- **已有概念依据**：
  - **TH-RAG**：话题层级（subtopics→topics）组织补**稀疏连接**——链 = node 聚类的有序化
  - **Graphiti**：时序上下文图，事实随时间变化 + 维护 provenance——跨实体交叉的工程参照
  - **Letta Memory Blocks**：记忆块 = **离散可整取单元**——链"整链拉起/截取"的工程参照
  - **Mem0 `state key`/`event_end`**：同一演进事实的链（新状态接管、旧状态关闭）——时间链的演进语义
  - **Supersede**（论文）：丢弃 superseded 事实是独立失败模式——链**保留历史**的依据

### 3.3 边界红线
（借用已有概念：TrustMem / MemOps）
- 链由**自然监督**驱动（写入时显式关联），不自动推断方向。
- 推理推演产物（推导结论/归因路径）**不落回链/记忆**（不污染不可变记忆；除非自然证据）。
- **已有概念依据**：
  - **TrustMem**：agent 可写操作（write/revise/delete）会污染记忆/引入幻觉 → 推演产物落库有实证风险
  - **MemOps**：黑盒评分混淆失败原因（missing facts / wrong bindings / stale values）→ 评估须按失败类型归因（BEAM 分析已按维度归因）

### 3.4 记忆生命周期 / 遗忘（借用已有概念：Mem0 decay / FOREVER / ForgetBench）
- **旧记忆不删但别占主导**：Mem0 Memory Decay（近期 1.5x / stale 0.3x，检索时降权）。
- **遗忘是真实需求**：FOREVER 用艾宾浩斯遗忘曲线启发的重放（而非固定步数启发式）；ForgetBench 评估遗忘时序动态。
- **对 NMG**：`eventTime` + decay 语义在**呈现/排序层**实现（不落库），与 superseded 保留历史互补——旧记忆留在链里，但检索/呈现时按当前性降权。

## 4. 已有模块：`src/lab/memory-graph-reasoner.ts`（autodiff 衍生的推理推演）

**用户澄清**：这是**已存在**的、从 autodiff 衍生的推理推演模块（非规划中）。

### 能力
- **可微集合逻辑**：`LogicExpr`（`atom`/`and`/`or`/`not`/`nand`/`xor`），t-norm 运算，整个表达式留在 autodiff DAG 内，梯度回流到 τ。
- **前提依赖门控**：`MemoryNode.requires` → precondition DAG（`σ(v^T@q)` soft-AND 乘积，也在 DAG 内）——节点 gate 只在前提活跃时打开。
- **贪心图遍历**：`traverse()` 每步评估邻居、前进到最高分节点。
- **What-if 反事实**：注入假设节点比较遍历。
- **autodiff 训练**：`trainPath`（梯度回传整条遍历路径）、`trainLogic`（τ/逻辑参数收梯度）。

### 接入史（git 确认）
- `03a3fb1` 创建（nodes as micro-operators）→ `182aa24` KDA 状态更新 → `57228f0` 可微集合逻辑 → `18febee`/`586af38` 测试进 CI。
- **`cfbe471`（8月4日）**：整个 Lab 栈（MemoryGraphReasoner / ReasoningWorkspace / ForkMerge / 可微控制器栈 autodiff+controller-*/shadow-evaluation / rank-fusion）标为 **"never wired into the runtime"**，移进 `src/lab/`、从公共 `src/index.ts` 导出移除（"public API equals wired capability"）。
- **`14cf0e8`（8月13日）connect Pi reasoning workspace**：又接入 pi 扩展（`.pi/extensions/nmg/reasoning-workspace.ts` + `index.ts` +139 行）——**用户实际用过**。
- **当前**：`index.ts` 中 `reasoningWorkspaces` 仅当 **`NMG_ENABLE_LAB_TOOLS=1`** 时实例化（默认关）——gate 在 lab 开关后的可选工具。

### 现状（"不好用"的用户评价 + 客观依据）
- **定位是推理草稿本（scratchpad）**：文件后备、会话私有（`<data>/reasoning/<session>.json`），节点+边+checkpoint，原子写入、不碰语义记忆 daemon——只是**记推理过程**，不是驱动检索的推理引擎。
- **可微引擎（MGR/DC 栈）从未接入运行时**：cfbe471 明确标为 never-wired-in-runtime；检索/控制器管线不使用它。
- **难调**：τ / gate bias / β 等多可微参数，tuning 成本高；依赖节点向量嵌入（冷启动难）；trainPath/trainLogic 需自然监督样本（24-task gate 未达）。
- 有完整单测（`tests/core/memory-graph-reasoner.test.ts` 等）但仅验证自洽。
- **用户评价（2026-08-13）**："其实它不是很好用"——接入过（14cf0e8）但体验不佳：作为 scratchpad 能力有限，可微引擎又从未真正驱动检索。

### 与已有概念的对照
- `LogicExpr`（t-norm 可微集合逻辑）≈ **模糊逻辑 t-norm 运算**（product=AND / probsum=OR / complement=NOT）——已有数学概念的可微化
- `requires` precondition DAG ≈ **逻辑前提依赖**（TH-RAG 话题层级、Graphiti 实体关系同族）
- `trainPath`/`trainLogic`（可微训练遍历路径）≈ **可微检索/端到端可微记忆**（与 NMG DC 同族）；对比 Mem0 时间元数据是启发式非可微——reasoner 是更激进路线
- what-if 反事实 ≈ 反事实推理/消融（评测与解释的已有方法）
- "难调 + 未接入" ≈ 印证 **TrustMem**（可微可写系统引入幻觉风险）与 NMG 红线（public API = wired capability）

### 定位
链的静态存档（`requires` + `eventTime`）**形式对齐它**（作为可选引擎）；但链**独立可用**，不绑定它好用。落地路径待定（见 §6）。

## 5. 推理草稿（scratchpad）→ 黑板私有频道（用户决策 2026-08-13）

**决策**："需要时共享就可以，一直不共享就是私有。"

- **私有 ≠ 权限机制**：不是给频道加 owner/private 字段，而是**默认不主动共享**；只要不发布，就一直私有。
- **落点**：推理草稿写进**黑板私有命名频道**（如 `scratch:<agentId>`），`kind=note`（silent，天然不 wake 任何人）。
- **共享 = 主动动作**：需要时把条目**发布到共享频道**（world/命名）或**定向 `to=<agent>`**；不发布则一直私有。
- **零新机制**：黑板已有 silent kind + 订阅制 + 定向投递，全部复用。
- **分层**：纯私密的草稿继续留本地文件 scratchpad（只有自己能读）；要共享 / 跨会话的用黑板私有频道。
- **业界对齐**："默认私有、显式共享" ≈ **A2A / MCP 的资源授权模式**（最小暴露，显式授权才共享）。

## 6. 待定项 / 已解决（2026-08-13）

**已实现**：
- ✅ **链长截取**：`SearchOptions.chainExpansionWindow`（命中点窗口 [minHit−window, maxHit+window]，默认整链）——commit d0a1cc0
- ✅ **supersede 活/快照引用**：`getMemoryChain` 对已 superseded 成员返回 `successorId`（活引用指针）+ 保留原快照（历史上下文）——commit d0a1cc0
- ✅ **记忆生命周期/遗忘（§3.4）**：`SearchOptions.recencyDecayHalfLifeDays`（可选，默认关；历史查询 eventTimeTo 跳过；无 event_time 不衰减）——commit fbc45e5

**暂缓（按判断）**：
- **memory-graph-reasoner 接入**：暂缓——reasoner 是 lab 实验（用户评价"不好用"、未接入运行时、依赖向量嵌入冷启动难）；链不绑定它，等其可用性提升再议。
- **BEAM 验证**：需 bge embedder 环境（本地 Hashing 无法检索），环境就绪后做。
- **自然数据验证**：以自然监督数据积累验证"跨会话演进回顾"真实需求后再决定优先级（不刷分）。
