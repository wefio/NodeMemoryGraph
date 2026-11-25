# 统一计算运行时收敛基准测试与验证

[English](unified-runtime-convergence-2026-11-25.md) · [术语](unified-runtime-convergence-2026-11-25.terms.yaml)

## 以 PR #190 为基线的生产对照

后续实验以提交 `604a89e9` 为基线，从 Git 提取源码并生成该版本提示词，两轮反序运行。两组使用相同的固定时间、操作 ID、数据和请求批次。运行需要 Node 22.19 或更新版本，以及包含 `locomo/locomo10.json` 的数据目录。

```sh
node docs/experiments/runtime/production-runtime-benchmark.mjs --baseline-ref 604a89e9 --data-root <OmniMemEval-data> --rounds 2 --out docs/experiments/runtime/artifacts/unified-runtime-2026-11-25/production-matched.json
```

[对照脚本](production-runtime-benchmark.mjs)和[原始观测](artifacts/unified-runtime-2026-11-25/production-matched.json)保存各次延迟、版本、数据摘要、操作范围、CPU 采样和 Worker 结果。测量环境为 Windows x64、Node 26.13.0、20 个逻辑 CPU。

- **应用负载**。取 LoCoMo 首个样本的前八个会话和 32 道问题，经 HTTP 记忆服务写入 SQLite 共 174 个对话轮次。词法和离线哈希向量混合检索各测单请求及八并发，两轮四组结果的有序 ID 和分数摘要均相同。固定的引擎和 HTTP 黄金样例也一致。云端供应商延迟和吞吐不在测量范围内。
- **合成对照**。单节点图测调度开销。波次屏障和两套事件驱动实现使用同一个非对称 DAG 和计时器。前后台延迟均从提交起算。直接工作池的两档任务粒度使用同一计算并逐个校验结果。另一个 Node 进程占用主机 CPU，期间各调度器准入十二个后台操作。
- **生产及契约测试**。Daemon 经 RPC 执行外部修改后的 L1 get 图。配置驱动的重排调用进入真实 Worker，结果和内联执行一致。图测试覆盖资源冲突、嵌套、重试、异常、超时和缓存隔离。Onlion 本地折叠测试覆盖请求内 SQLite 及延迟嵌入。
- **延后优化**。Worker 常驻中间数据和全 DAG 完工优化，需要真实请求呈现足够的传输节省。本实验测量输入驻留在调用端的场景，记录 CPU、并发与任务耗时。物理功率和能耗不在测量范围内。

| 指标，两轮取值范围 | PR #190 | 收敛后 |
| --- | --- | --- |
| 同步单节点中位数，µs | 0.42–0.70 | 0.67–0.70 |
| 异步单节点中位数，µs | 1.26–1.44 | 9.82–10.72 |
| 非对称 DAG 中位数，ms | 75.9–84.7 | 76.0–88.1 |
| 混合负载前台 P50 / P95 / P99，ms | 17.8–19.9 / 22.5–29.0 / 22.7–34.3 | 14.5–15.0 / 15.2–15.5 / 15.2–15.5 |
| 混合批次全部完成，ms | 342–369 | 1,167–1,530 |
| 八并发 SQLite 混合检索，请求/秒 | 90.0–94.6 | 69.4–93.2 |
| 外部 CPU 压力前／期间／恢复后，后台实测峰值并发 | 4 / 4 / 4 | 4 / 1 / 4 |

收敛后的非对称 DAG 耗时为 76.0–88.1 ms，同轮波次屏障对照为 121.2–123.2 ms。PR #190 已实现事件就绪，两组 DAG 时间范围重叠。后台逐轮让渡改善了前台尾延迟，同时延长后台完成时间。外部进程持续压满 CPU 后，主机采样达到 100%，Worker 额度从 10 降至 0，后台每窗口 CPU 额度从 50 ms 降至 8 ms，随后经轻载逐步恢复。

应用耗时随顺序和主机负载波动。两轮八并发混合检索分别下降 1.5% 和 22.9%。默认应用负载的 Worker 派发为零，生产重排算子在强制放置契约测试中与内联输出一致。450,000 轮计算的合成任务中，四线程为 278–287 任务/秒，内联为 92–93。2,000 轮计算时，四线程为 4,311–9,762 任务/秒，内联为 21,383–23,587。较大任务的四线程排队中位数约为 37.7 ms，通信剩余时间中位数为 0.12–0.22 ms。上述 Worker 数据适用于所测合成负载。

## PR #190 探索性实验

以下为早期记录，两组的操作 ID 和后台工作量有差异。波次和 Worker 数据可用于分析特定场景，生产行为对比以配对试验为准。

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

## 后续测量（2026-11-25）

本次复核要回答：成本模型的等待维度与层级配置校验是否改变执行或派发开销。[io-wait-probe.mjs](io-wait-probe.mjs) 在同一主机、同一进程形态下分别测量两棵树：

```sh
git worktree add --detach .temp/baseline 0858eeff
node docs/experiments/runtime/io-wait-probe.mjs --root .temp/baseline --out <产物路径>
node docs/experiments/runtime/io-wait-probe.mjs --root . --out <产物路径>
```

每个实验臂运行三次。原始观测见 `artifacts/unified-runtime-2026-11-25/io-wait-{baseline,change}-{1,2,3}.json`。

| 三次运行观测 | 基线（0858eeff） | 复核后 |
| --- | --- | --- |
| 同步单节点图，单次调用 µs | 0.522–0.572 | 0.504–0.603 |
| 异步单节点图，单次调用 µs | 10.456–10.772 | 10.311–10.479 |
| 四宽异步扇出，每叶 20 ms，ms | 30.857–31.359 | 30.750–31.316 |
| 扇出叶节点的已观测 I/O 等待，ms | 0 | 29.684–30.432 |
| 关键路径秩序值，5 ms 读 / 20 ms 读 | 0.164 / 0.164 | 12.319–14.428 / 29.907–31.441 |

- 等待维度此前只声明、从未采样：所有 `waitMs` 估计恒为 `0`，两条 I/O 延迟不同的独立读分支秩序值完全相同。改动后挂起时间成为独立样本，秩序值随之区分，而同一算子的 CPU 估计仍为 `0.082 ms` 的提示值。
- 串行与调度行为未变：同步路径、异步派发下限和四宽扇出都落在基线区间内。对未声明 `execution: "async_io"` 的算子，探针没有测到额外成本。
- 层级校验由 `tests/core/unified-runtime-scheduler.test.ts` 覆盖（未知分区、未知参数、类型不符、以字符串代替数组），不通过计时证明，因为它改变的是配置是否被接受，而不是执行方式。

测量限制：该 Windows 主机没有电池与温度遥测；计时器粒度会把名义 5 ms 的等待放大到约 15.6 ms；线程 CPU 计数器精度不足以做亚毫秒归因。因此探针报告的是相对维度与派发成本。它不复述应用层检索吞吐（本次改动未触及），也不作功耗或能耗结论。
