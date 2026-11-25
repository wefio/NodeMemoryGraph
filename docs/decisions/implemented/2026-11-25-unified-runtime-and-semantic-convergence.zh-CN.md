# 统一运行时调度、三级能力配置与业务语义收敛

[English](2026-11-25-unified-runtime-and-semantic-convergence.md) · [术语](2026-11-25-unified-runtime-and-semantic-convergence.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [统一记忆计算引擎](2026-11-24-unified-memory-compute-engine.zh-CN.md)

## 问题

虽然核心检索与写入路径已接入计算图引擎，但在架构与运行时边界仍存在四类分散实现与隐患：

1. **规划器与缓存正确性缺陷**：`PLAN_CACHE` 仅按 `generation` 编码而在不同 `ComputeRegistry` 实例间发生碰撞；`runDcePass` 直接跳过未消费的嵌套 `node.subgraph` 导致含副作用子图被消除；`fused_chain` 未将每步参数纳入签名且融合后边目标重写存在悬挂引用；`isDeeplyFrozen` 与规范化哈希将已冻结的 `Map`、`Set`、`Date`、`RegExp`、`ArrayBuffer` 及类型化数组误判为浅不可变空对象 `{}`。
2. **业务语义与适配器重复**：尾段分数封顶（`capSupplementalTailScores`）、按时间排序、双通道融合、HTTP 单子句／画像捷径以及宿主工作区／召回／黑板协调默认解析分散在 `retrieval-graph.ts`、`http-search-graph.ts`、`search-compute-graph.ts`、`portable-memory.ts`、`local-memory-http.ts`、`workbuddy-plugin/nmg-hook.ts` 与 DSH 插件中。
3. **缺少契约约束与分级继承配置**：阈值、子图选择与后端开关散落为私有常量或局部解析，缺少参数来源溯源、`configIdentity` 缓存隔离以及阻断未授权算法变体替换的策略护栏。
4. **波次屏障与轮询耦合**：`runAsyncPlan` 依赖全波次 `Promise.all` 屏障阻碍就绪节点提前唤醒；后台回填循环（`LocalMemoryEmbeddings.sweep`、`HttpMemoryService.backfillVectors`）独立于前后台预算；`NmgService.drain` 通过定时轮询等待完成。

## 决策

在既有递归计算图抽象之上推进公共语义收敛、三级能力配置继承与事件驱动统一运行时：

1. **规划与缓存正确性修复（`src/core/canonical-value.ts`、`src/core/compute-planner.ts`、`src/core/compute-graph.ts`）**：`PLAN_CACHE` 按 `WeakMap` 跟踪的 `ComputeRegistry` 实例令牌与 `configIdentity` 隔离；`runDcePass` 递归检查嵌套子图中的不可消除节点；`fused_chain` 纳入逐步参数签名并同步重写边关系；`canonical-value.ts` 严谨拒绝内建有状态容器和访问器的浅冻结快路径，并对其结构化哈希。
2. **唯一公共语义库（`src/core/memory/page-stitch-operators.ts` 与各适配器）**：沉淀 `fuseDualChannelCandidates`、`capSupplementalTailScores`、`sortResultsChronologically` 与 `stitchSupplementalPage`，迁移 `MemoryEngine`、`PortableMemoryService`、`HttpMemoryService`、`local-memory-http.ts`、`workbuddy-plugin/nmg-hook.ts` 与 DSH 适配器复用统一实现。
3. **`L0 -> L1 -> L2` 三级声明式配置（`src/core/capability-config.ts`、`src/integration/runtime-config.ts`）**：定义带边界校验的公共参数契约与默认子图（`L0`）、可热加载共享配置（`L1`，`NMG_CONFIG_PATH` 或 `<dataDir>/nmg.config.json`）及最小适配器覆盖（`L2`），保留来源溯源与缓存身份哈希，并以 `PolicyViolationError` 拦截未获准的语义变更算法替换。
4. **事件驱动统一运行时**。生产和实验异步图都进入 `UnifiedRuntimeScheduler`。规划器输出数据与副作用依赖，调度器协调跨图资源、等待已启动的失败分支收尾、合并符合缓存契约的在途计算，以及按成本模型指派 Worker 叶节点。同步执行保留低开销内联循环。[计算引擎契约](../../design/unified-architecture/compute-engine.zh-CN.md)
5. **宿主绑定与向量补齐**。Node HTTP、daemon、portable 引擎在各自的数据目录边界绑定同一份 L1 能力目录。两个回填入口共用单批嵌入校验与写入，daemon 保留游标管理，HTTP 保留有界批次和延迟嵌入重试契约。Onlion 为快照使用请求内调度器。[运行策略](../../design/unified-architecture/compute-engine.zh-CN.md#运行策略与资源所有权)

## 考虑过的替代方案

1. **另建独立业务编排框架或仅把旧函数包一层黑盒节点**：拒绝，因为现有递归 `ComputeGraphSpec` 与规划器在消除节点内部重复后即可统一承担业务编排。
2. **为单机调度直接引入分布式集群框架或重型原生 C++ 扩展**：拒绝，Node `worker_threads`、EFT 迁移成本评估与事件驱动 DAG 调度即可满足单机多请求并发与资源治理，无额外编译与许可证包袱。

## 后果

- 规划器实例隔离、递归子图 DCE、`fused_chain` 失效以及内建容器缓存安全均获 `tests/core/compute-architecture-guardrails.test.ts` 保护。
- 全仓业务入口与宿主适配器共用统一配置溯源与 `PolicyViolationError` 边界（`tests/integration/unified-semantics-parity.test.ts`）。
- 微秒级纯同步图保持零哈希内联快路径，非对称异步 DAG 实现无屏障就绪推进，多核工作池按成本与主机负载预算伸缩（`tests/core/unified-runtime-scheduler.test.ts` 与[收敛基准实验报告](../../experiments/runtime/unified-runtime-convergence-2026-11-25.zh-CN.md)）。

## 延后项

- 跨主机分布式任务队列、远程工作窃取与分布式故障恢复（当前 `SchedulingDomain` 保持单机作用域）。
- 直接调用 Windows EcoQoS Win32 原生 FFI 或 Linux cgroup 写控（当前按事件循环利用率、工作池并发度与时间片预算控制，待后续真实桌面／服务端争用样本确立收益再接入）。
- Worker 常驻中间数据、通用抢占和全 DAG 完工时间优化。目前按就绪工作与输入、IPC 成本做放置，分别测量事件就绪、线程扩展和应用检索的表现。[实验记录](../../experiments/runtime/unified-runtime-convergence-2026-11-25.zh-CN.md)

## 后续复核（2026-11-25）

沿全部生产入口、适配器、后台任务与实验入口重新追踪后，统一运行时、能力绑定和公共语义库已按本决策承担职责。本次补齐四处残留缺口，另有三种候选机制经评审后不采用。

1. **I/O 等待成为真实成本维度。** `ComputeCostModel` 中的 `emaWaitMs` 从未被采样，`estimate().waitMs` 恒为零，关键路径排序把 I/O 型算子当作只有同步 CPU 前缀。现在 `runInline` 对声明 `execution: "async_io"` 的算子（以及挂起的 CPU 放置节点）通过 `observeWait` 记录挂起墙钟时间，`estimate` 计入该项，HEFT 秩序包含它，诊断以 `ioWaitMs` 与 `inlineCpuMs` 分列。CPU 与等待互为独立样本，I/O 型算子不再覆盖自身的 CPU 估计。
2. **无法控制任何机制的配置直接失败。** 此前只校验 `runtime` 分区，`autoRecall`、`maintenance`、`stgSync`、`stgConsolidation` 的拼写错误会静默回落到 L0 默认值并看似生效；`allowedAlgorithmicVariants: "piecewise-bm25f"` 还会被逐字符展开。现在校验每个已声明分区、层级键和层级类型。
3. **删除无消费者的运行期声明。** 放置逻辑从不读取 `RuntimeWorker.dataLocality`（调用端输入字节与实测 IPC 已承担传输定价）；`applyBackgroundOsPriority` 被导出但从未调用，Node 只提供进程级优先级，调用会连带降低前台工作，平台改为通过事件循环让渡复用操作系统调度。
4. **把隐式边界写明并纳入测试。** 在途合并使用与 memo 作用域相同的节点签名与配置身份。不同 `openRead` 快照身份不同，生产请求因此不会合并；合并器保留在共享 memo 作用域（图实验，或主动共享快照的调用方）内，而不是强加给身份不兼容的调用。配置契约与等待维度各有回归测试。

经评审不采用：

- **以 `reorderable` 作为 `buildDependencies` 的排序权威。** 隐式串行链保护顺序敏感的工作；`parallelSafe` 已表达算子能否并发，生产读取算子声明 `parallelSafe: false` 并配有显式数据边。改以 `reorderable` 驱动会改变所有只声明其中一个标志的算子的读取调度，且无实测收益。
- **常驻或逐请求 memo 化。** 常驻缓存需要每个读取算子具备持久状态戳，逐请求缓存不可能命中，当前工作负载都无法证明收益。
- **批处理、事务调度与端口／适用性自省。** 这些声明的算子字段当前没有消费者，保留为算子作者可见的声明，但不描述为已生效行为。

本次改动自身的对照数据见[收敛实验](../../experiments/runtime/unified-runtime-convergence-2026-11-25.zh-CN.md#后续测量2026-11-25)：同步与异步单次调用开销、四宽 DAG 延迟均落在基线区间内，已观测 I/O 等待从 `0` 变为实测值。
