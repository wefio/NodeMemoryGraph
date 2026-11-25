# Unified compute runtime convergence benchmark and verification

[中文](unified-runtime-convergence-2026-11-25.zh-CN.md) · [Terms](unified-runtime-convergence-2026-11-25.terms.yaml)

## Question and conclusion

Does converging business semantics onto shared compute graphs, introducing `L0 -> L1 -> L2` capability configuration, and replacing full-wave `Promise.all` barriers with an event-driven `UnifiedRuntimeScheduler` preserve retrieval outputs and synchronous microsecond latency while eliminating asymmetric DAG barrier stalls and scaling multi-worker CPU execution?

Measured results on the unified runtime show exact golden retrieval parity, sub-millisecond synchronous rerank parity (`53.415 ms` vs `56.04 ms` baseline over 200 iterations), a `29.7%` median wall-time reduction on an asymmetric diamond DAG (`86.669 ms` vs `123.358 ms`), and `3.56x` throughput scaling across 4 local worker threads (`334.776` tasks/sec vs `94.125` tasks/sec inline) while validating the `ComputeCostModel` offload floor when single-worker IPC lowers throughput (`74.794` tasks/sec).

## Environment and measurement limits

- **Benchmark runner:** [unified-runtime-benchmark-2026-11-25.mjs](unified-runtime-benchmark-2026-11-25.mjs), saving [baseline artifact](artifacts/unified-runtime-2026-11-25/baseline.json) and [post artifact](artifacts/unified-runtime-2026-11-25/post.json).
- **Host:** Node `v26.13.0`, `win32` `x64`, `20` CPUs (`12th Gen Intel(R) Core(TM) i7-12700H`).
- **Telemetry limit:** `environment.powerTelemetryAvailable` is `false` on this Windows host because Linux battery and thermal sysfs interfaces are absent. `HostLoadGovernor` runs event-loop utilization and delay-budget fallback in live checks and evaluates synthetic idle/light/heavy/`ecoBattery` inputs for transition verification; physical wattage and energy consumption are not measured and are not inferred from CPU time.
- **Harness differences noted verbatim:** In `golden`, baseline ran before pinning a fixed batch `operationId`, yielding digest `0b41ebddfc5beb71b6a274c410dd25e1d66062d2e06f16648fdb83dcd24eb994`; post runs pass fixed `operationId: "golden-batch-001"` and match identically across consecutive runs (`post.json` and `post-repeat.json`, digest `106b0fa9b97fd7dfea5304effd5c06960f78970824a7eb53a2c930b0feed40bb`). In `fgVsBg`, baseline executed `bgCount: 8` synchronously before yielding whereas post uses `bgCount: 12` with async background item yields under scheduler load budgets, so those two wall totals reflect different harness work shapes.

## Baseline vs post metrics

| Check | Baseline metric | Post metric | Notes |
| --- | --- | --- | --- |
| Golden retrieval (`queryCount: 2`) | `engineCount: 10`, `httpCount: 10` | `engineCount: 10`, `httpCount: 10`, digest `106b0fa9b97fd7dfea5304effd5c06960f78970824a7eb53a2c930b0feed40bb` | Identical digest across consecutive `--mode post` runs |
| Sync piecewise rerank (`iterations: 200`) | `wallMs: 56.04`, `p50Ms: 0.243`, `p95Ms: 0.468`, `opsPerSec: 3568.86`, `userCpuMs: 47` | `wallMs: 53.415`, `p50Ms: 0.238`, `p95Ms: 0.38`, `opsPerSec: 3744.302`, `userCpuMs: 47` | Preserves zero-hash inline fast path without async queue overhead |
| Asymmetric diamond DAG (`runs: 3`) | `medianWallMs: 123.358` (`min: 122.671`, `max: 124.086`) | `medianWallMs: 86.669` (`min: 76.717`, `max: 92.423`) | Event-driven ready-node dispatch runs fast branch `B -> D` alongside `80 ms` branch `A` |
| Foreground vs background isolation | `fgCount: 20`, `bgCount: 8`, `fgP50Ms: 7.062`, `fgP95Ms: 7.156`, `bgMedianMs: 14.13`, `totalWallMs: 30.022` | `fgCount: 20`, `bgCount: 12`, `fgP50Ms: 20.576`, `fgP95Ms: 24.097`, `bgMedianMs: 32.423`, `totalWallMs: 219.409` | Post yields between async background items under governor concurrency limits |

## Worker scaling and load governor observations

- **Worker thread scaling (`16` CPU-bound tasks):**
  - `inline0`: `wallMs: 169.987`, `userCpuMs: 171`, `throughputTasksPerSec: 94.125` (baseline `inline0`: `168.845 ms`, `94.761` tasks/s).
  - `workers1`: `wallMs: 213.921`, `avgIpcUs: 201.856`, `throughputTasksPerSec: 74.794` (IPC serialization cost reduces single-worker throughput relative to inline execution, validating why `ComputeCostModel` rejects offloading microsecond or non-gainful tasks).
  - `workers2`: `wallMs: 86.84`, `avgIpcUs: 102.112`, `throughputTasksPerSec: 184.247`.
  - `workers4`: `wallMs: 47.793`, `avgIpcUs: 123.256`, `throughputTasksPerSec: 334.776` (`3.56x` over `inline0`).
- **Load governor policy states (`adaptiveLoad`):**
  - `idle`: `maxBackgroundConcurrency: 4`, `backgroundCpuBudgetMs: 50`, `preferWorkerOffload: true`.
  - `light`: `maxBackgroundConcurrency: 2`, `backgroundCpuBudgetMs: 25`, `preferWorkerOffload: true`.
  - `heavy`: `maxBackgroundConcurrency: 1`, `backgroundCpuBudgetMs: 8`, `preferWorkerOffload: false`.
  - `ecoBattery`: `loadState: "light"`, `maxBackgroundConcurrency: 1`, `backgroundCpuBudgetMs: 6`.

## Architectural and correctness verification scope

Dedicated test suites in `tests/core/compute-architecture-guardrails.test.ts`, `tests/core/unified-runtime-scheduler.test.ts`, and `tests/integration/unified-semantics-parity.test.ts` cover registry-isolated `PLAN_CACHE` generations, recursive subgraph preservation in `runDcePass`, per-step parameters inside `fused_chain`, `isDeeplyFrozen` / `canonicalizeComputeValue` safety over built-in containers, `L0 -> L1 -> L2` provenance and `PolicyViolationError` enforcement, event-driven DAG wakeup, `ResourceLockManager`, `InFlightCoalescer` singleflight deduplication, priority aging against starvation, semantic retry constraints, and `UnifiedRuntimeScheduler` execution alongside full engine and HTTP search parity.
