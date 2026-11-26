# 后端优化委托与计算图降级转换

[English](2026-11-26-backend-optimization-delegation-and-lowering.md) · [术语](2026-11-26-backend-optimization-delegation-and-lowering.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [统一运行时调度、三级能力配置与业务语义收敛](2026-11-25-unified-runtime-and-semantic-convergence.zh-CN.md)

## 问题

计算图虽已承载检索、视图投影与写入规划，但执行后端仍存在多跳拆分、逻辑耦合与重复开销：

1. **关系计算被拆散为多轮 JavaScript 拼装**：`projectGraph`、`userProfile`、词法 `search`、带画像证据的 `get` 与 HTTP 画像候选加载仍通过多次 SQLite 查询、全表扫描与 JS 过滤／边加载往返物化中间对象。
2. **后端能力缺少声明式隔离机制**：若直接在公共规划器硬编码特定存储规则，容易破坏核心层与 SQLite／LanceDB 的依赖隔离，或导致便携回退路径与下推路径行为漂移。
3. **同步纯计算链的重复查找与时间戳解析开销**：`DEFAULT_PIECEWISE_RERANK_GRAPH` 与 `DEFAULT_HTTP_SEARCH_GRAPH` 在串联算子间重复构造 ID 映射、解析 ISO 时间戳并经过通用解释器调度分配。

## 决策

参考 Apache Calcite 的适配器能力声明与区域降级思想，在不引入重型外部优化器且不另建平行规划器的前提下完成后端优化委托：

1. **声明式后端注册表与凸区域降级（`src/core/compute-lowering.ts`）**：建立 `ComputeBackendRegistry`，内建 `SQLITE_BACKEND_ADAPTER`（`relational-v2`）、`PORTABLE_BACKEND_ADAPTER`（`portable-v1`）与 `JS_V8_BACKEND_ADAPTER`（`v8-slot-v1`）并支持第三方数值／宿主后端扩展；每个适配器声明 `supportedExprKinds`、`supportedOperations`、`boundaryConversionCostMs` 与确定性匹配规则。`isLegalConvexRegion` 在折叠节点前校验单出口支配、无外部重入环及副作用／锁边界安全，`shouldApplyLowering` 依据 `optimization.costRatioThreshold` 裁决是否委托。适配器版本签名与下推目标参与 `PLAN_CACHE` 与 `ComputeMemoCache` 键计算。
2. **SQLite 整块关系下推与跨后端严格等价（`src/core/memory/sqlite-relational.ts`、`src/core/memory/view-compute-graphs.ts`、`src/core/memory/search-compute-graph.ts`、`src/core/memory/engine.ts`）**：
   - 新增 `projectRelationalMemoriesWithTopology` 将过滤排序投影（`sort_time DESC, id ASC`）、节点水合与窗口化显式边加载（`ROW_NUMBER()`）下推为单次快照查询，并同步对齐便携回退路径 `selectProjectionMemories` 的全页过滤排序语义。
   - 新增 `readRelationalUserProfile`、`readRelationalProfileEvidenceLinks`、`readRelationalLexicalSearchPage`、`readRelationalOrderedGetPage` 与单查询 `readProfileCandidates`，确保与 `portable_scan` 及 `LanceMemoryBackend` 输出完全一致。
   - 引入 `canonicalUtcInstant` 与 `utcTimestampColumnSql` 消除 `+08:00` 等带偏移时间戳在 SQL 文本比较与 JS 解析之间的语义偏差。
3. **JS/V8 同步槽位核与共享索引缓存（`src/core/compute-lowering.ts`、`src/core/memory/rerank-types.ts`）**：`compileSyncPlanKernel` 将无锁纯同步 DAG 编译为固定槽位闭包（`slots[]`）并在末次消费后清空引用，`compileFusedChainSyncRunner` 预绑定 `fused_chain` 算子与参数，`RerankCandidateIndex` 通过 `WeakMap` 在单批候选中复用时间戳与轮次索引。
4. **三级配置中的 `optimization` 物理策略（`src/core/capability-config.ts`、`src/integration/runtime-config.ts`）**：将 `optimization.backend`、`optimization.enableRegionLowering`、`optimization.enableLinearFusion`、`optimization.enableSyncKernel`、`optimization.costRatioThreshold` 与 `NMG_OPTIMIZATION_BACKEND` 纳入 `L0 -> L1 -> L2` 配置体系，并排除出 `resultIdentityHash`。

## 考虑过的替代方案

1. **使用 `new Function` 动态拼接代码生成同步执行核**：拒绝，边缘 Worker 环境受 CSP 与运行时安全策略限制，且实测固定槽位预绑定闭包即可获得低编译延迟与更稳定的单态调用路径。
2. **引入 Apache Calcite JVM、DuckDB 或 LLVM/MLIR 等重型外部工具链**：拒绝，NMG 部署在单进程 Node 与 WASM Worker 边界，基于既有 SQLite 查询优化器与 V8 JIT 的轻量规则即可消除主要跨边界传输而无外部依赖膨胀。
3. **按后端分叉维护独立的逻辑计算图**：拒绝，逻辑计算图保持单一语义真源，通过声明式降级与便携回退共享同一套契约。

## 后果

- 在 `N = 2500` 语料下，`projectGraph` 下推中位耗时 `4.223 ms`（`scannedEntities: 0`），相较便携扫描 `49.932 ms`（`scannedEntities: 2640`）显著下降且规范化 SHA-256 摘要完全一致（[实验报告](../../experiments/runtime/backend-optimization-delegation-2026-11-26.zh-CN.md)）。
- 对于极高选择性的小规模查询（如 `userProfile` 或 5 条 ID 的 `get`），便携扫描耗时本身较低（`N = 2500` 时 `userProfile` SQLite `4.002 ms` vs 便携 `1.979 ms`），验证了保留成本门控与按工作负载特征裁决的必要性。
- `onlion` 打包与 WASM SQLite 后端测试（`test:backend`、`test:add-log`、`test:edgeone-package`、`test:append-log`、`test:page-delta`）全部通过。
