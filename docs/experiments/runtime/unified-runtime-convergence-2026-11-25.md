# Unified compute runtime convergence benchmark and verification

[中文](unified-runtime-convergence-2026-11-25.zh-CN.md) · [Terms](unified-runtime-convergence-2026-11-25.terms.yaml)

## Matched production comparison against PR #190

The follow-up compares commit `604a89e9` with the consolidated runtime. The runner extracts the baseline source from Git, regenerates its prompts, and measures in both orders. Both arms use fixed clocks, operation IDs, data and request batches. Run with Node 22.19 or newer and a directory containing `locomo/locomo10.json`.

```sh
node docs/experiments/runtime/production-runtime-benchmark.mjs --baseline-ref 604a89e9 --data-root <OmniMemEval-data> --rounds 2 --out docs/experiments/runtime/artifacts/unified-runtime-2026-11-25/production-matched.json
```

The [matched runner](production-runtime-benchmark.mjs) and [raw observations](artifacts/unified-runtime-2026-11-25/production-matched.json) retain each latency, source revision, dataset digest, operation scope, CPU samples and Worker results. The host was Windows x64 with Node 26.13.0 and 20 logical CPUs.

- **Application workload.** The first eight sessions and 32 questions of the first LoCoMo sample use the HTTP memory service and real SQLite, with 174 stored turns. The two retrieval modes use lexical search and offline hashing vectors. The exact ordered ID and score digests agree in all four mode/concurrency combinations in both rounds. The fixed golden engine/HTTP fixture agrees as well. Hosted provider latency and throughput remain outside the measurements.
- **Synthetic controls.** The single-node graph measures runtime overhead. A matched wave barrier uses the same asymmetric DAG and timers as both event-driven arms. The mixed workload includes queue time for both foreground and background latency. The direct Worker pool uses the same dense function and verifies outputs at both input sizes. An independent Node process saturates the host while each scheduler admits twelve background operations.
- **Production and contract tests.** The daemon consumes an edited L1 get graph through RPC. A configured ranking call reaches a real Worker and matches inline ranking. Graph tests cover resource contention, nesting, retry, failures, timeouts and cache isolation. The Onlion local fold test exercises request-scoped SQLite and deferred embedding.
- **Deferred optimizations.** Worker-resident intermediate buffers and full DAG makespan modeling need sufficient transfer savings on real requests. The benchmark measures caller-resident input and local transfers. It records CPU, concurrency and task durations. Physical power and energy were outside measurement.

| Metric, range across the two runs | PR #190 | Consolidated |
| --- | --- | --- |
| Synchronous single-node median, µs | 0.42–0.70 | 0.67–0.70 |
| Asynchronous single-node median, µs | 1.26–1.44 | 9.82–10.72 |
| Asymmetric DAG median, ms | 75.9–84.7 | 76.0–88.1 |
| Mixed foreground P50 / P95 / P99, ms | 17.8–19.9 / 22.5–29.0 / 22.7–34.3 | 14.5–15.0 / 15.2–15.5 / 15.2–15.5 |
| Mixed batch completion, ms | 342–369 | 1,167–1,530 |
| Hybrid SQLite at eight concurrent requests, requests/s | 90.0–94.6 | 69.4–93.2 |
| External CPU load, observed background peak before / during / after | 4 / 4 / 4 | 4 / 1 / 4 |

The consolidated DAG took 76.0–88.1 ms against its matched wave control at 121.2–123.2 ms. PR #190 already had event-driven execution, and its DAG timings overlap the consolidated timings. Background yielding improved foreground tail latency at the cost of later background completion. Under sustained external load the host reached 100% sampled utilization, Worker allowance fell from 10 to 0, and the background CPU allowance fell from 50 to 8 ms per window. Recovery passed through light load before restoring idle allowance.

Application timings varied with run order and load. Both eight-request hybrid runs were slower, one by 1.5% and one by 22.9%. The default application workload dispatched zero Worker operations. The forced placement regression verifies output parity on the production rerank operator. The 450,000-round direct Worker workload reached 278–287 tasks/s on four threads versus 92–93 tasks/s inline. For 2,000 rounds, four threads yielded 4,311–9,762 tasks/s versus 21,383–23,587 inline. At the larger task size, four-thread median queue time was about 37.7 ms and the measured median communication residual was 0.12–0.22 ms. These Worker measurements describe the synthetic workload.

## PR #190 exploratory trials

The original experiment used different operation IDs and background workloads between arms. Its wave and Worker scenarios remain characterization evidence. Use the paired follow-up for comparisons of production behavior.

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

## Follow-up measurements (2026-11-25)

The follow-up asks whether the cost model's wait dimension and layer configuration validation change execution or dispatch cost. [io-wait-probe.mjs](io-wait-probe.mjs) measures both trees from the same process shape and host:

```sh
git worktree add --detach .temp/baseline 0858eeff
node docs/experiments/runtime/io-wait-probe.mjs --root .temp/baseline --out <artifact>
node docs/experiments/runtime/io-wait-probe.mjs --root . --out <artifact>
```

Each arm ran three times. Raw observations are in `artifacts/unified-runtime-2026-11-25/io-wait-{baseline,change}-{1,2,3}.json`.

| Observation, three runs | Baseline (0858eeff) | Follow-up |
| --- | --- | --- |
| Synchronous one-node graph, µs per call | 0.522–0.572 | 0.504–0.603 |
| Asynchronous one-node graph, µs per call | 10.456–10.772 | 10.311–10.479 |
| Four-wide async fan-out, 20 ms per leaf, ms | 30.857–31.359 | 30.750–31.316 |
| Observed I/O wait of a fan leaf, ms | 0 | 29.684–30.432 |
| Critical-path rank, 5 ms read / 20 ms read | 0.164 / 0.164 | 12.319–14.428 / 29.907–31.441 |

- The wait dimension was previously declared and never sampled: every `waitMs` estimate was `0`, so two independent read branches with different I/O latency ranked identically. After the change the suspended time is a separate sample, ranks follow it, and the CPU estimate for the same operators stays at the `0.082 ms` hint.
- Serialization and scheduling are unchanged: the synchronous path, the asynchronous dispatch floor and the four-wide fan-out stay inside their baseline ranges. The probe did not add a measurable cost to graphs whose operators do not declare `execution: "async_io"`.
- Layer validation is covered by `tests/core/unified-runtime-scheduler.test.ts` (unknown section, unknown parameter, wrong type, string-instead-of-array) rather than by timing, because it changes whether configuration is accepted, not how it executes.

Measurement limits: this Windows host exposes no battery or thermal telemetry, timer granularity rounds a nominal 5 ms delay to roughly 15.6 ms, and thread CPU counters are too coarse for sub-millisecond attribution. The probe therefore reports relative dimensions and dispatch cost. It does not restate application retrieval throughput, which the change does not touch, and it makes no power or energy claim.
