# 统一计算运行时收敛基准测试与验证

[English](unified-runtime-convergence-2026-11-25.md) · [术语](unified-runtime-convergence-2026-11-25.terms.yaml)

## 问题与结论

将业务语义收敛至共享计算图、引入 `L0 -> L1 -> L2` 三级能力配置，并将全波次 `Promise.all` 屏障替换为事件驱动 `UnifiedRuntimeScheduler` 后，是否既能保持检索结果一致性与微秒级同步重排零退化，又能在非对称 DAG 消除波次等待卡顿并扩展多线程 CPU 吞吐？

实测结果显示：黄金检索结果在引擎与 HTTP 间保持确定性一致；200 次同步分段重排延迟与基线持平略降（`53.415 ms` 对 `56.04 ms`）；非对称菱形 DAG 中位耗时从 `123.358 ms` 降至 `86.669 ms`（减少 `29.7%`）；4 线程工作池实现 `334.776` tasks/sec 吞吐（相较内联 `94.125` tasks/sec 提升 `3.56x`），同时单线程卸载（`74.794` tasks/sec）的 IPC 损耗印证了 `ComputeCostModel` 拒绝微秒级算子跨线程迁移的必要边界。

## 运行环境与测量边界

- **基准脚本**：[unified-runtime-benchmark-2026-11-25.mjs](unified-runtime-benchmark-2026-11-25.mjs)，保留 [baseline 产物](artifacts/unified-runtime-2026-11-25/baseline.json) 与 [post 产物](artifacts/unified-runtime-2026-11-25/post.json)。
- **测试主机**：Node `v26.13.0`、`win32` `x64`、`20` 核（`12th Gen Intel(R) Core(TM) i7-12700H`）。
- **遥测约束**：Windows 主机缺少 Linux sysfs 供电与温度节点，因此 `environment.powerTelemetryAvailable` 为 `false`。`HostLoadGovernor` 在真实路径使用事件循环利用率与延迟预算兜底，并通过合成遥测样例校验 `idle`/`light`/`heavy`/`ecoBattery` 档位切换；本文不测量物理功耗或温度，也不由 CPU 时间反推能耗。
- **脚本差异说明**：`golden` 基线阶段未固定写入批次 `operationId`（生成摘要 `0b41ebddfc5beb71b6a274c410dd25e1d66062d2e06f16648fdb83dcd24eb994`），优化后固定 `operationId: "golden-batch-001"` 且连续两次运行 `post.json` 与 `post-repeat.json` 产生完全一致摘要 `106b0fa9b97fd7dfea5304effd5c06960f78970824a7eb53a2c930b0feed40bb`。`fgVsBg` 基线执行 `bgCount: 8` 且首轮同步排空，优化后采用 `bgCount: 12` 并在背景任务间让出异步调度权，两者对应不同压力形态。

## 基线与优化后核心指标

| 测试项 | 基线指标 | 优化后指标 | 说明 |
| --- | --- | --- | --- |
| 黄金检索等价性（`queryCount: 2`） | `engineCount: 10`、`httpCount: 10` | `engineCount: 10`、`httpCount: 10`，摘要 `106b0fa9b97fd7dfea5304effd5c06960f78970824a7eb53a2c930b0feed40bb` | 连续两次 `--mode post` 摘要完全相同 |
| 同步三段式重排（`iterations: 200`） | `wallMs: 56.04`、`p50Ms: 0.243`、`p95Ms: 0.468`、`opsPerSec: 3568.86`、`userCpuMs: 47` | `wallMs: 53.415`、`p50Ms: 0.238`、`p95Ms: 0.38`、`opsPerSec: 3744.302`、`userCpuMs: 47` | 保留无异步队列开销的零哈希同步快路径 |
| 非对称菱形 DAG（`runs: 3`） | `medianWallMs: 123.358`（`min: 122.671`、`max: 124.086`） | `medianWallMs: 86.669`（`min: 76.717`、`max: 92.423`） | 事件驱动就绪唤醒使快分支 `B -> D` 无需等待 `80 ms` 慢分支 `A` |
| 前后台负载隔离 | `fgCount: 20`、`bgCount: 8`、`fgP50Ms: 7.062`、`fgP95Ms: 7.156`、`bgMedianMs: 14.13`、`totalWallMs: 30.022` | `fgCount: 20`、`bgCount: 12`、`fgP50Ms: 20.576`、`fgP95Ms: 24.097`、`bgMedianMs: 32.423`、`totalWallMs: 219.409` | 优化后后台任务受负载控制器并发上限与异步让渡约束 |

## 工作线程扩展性与负载调控观测

- **工作线程池扩展性（`16` 个 CPU 密集任务）**：
  - `inline0`：`wallMs: 169.987`、`userCpuMs: 171`、`throughputTasksPerSec: 94.125`（基线 `inline0` 为 `168.845 ms`、`94.761` tasks/s）。
  - `workers1`：`wallMs: 213.921`、`avgIpcUs: 201.856`、`throughputTasksPerSec: 74.794`（单工作线程下跨线程 IPC 序列化开销导致吞吐低于主线程内联，验证 `ComputeCostModel` 阻止微秒级／无净收益任务迁移的合理性）。
  - `workers2`：`wallMs: 86.84`、`avgIpcUs: 102.112`、`throughputTasksPerSec: 184.247`。
  - `workers4`：`wallMs: 47.793`、`avgIpcUs: 123.256`、`throughputTasksPerSec: 334.776`（相对 `inline0` 达到 `3.56x` 吞吐）。
- **负载控制器策略档位（`adaptiveLoad`）**：
  - `idle`：`maxBackgroundConcurrency: 4`、`backgroundCpuBudgetMs: 50`、`preferWorkerOffload: true`。
  - `light`：`maxBackgroundConcurrency: 2`、`backgroundCpuBudgetMs: 25`、`preferWorkerOffload: true`。
  - `heavy`：`maxBackgroundConcurrency: 1`、`backgroundCpuBudgetMs: 8`、`preferWorkerOffload: false`。
  - `ecoBattery`：`loadState: "light"`、`maxBackgroundConcurrency: 1`、`backgroundCpuBudgetMs: 6`。

## 架构护栏与正确性验证覆盖

`tests/core/compute-architecture-guardrails.test.ts`、`tests/core/unified-runtime-scheduler.test.ts` 与 `tests/integration/unified-semantics-parity.test.ts` 覆盖：按 `ComputeRegistry` 实例隔离的 `PLAN_CACHE`、递归子图 `runDcePass` 副作用保留、`fused_chain` 逐步参数哈希、`Map`/`Set`/`Date`/`RegExp`/`ArrayBuffer` 深冻结与规范化哈希、`L0 -> L1 -> L2` 溯源与 `PolicyViolationError` 护栏、事件驱动 DAG 唤醒、`ResourceLockManager`、`InFlightCoalescer` 去重、防止后台饿死的优先级老化、语义可控重试以及引擎／HTTP 搜索结果等价性。
