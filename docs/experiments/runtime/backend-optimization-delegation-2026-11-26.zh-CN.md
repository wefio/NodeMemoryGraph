# 后端优化委托与计算图降级转换基准评测

[English](backend-optimization-delegation-2026-11-26.md) · [术语](backend-optimization-delegation-2026-11-26.terms.yaml)

## 实验目的与测量环境

对比 NMG SQLite 整块下推路径（`lowered`）与便携快照回退路径（`portable`）在不同语料规模下的输出等价性、图编译延迟、SQL `prepare`／实体扫描次数及墙钟 p50／p95 延迟，并实测 JS/V8 槽位核在分段重排与 HTTP 搜索融合图上的端到端加速。

```sh
node docs/experiments/runtime/backend-lowering-benchmark-2026-11-26.mjs --out docs/experiments/runtime/artifacts/backend-lowering-2026-11-26/report.json
```

- **基准脚本**：[backend-lowering-benchmark-2026-11-26.mjs](backend-lowering-benchmark-2026-11-26.mjs)，保存[原始测量 JSON](artifacts/backend-lowering-2026-11-26/report.json)（`measuredAt: "2026-11-26T12:56:03.122Z"`）。
- **测试主机**：Node `v26.13.0`、`win32` `x64`、`20` 逻辑 CPU（`12th Gen Intel(R) Core(TM) i7-12700H`）。
- **遥测边界**：`environment.powerTelemetryAvailable` 为 `false`，本次未采集物理功耗／能耗，也不以 CPU 时间代替能耗结论。

## 编译开销与 JS/V8 同步核结果

- **图编译开销（`compile`）**：冷编译 `DEFAULT_PROJECT_GRAPH` 中位数 `148.5 µs`；热缓存命中 `PLAN_CACHE` 均值 `22.039 µs`（`5000` 次查找）。
- **分段重排 DAG（`80` 候选、`250` 轮）**：
  - 解释器基线（`enableSyncKernel: false`、`enableLinearFusion: false`）：`wallMs: 116.442`、`p50Ms: 0.444`、`p95Ms: 0.696`、`opsPerSec: 2147.001`、`cpuMs: 141`、`heapDeltaMb: 4.488`。
  - 预绑定 `syncKernel` + `RerankCandidateIndex`：`wallMs: 109.263`、`p50Ms: 0.421`、`p95Ms: 0.65`、`opsPerSec: 2288.064`、`cpuMs: 188`、`heapDeltaMb: 1.809`（`speedupRatio: 1.066`）。
- **HTTP 菱形融合图（`16` 条子句结果、`3000` 轮）**：
  - 解释器基线：`wallMs: 64.272`、`opsPerSec: 46676.842`。
  - 预绑定 `syncKernel`：`wallMs: 60.927`、`opsPerSec: 49239.334`（`speedupRatio: 1.055`）。
- **不透明算子保底回退（`5000` 轮）**：`74.208 ms`，未下推节点按原安全路径执行。

## 多规模 SQLite 下推与便携扫描对照（`N = 50..2500`）

全部四组语料规模均通过规范化 SHA-256 严格输出一致性校验（`parityVerified: true`，涵盖 `projectGraph`、`userProfile`、`lexicalSearch`、`getWithProfileLinks`）及 HTTP 单子句查询校验（`httpReturned: 10`）。

| 规模 `N`（轮次） | 操作 | 下推 p50 / p95 (ms) | 便携 p50 / p95 (ms) | 下推 prepare / 扫描 | 便携 prepare / 扫描 |
| --- | --- | --- | --- | --- | --- |
| `50`（`25`） | `projectGraph` | `2.28` / `3.249` | `3.08` / `3.745` | `7` / `0` | `8` / `58` |
| `50`（`25`） | `lexicalSearch` | `1.859` / `2.373` | `2.137` / `3.65` | `9` / `0` | `9` / `65` |
| `50`（`25`） | `userProfile` | `1.486` / `2.063` | `1.029` / `1.625` | `10` / `0` | `7` / `8` |
| `50`（`25`） | `getWithProfileLinks` | `1.785` / `1.975` | `1.334` / `2.094` | `10` / `0` | `10` / `15` |
| `250`（`25`） | `projectGraph` | `4.105` / `5.337` | `7.385` / `8.576` | `7` / `0` | `8` / `266` |
| `250`（`25`） | `lexicalSearch` | `2.971` / `3.334` | `5.752` / `6.677` | `9` / `0` | `9` / `263` |
| `250`（`25`） | `userProfile` | `1.643` / `2.315` | `1.121` / `1.351` | `10` / `0` | `7` / `27` |
| `250`（`25`） | `getWithProfileLinks` | `1.914` / `2.166` | `1.959` / `2.34` | `10` / `0` | `10` / `15` |
| `1000`（`15`） | `projectGraph` | `4.665` / `6.006` | `23.676` / `30.389` | `7` / `0` | `14` / `1066` |
| `1000`（`15`） | `lexicalSearch` | `5.965` / `8.76` | `14.114` / `16.08` | `9` / `0` | `9` / `588` |
| `1000`（`15`） | `userProfile` | `2.736` / `3.273` | `1.99` / `4.117` | `10` / `0` | `7` / `69` |
| `1000`（`15`） | `getWithProfileLinks` | `2.245` / `2.82` | `1.849` / `2.354` | `10` / `0` | `10` / `15` |
| `2500`（`15`） | `projectGraph` | `4.223` / `4.84` | `49.932` / `59.785` | `7` / `0` | `28` / `2640` |
| `2500`（`15`） | `lexicalSearch` | `10.777` / `14.744` | `18.074` / `24.7` | `9` / `0` | `9` / `688` |
| `2500`（`15`） | `userProfile` | `4.002` / `5.529` | `1.979` / `2.436` | `10` / `0` | `7` / `145` |
| `2500`（`15`） | `getWithProfileLinks` | `1.658` / `2.426` | `1.559` / `1.939` | `10` / `0` | `10` / `15` |

## 实测分析与兼容性验证

- **图投影与词法检索下推随规模显著收敛开销**：在 `N = 2500` 时，`projectGraph` 下推吞吐达 `246.994` ops/s（`wallMs: 60.73`、`heapDeltaMb: -0.822`），便携扫描为 `19.834` ops/s（`wallMs: 756.265`、`heapDeltaMb: 19.583`），SQL `prepare` 从 `28` 次降至 `7` 次、实体扫描从 `2640` 行降至 `0`；`lexicalSearch` 中位耗时从 `18.074 ms`（`54.614` ops/s、`scannedEntities: 688`）降至 `10.777 ms`（`89.027` ops/s、`scannedEntities: 0`）。
- **高选择性小查询显示下推盈亏边界**：当画像仅占总语料 `5%`（`N = 2500` 下便携仅扫 `145` 个实体），`userProfile` 便携扫描中位耗时 `1.979 ms`（`prepareCount: 7`）低于关联 SQL 下推 `4.002 ms`（`prepareCount: 10`）；`5` 条 ID 的 `getWithProfileLinks` 两者接近持平（`1.658 ms` 对 `1.559 ms`），印证成本比门控与选择性估算的价值。
- **契约与 WASM SQLite 覆盖**：`tests/core/backend-lowering-delegation.test.ts` 验证声明式能力、凸区域合法性、适配器版本缓存隔离、`optimization` 配置独立于 `resultIdentityHash`、`+08:00` 时区等价、事务快照隔离以及 SQLite 下推／便携回退／`LanceMemoryBackend` 三方一致；`onlion` WASM SQLite 构建及测试（`test:backend`、`test:add-log`、`test:edgeone-package`、`test:append-log`、`test:page-delta`）全部通过。
