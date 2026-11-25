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
4. **事件驱动统一运行时调度（`src/core/resource-locks.ts`、`src/core/runtime/*`）**：`runAsyncPlan` 改为共享 `ResourceLockManager` 的就绪节点事件唤醒；提供 `ZeroPollLatch`、`InFlightCoalescer` 单飞去重、`ComputeCostModel`（HEFT 关键路径与拒绝微秒级算子卸载的 EFT 阈值）、`HostLoadGovernor`（`eco`／`balanced`／`performance` 与迟滞控制及系统遥测降级）、`LocalWorkerThreadPool`、可递归组合的 `SchedulingDomain` 与防饿死优先级老化，并接入 `NmgService.drain` 与后台嵌入回填。

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
