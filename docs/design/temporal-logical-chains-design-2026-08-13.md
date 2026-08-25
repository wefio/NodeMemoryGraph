# 跨会话演进回顾：时间链/逻辑链设计 与 memory-graph-reasoner 现状

日期：2026-08-13
状态：已实现（§7.6 ①②③④ 全部落地 + 链呈现层，含实现 commit 引用）
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

**当时的初步判断（已被后续实现修正）**：最初认为 `eventTime`、
`supersedes_id`、相关记忆和 QPP 足以承担编排，不必新增结构。后续设计发现，
这些字段无法稳定表达“同一记录属于多条有序路径、路径内分叉/汇合、整链或窗口
拉起”的静态引用语义，因此增加了独立 `MemoryChain`/member/edge 结构。当前规范
以主设计 §7.6 为准。

### 第三轮补强
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
- **用户评价**："其实它不是很好用"——接入过（14cf0e8）但体验不佳：作为 scratchpad 能力有限，可微引擎又从未真正驱动检索。

### 与已有概念的对照
- `LogicExpr`（t-norm 可微集合逻辑）≈ **模糊逻辑 t-norm 运算**（product=AND / probsum=OR / complement=NOT）——已有数学概念的可微化
- `requires` precondition DAG ≈ **逻辑前提依赖**（TH-RAG 话题层级、Graphiti 实体关系同族）
- `trainPath`/`trainLogic`（可微训练遍历路径）≈ **可微检索/端到端可微记忆**（与 NMG DC 同族）；对比 Mem0 时间元数据是启发式非可微——reasoner 是更激进路线
- what-if 反事实 ≈ 反事实推理/消融（评测与解释的已有方法）
- "难调 + 未接入" ≈ 印证 **TrustMem**（可微可写系统引入幻觉风险）与 NMG 红线（public API = wired capability）

### 定位
链的静态存档（`requires` + `eventTime`）**形式对齐它**（作为可选引擎）；但链**独立可用**，不绑定它好用。落地路径待定（见 §6）。

## 5. 推理草稿（scratchpad）→ 黑板私有频道

**决策**："需要时共享就可以，一直不共享就是私有。"

- **私有 ≠ 权限机制**：不是给频道加 owner/private 字段，而是**默认不主动共享**；只要不发布，就一直私有。
- **落点**：推理草稿写进**黑板私有命名频道**（如 `scratch:<agentId>`），`kind=note`（silent，天然不 wake 任何人）。
- **共享 = 主动动作**：需要时把条目**发布到共享频道**（world/命名）或**定向 `to=<agent>`**；不发布则一直私有。
- **零新机制**：黑板已有 silent kind + 订阅制 + 定向投递，全部复用。
- **分层**：纯私密的草稿继续留本地文件 scratchpad（只有自己能读）；要共享 / 跨会话的用黑板私有频道。
- **业界对齐**："默认私有、显式共享" ≈ **A2A / MCP 的资源授权模式**（最小暴露，显式授权才共享）。

## 6. 待定项 / 已解决

**已实现**：
- ✅ **链长截取**：`SearchOptions.chainExpansionWindow`（命中点窗口 [minHit−window, maxHit+window]，默认整链）——commit d0a1cc0
- ✅ **supersede 活/快照引用**：`getMemoryChain` 对已 superseded 成员返回 `successorId`（活引用指针）+ 保留原快照（历史上下文）——commit d0a1cc0
- ✅ **记忆生命周期/遗忘（§3.4）**：`SearchOptions.recencyDecayHalfLifeDays`（可选，默认关；历史查询 eventTimeTo 跳过；无 event_time 不衰减）——commit fbc45e5

**暂缓（按判断）**：
- **memory-graph-reasoner 接入**：暂缓——reasoner 是 lab 实验（用户评价"不好用"、未接入运行时、依赖向量嵌入冷启动难）；链不绑定它，等其可用性提升再议。
- **BEAM 验证**：需 bge embedder 环境（本地 Hashing 无法检索），环境就绪后做。
- **自然数据验证**：以自然监督数据积累验证"跨会话演进回顾"真实需求后再决定优先级（不刷分）。

## 7. 下一阶段：跨域类比 / 思想迁移 + 图计算借鉴

### 7.1 问题定义

**目标能力**：跨域类比 / 思想迁移——"很多知识可以在很多领域找到相似的思想"。定位为**知识拓展 / 好奇心·探索能力的基础设施**（高阶认知，区别于低阶检索）。

**与非目标区分**：
- 不是 bge 语义检索（同域同主题：词相近）
- 不是子图匹配（同一模式在**图内**重复出现 = 重复/泛化）
- 是**语义不同的子图之间**的抽象模式迁移/桥接（"预算演进"≈"技术选型演进"——词完全不同、向量相似度≈0，必须靠**结构抽象**）

### 7.2 调研

| 方向 | 结论 | 对我们的含义 |
|---|---|---|
| **Gentner 结构映射 SMT + SME**（认知正典） | 类比 = 结构(关系)共性而非表面相似；SME 是计算实现 | 方向正确：结构抽象是类比的核心 |
| **MAC/FAC 两阶段检索模型** | 表面相似主导**检索**，结构相似主导**判断**（候选进工作记忆后） | **架构依据**：bge 做表面召回 → 结构匹配做判断，两阶段分工 |
| **图迁移学习：拓扑原语**（NeurIPS 2025 通用拓扑原语迁移） | 用"拓扑原语"作跨图可迁移语义单元；可跨异构图（不同节点/边类型） | 支持"抽象模式库"概念；记忆图正是异构图 |
| **KGE 类比推理 AnKGE** | 在 TransE 类嵌入显式训练类比函数（实体/关系/三元组级） | 嵌入类比是另一条路（需图嵌入训练） |
| **图相似搜索**（GED NP-complete / SimGNN 神经近似） | GED 精确计算 NP 难；GNN 学图相似（快但需训练） | 精确 vs 神经是成本权衡 |
| **记忆与好奇心**（Soar 类比概念记忆 / Dynamic Memory-based Curiosity） | 认知架构用类比概念记忆做概念习得；记忆作内在奖励防稀疏环境局部循环 | 支持"好奇心基础设施"定位（记忆=探索的内在奖励源） |
| **已知障碍**（G²SN-Transfer 三大障碍） | 缺基准、缺对齐语义表示、缺系统方法论 | 需自建小基准；对齐语义表示是核心难点 |

### 7.3 可行性分析

**架构可行性（高）**：MAC/FAC 给出现成分工——bge（表面召回：快、覆盖广）→ 结构抽象+匹配（判断：精准）。我们已有 bge 检索层，只需补结构层，不重构。

**结构抽象可行性（中高）**：标号图（节点/关系有类型）+ 小模式（≤8 节点）+ 查询时按需扫（不建全图索引）→ 记忆规模（几千-几万节点）可承受；拓扑原语（NeurIPS 2025）证明"抽象骨架可跨图迁移"是前沿在做的事。

**成本/风险**：
- 无公开基准 → 需自建小基准（跨域类比测试集，从自然监督数据提炼 N 对"同思想跨域"案例）
- 对齐语义表示难（两个语义不同领域如何确认"同一个抽象模式"）——依赖链/关系完整性；结构抽象质量 = 上游数据质量的函数
- 误报风险：形似≠神似，结构相同≠思想相同 → 只产出"建议"，由下游 agent/人判断

**替代路径对比**：

| 路径 | 做法 | 成本 | 收益 | 判定 |
|---|---|---|---|---|
| A 两阶段（MAC/FAC） | bge 表面召回 → 结构抽象匹配 | 低（无训练） | 高（直接实现目标） | ✅ 采用 |
| B 拓扑原语模式库 | 预定义抽象骨架（演进/矛盾/依赖/反馈/聚合） | 低 | 高 | ✅ 采用 |
| C 嵌入类比（AnKGE 式） | 图嵌入 + 类比函数训练 | 高（训练+数据） | 中 | ⏸ 暂缓 |
| D 神经图相似（SimGNN） | GNN 学图相似 | 高（训练+基准） | 中 | ⏸ 暂缓 |

### 7.4 设计决策

1. **采用 A+B**：两阶段（MAC/FAC 分工）+ 拓扑原语模式库（无训练、标号图、小模式）
2. **暂缓 C/D**（AnKGE / SimGNN）：需训练 + 基准，等自建基准成熟再评估
3. **定位**：独立探索/拓展通道（agent 主动调用："这个新概念在我的记忆里有相似思想吗？"），**不进 searchContext 排序**（检索不全局重排红线不变）
4. **红线**：产出探索建议/知识拓展提示，不自动写记忆、不改检索、不自动写链/关系
5. **验证**：自建跨域类比小基准（N 对同思想跨域案例），测两阶段查准/查全

### 7.5 与反欺诈图计算借鉴的关系（原 7.1-7.4 浓缩）

反欺诈借鉴仍在（**能偷且部分已在偷**：链=时序图、graphHops=邻居图、memory-graph-reasoner=可微图计算）：
- **多跳路径检索**（最优先）：检索结果带关系追溯 path（node→relation→node），呈现层可解释"为何相关"；复用 reasoner traverse 路径概念
- **环/矛盾诊断**（轻量）：supersede/relate 环检测 → 维护诊断标注（不自动改链/关系）
- **社区发现/子图模式**：无模板/有模板匹配 → 自然监督候选建议（只建议不写）
- **不值得**：图数据库引擎（Neo4j/TigerGraph——嵌入式 SQLite 哲学）、图嵌入训练（bge 语义已强边际价值小；AnKGE 式嵌入类比另论，见 7.3 C）

### 7.6 实施顺序

1. **多跳路径检索（关系追溯 path）——已实现**（`e093eb6`）：`EdgePathStep` + `MemorySearchResult.path`，种子空路径、图扩展节点带完整链，多跳累积、3 跳衰减验证；direct 命中且图邻居也补。
2. **环/矛盾诊断（轻量）——已实现**（`cb4a858` 环诊断 + 写时防环 + 断开审计；`60f22b3`/`c3b9096` supersede 图性能特化）：对称关系（contradicts 等）双向不报环，有向语义环保留通用 DFS，supersede 环写时拒绝 + 审计断开。
3. **社区/子图模式建议（后置，自然监督候选素材）——已实现**（`ed8e979`）：`detectCommunities` 弱连通分量 + `analyzeCommunities` 模式画像与自然监督建议（EVOLUTION/CONTRADICTION/FEEDBACK/DEPENDENCY/AGGREGATION），只建议不写。
4. **跨域类比（A+B）独立线——已实现**（`294cd18`）：结构抽象层（5 模式结构签名）→ 抽象模式库 → 跨域匹配（Jaccard）→ 独立探索通道，只读不改；预算演进≈技术选型演进 score 1.00。
5. **链进 LLM 上下文呈现层**（`2f068cf` 序号+独立链块 / `f5598a8` 多链 memberships / `f4977cf` 链块 topic）：召回序号行 + 独立链块，链不污染记忆行，一条记忆可渲染进多个链块，同类型多链以 topic 区分。

每步遵守：检索不全局重排、链只存静态依赖、自动推断只建议不写。

## 8. Implementation lineage

- **Introduced — `155d88c9`**：建立独立的 temporal/logical chain 与成员结构。
- **Hardened — `d0a1cc03`、`fbc45e51`**：加入窗口、successor 活引用和可选 recency decay。
- **Hardened — `e093eb6c`、`cb4a858a`、`a126382a`**：补齐多跳 path、写时防环和 branching DAG pointer edges。
- **Validated — `2f068cfc`、`f5598a8c`、`f4977cf2`**：验证链的独立上下文呈现、多链 membership 和 topic 区分。
- **Hardened — `6db50df8`**：完成 daemon/CLI/application boundary；从此链不再只是 store 内部原型。

完整 owner 导航见 [implementation lineage](implementation-lineage.md)。
