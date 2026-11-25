# 统一记忆计算引擎

[English](compute-engine.md) · [术语](compute-engine.terms.yaml)

**Status:** current
**Authority:** [统一架构](../unified-architecture.zh-CN.md)

## 分层执行边界

`MemoryEngine`、`HttpMemoryService` 与 `PortableMemoryService` 将业务契约与事务持久化同检索、重排、图投影、写入预处理及变更计划计算分离：

```mermaid
flowchart TB
  Config["三级配置与能力绑定 (L0 公共默认 -> L1 共享 nmg.config.json -> L2 适配器覆盖)"] --> Logical
  API["对外业务 API (MemoryEngine, HttpMemoryService, PortableMemoryService)"] --> Logical["逻辑计算图 (ComputeGraphSpec & MEMORY_COMPUTE_CONTRACTS)"]
  Logical --> Planner["执行规划器 (CSE, 递归 DCE, 契约绑定, 下推改写, 线性融合)"]
  Planner --> Physical["物理执行计划 (依赖边, 资源锁, 代价模型, 引用计数释放)"]
  Physical --> Runtime["计算图运行时 (同步快路径, 事件驱动 DAG, 状态戳, LRU 缓存)"]
  Runtime --> Scheduler["统一运行时调度器 (HostLoadGovernor, Singleflight 去重, LocalWorkerThreadPool, SchedulingDomain)"]
  Scheduler --> Realizations["算子 / 子图 / 第三方适配器 / 下推查询"]
  Realizations --> Storage["权威存储与公共服务 (MemoryBackend, MemoryPlan, EmbeddingClient)"]
```

- **逻辑计算图（`ComputeGraphSpec`）**：使用 `src/core/compute-contracts.ts` 中的领域契约表达计算需求与数据流，不固化具体后端查询或执行顺序优化。
- **三级配置与声明式能力绑定（`src/core/capability-config.ts`、`src/integration/runtime-config.ts`）**：按 `L0` 公共参数契约与默认子图（`NMG_L0_CONTRACT_GRAPHS`）→ `L1` 共享策略与图配置（`NMG_CONFIG_PATH` 或 `<dataDir>/nmg.config.json`）→ `L2` 适配器覆盖（`resolveEffectiveNmgConfig`）顺序解析，输出参数来源溯源与缓存身份 `configIdentity`，并通过 `PolicyViolationError` 拦截未经许可的语义变更算法替换。
- **物理执行计划（`PhysicalExecutionPlan`）**：由 `src/core/compute-planner.ts` 编译（按图对象引用、基于 `WeakMap` 隔离的 `ComputeRegistry` 实例令牌、代数、`configIdentity` 与规划选项缓存），解析 `$contract` 契约节点，对 `pure` 节点执行公共子表达式消除，通过递归 `runDcePass` 保留含副作用的嵌套子图并消除其余死节点，将 `relational_query` 表达式改写为 `sqlite_pushdown` 或 `portable_scan`，可选将单消费者同步 `pure` 链路融合为 `fused_chain`（包含逐步参数签名），生成节点依赖边、共享 `ResourceLockManager` 资源集合（`src/core/resource-locks.ts`）与精确下游引用计数表。
- **运行时与统一调度（`src/core/compute-graph.ts`、`src/core/canonical-value.ts`、`src/core/runtime/*`）**：小规模纯同步图在未传入 `ComputeMemoCache` 时走零哈希内联快路径；异步 DAG 通过节点就绪唤醒驱动执行而无需全波次 `Promise.all` 屏障；`canonical-value.ts` 为 `Map`、`Set`、`Date`、`RegExp`、`ArrayBuffer` 及类型化数组提供严谨深冻结检查与规范化哈希；`UnifiedRuntimeScheduler` 统筹 `ComputeCostModel`（HEFT 关键路径排序与拒绝微秒级算子跨线程卸载的 EFT 决策）、`HostLoadGovernor`（支持 `eco` / `balanced` / `performance` 三档策略与迟滞控制，在系统供电／温度遥测不可用时优雅退化为事件循环延迟与预算控制）、`LocalWorkerThreadPool`、可递归组合的 `SchedulingDomain`、`InFlightCoalescer` 与 `ZeroPollLatch`。

## 节点实现形态与渐进式能力声明

所有计算节点在同一套端口调用语义下支持五种可互换实现形态：

1. 注册在 `ComputeRegistry` 中的命名算子（`op: string`）。
2. 独立算法模块（通过 `registry.registerModule` 注册 `ComputeOperatorModule`）。
3. 递归嵌套子图（`node.subgraph` 或复合算子 `graphAsOperator`）。
4. 内联函数或第三方黑盒适配器（`node.fn` 或 `adaptExternalAlgorithm`）。
5. 可编译结构化表达式（`node.expression`，包括可下推至 SQLite 或便携扫描的 `relational_query`）。

算子通过 `ComputeRegisterOptions` 渐进式声明能力，并由 `resolveCapabilities` 按保守原则解析：

- **副作用类别（`ComputeEffectKind`）**：支持 `"pure"`、`"read"`、`"nondeterministic"`、`"write"`、`"opaque"`。缺省优化元数据的黑盒算子严格按 `"opaque"` 处理（禁止缓存、禁止并行、禁止重排、禁止死代码消除）。
- **缓存与状态安全边界**：
  - 写入和读取有界 LRU `ComputeMemoCache`（默认上限 512 条）的可变对象经 `structuredClone` 隔离，仅深冻结值（或显式 `immutableOutput`）直接复用；不可克隆对象自动跳过缓存。
  - 闭包函数身份通过显式 `COMPUTE_CACHE_TOKEN` 或 `WeakMap` 单调函数标识区分，不再仅依赖源码文本哈希。
  - 标记 `cacheable: true` 的 `"read"` 算子须在上下文中通过 `attachStateStamp` 携带所需外部依赖状态戳（`namespace`、`revision`／`snapshotId`、`modelVersion`、时钟）；缺少状态戳时安全退回不缓存。
  - 不可缓存、`"write"`、`"nondeterministic"` 与 `"opaque"` 节点生成独立污染标记并向全部下游节点传播；`SUBGRAPH_OPERATOR_META` 动态重算 `graphAsOperator` 复合能力与签名。
  - 物理执行器在下游引用计数归零后立即释放中间输出槽位。

## 生产计算图覆盖与模块依赖

生产路径通过窄快照端口（只读快照 `MemorySnapshotPort` 位于 `src/core/memory/hydration.ts`；未提交变更草稿 `MemoryPlan` 位于 `MemoryEngine.mutate` 内）执行计算图：

| 业务入口 | 生产计算图（`ComputeGraphSpec`） | 注册表与所属模块 |
| --- | --- | --- |
| 搜索与上下文组装 | `DEFAULT_ENGINE_SEARCH_GRAPH` | `ENGINE_SEARCH_REGISTRY`（`src/core/memory/search-compute-graph.ts`）；当混合检索 `limit > 80` 时冻结 `1..80` 名，并在 `81..100` 尾段补充相邻源轮次与 `same_state` 关系邻居 |
| 精确记录与图扩展读取 | `DEFAULT_GET_CONTEXT_GRAPH` | `ENGINE_VIEW_REGISTRY`（`src/core/memory/view-compute-graphs.ts`） |
| 有界邻域浏览 | `DEFAULT_NEIGHBORHOOD_GRAPH` | `ENGINE_VIEW_REGISTRY`（`src/core/memory/view-compute-graphs.ts`） |
| 多维关系图按需投影 | `DEFAULT_PROJECT_GRAPH` | `ENGINE_VIEW_REGISTRY`（`src/core/memory/view-compute-graphs.ts`） |
| 用户画像范围投影 | `DEFAULT_USER_PROFILE_GRAPH` | `ENGINE_VIEW_REGISTRY`（`src/core/memory/view-compute-graphs.ts`） |
| 批量写入变更计划 | `DEFAULT_REMEMBER_PLAN_GRAPH` | `ENGINE_WRITE_REGISTRY`（`src/core/memory/write-compute-graphs.ts`） |
| 生命周期与关系变更计划 | `DEFAULT_LIFECYCLE_PLAN_GRAPH` | `ENGINE_WRITE_REGISTRY`（`src/core/memory/write-compute-graphs.ts`） |
| 三段式因果重排 | `DEFAULT_PIECEWISE_RERANK_GRAPH` | `RERANK_COMPUTE_REGISTRY`（`src/core/memory/piecewise-rerank.ts`）；中段（`[6..20]`）对含至少两个不同时间戳的分组应用 `w_chrono_seq_pivot` |
| HTTP 多子句融合与拼页 | `DEFAULT_HTTP_SEARCH_GRAPH` | `HTTP_SEARCH_COMPUTE_REGISTRY`（`src/integration/http-search-graph.ts`）；与引擎搜索、`retrieval-graph.ts` 和 `PortableMemoryService` 共用 `src/core/memory/page-stitch-operators.ts` 中的双通道融合、按时间排序、尾段分数封顶（`capSupplementalTailScores`）与补齐拼页原语 |
| HTTP 写入对话预处理 | `DEFAULT_HTTP_WRITE_PREPROCESS_GRAPH` | `HTTP_WRITE_PREPROCESS_REGISTRY`（`src/integration/http-write-preprocess.ts`） |
| HTTP 画像摘要投影 | `DEFAULT_HTTP_PROFILE_GRAPH` | `HTTP_PROFILE_COMPUTE_REGISTRY`（`src/integration/http-profile-view.ts`） |

- **依赖方向护栏**：`tests/core/compute-architecture-guardrails.test.ts` 自动化校验核心计算层、规划器、领域计算图与读取视图模块零导入 SQLite、LanceDB 或 `MemoryEngine`，同时存储后端模块零导入计算层。
- **保留的事务耦合边界**：`MemoryEngine` 仅保留参数前置校验、只读快照打开／关闭生命周期及基于 `MemoryBackend.commit` 的乐观并发重试／凭据重放。写入图仅在 `MemoryPlan` 上生成未提交变更，不直接提交数据库事务。

## 算子接入规范与扩展边界

新增或评估算法时遵循以下规则：

1. 先检查 `src/core/compute-contracts.ts` 中的 `MEMORY_COMPUTE_CONTRACTS`，优先匹配或复用已有契约与中间结果，不在业务入口复制链路。
2. 明确区分**工程优化**（保持语义严格等价的 CSE、DCE、SQL 谓词下推、线性 `fused_chain` 融合，按输出一致性和延迟／内存指标验收）与**算法实验**（允许改变排序与召回结果的算子／配方变更，按冻结评测集与 `findParetoOptimalGraphs` 帕累托前沿验收）。
3. 当新实现完整覆盖旧实现时同步迁移调用方并清理废弃模块，不长期保留两套等价生产流程。
4. 可编译后端保持轻量局部演化：`relational_query` 直接下推给 SQLite 查询优化器（`SqliteMemoryBackend.projectMemories`）或便携扫描，稳定的同步纯链路可通过 `enableLinearFusion` 融合交由 V8 内联执行，无需引入重型编译器基础设施。
