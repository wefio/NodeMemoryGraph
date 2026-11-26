# Backend optimization delegation and lowering benchmark

[简体中文](backend-optimization-delegation-2026-11-26.zh-CN.md) · [Terms](backend-optimization-delegation-2026-11-26.terms.yaml)

## Purpose and measurement conditions

Evaluate cross-backend canonical output parity, compilation overhead, SQL prepare/entity-scan counts, and wall/p50/p95 latencies across NMG SQLite region pushdowns (`lowered`) and portable snapshot fallbacks (`portable`), alongside JS/V8 slot-indexed sync kernel execution over piecewise rerank and HTTP search fusion graphs.

```sh
node docs/experiments/runtime/backend-lowering-benchmark-2026-11-26.mjs --out docs/experiments/runtime/artifacts/backend-lowering-2026-11-26/report.json
```

- **Benchmark runner:** [backend-lowering-benchmark-2026-11-26.mjs](backend-lowering-benchmark-2026-11-26.mjs) saving [raw observations](artifacts/backend-lowering-2026-11-26/report.json) (`measuredAt: "2026-11-26T12:56:03.122Z"`).
- **Host:** Node `v26.13.0`, `win32` `x64`, `20` logical CPUs (`12th Gen Intel(R) Core(TM) i7-12700H`).
- **Telemetry limit:** `environment.powerTelemetryAvailable` is `false`; physical power and energy consumption are not measured and are not inferred from CPU time.

## Compiler and JS/V8 sync kernel results

- **Graph compilation (`compile`):** Cold `DEFAULT_PROJECT_GRAPH` compile median `148.5 µs`; warm `PLAN_CACHE` hit `22.039 µs` (`5000` lookups).
- **Piecewise rerank DAG (`80` candidates, `250` runs):**
  - Interpreted baseline (`enableSyncKernel: false`, `enableLinearFusion: false`): `wallMs: 116.442`, `p50Ms: 0.444`, `p95Ms: 0.696`, `opsPerSec: 2147.001`, `cpuMs: 141`, `heapDeltaMb: 4.488`.
  - Pre-bound `syncKernel` + `RerankCandidateIndex`: `wallMs: 109.263`, `p50Ms: 0.421`, `p95Ms: 0.65`, `opsPerSec: 2288.064`, `cpuMs: 188`, `heapDeltaMb: 1.809` (`speedupRatio: 1.066`).
- **HTTP search fusion diamond (`16` clause results, `3000` runs):**
  - Interpreted baseline: `wallMs: 64.272`, `opsPerSec: 46676.842`.
  - Pre-bound `syncKernel`: `wallMs: 60.927`, `opsPerSec: 49239.334` (`speedupRatio: 1.055`).
- **Opaque fallback guard (`5000` runs):** `74.208 ms` with unlowered node preserved cleanly.

## Multi-scale SQLite pushdown vs portable fallback (`N = 50..2500`)

All four scales verified exact SHA-256 canonical digest parity (`parityVerified: true`) across `projectGraph`, `userProfile`, `lexicalSearch`, and `getWithProfileLinks`, plus HTTP single-clause search (`httpReturned: 10`).

| Corpus `N` (iters) | Operation | Lowered p50 / p95 (ms) | Portable p50 / p95 (ms) | Lowered prep / scan | Portable prep / scan |
| --- | --- | --- | --- | --- | --- |
| `50` (`25`) | `projectGraph` | `2.28` / `3.249` | `3.08` / `3.745` | `7` / `0` | `8` / `58` |
| `50` (`25`) | `lexicalSearch` | `1.859` / `2.373` | `2.137` / `3.65` | `9` / `0` | `9` / `65` |
| `50` (`25`) | `userProfile` | `1.486` / `2.063` | `1.029` / `1.625` | `10` / `0` | `7` / `8` |
| `50` (`25`) | `getWithProfileLinks` | `1.785` / `1.975` | `1.334` / `2.094` | `10` / `0` | `10` / `15` |
| `250` (`25`) | `projectGraph` | `4.105` / `5.337` | `7.385` / `8.576` | `7` / `0` | `8` / `266` |
| `250` (`25`) | `lexicalSearch` | `2.971` / `3.334` | `5.752` / `6.677` | `9` / `0` | `9` / `263` |
| `250` (`25`) | `userProfile` | `1.643` / `2.315` | `1.121` / `1.351` | `10` / `0` | `7` / `27` |
| `250` (`25`) | `getWithProfileLinks` | `1.914` / `2.166` | `1.959` / `2.34` | `10` / `0` | `10` / `15` |
| `1000` (`15`) | `projectGraph` | `4.665` / `6.006` | `23.676` / `30.389` | `7` / `0` | `14` / `1066` |
| `1000` (`15`) | `lexicalSearch` | `5.965` / `8.76` | `14.114` / `16.08` | `9` / `0` | `9` / `588` |
| `1000` (`15`) | `userProfile` | `2.736` / `3.273` | `1.99` / `4.117` | `10` / `0` | `7` / `69` |
| `1000` (`15`) | `getWithProfileLinks` | `2.245` / `2.82` | `1.849` / `2.354` | `10` / `0` | `10` / `15` |
| `2500` (`15`) | `projectGraph` | `4.223` / `4.84` | `49.932` / `59.785` | `7` / `0` | `28` / `2640` |
| `2500` (`15`) | `lexicalSearch` | `10.777` / `14.744` | `18.074` / `24.7` | `9` / `0` | `9` / `688` |
| `2500` (`15`) | `userProfile` | `4.002` / `5.529` | `1.979` / `2.436` | `10` / `0` | `7` / `145` |
| `2500` (`15`) | `getWithProfileLinks` | `1.658` / `2.426` | `1.559` / `1.939` | `10` / `0` | `10` / `15` |

## Analysis and verification coverage

- **Graph projection & lexical search scale cleanly under SQL pushdown:** At `N = 2500`, `projectGraph` lowered throughput reaches `246.994` ops/s (`wallMs: 60.73`, `heapDeltaMb: -0.822`) versus `19.834` ops/s (`wallMs: 756.265`, `heapDeltaMb: 19.583`) on portable pagination, cutting SQL `prepare` calls from `28` to `7` and JS entity scans from `2640` to `0`. `lexicalSearch` improves from `18.074 ms` p50 (`54.614` ops/s, `scannedEntities: 688`) to `10.777 ms` p50 (`89.027` ops/s, `scannedEntities: 0`).
- **Selective small scans reveal conversion break-even points:** For selective `userProfile` subsets (`5%` of corpus, `145` scanned rows at `N = 2500`), portable `scan` runs in `1.979 ms` p50 (`prepareCount: 7`) versus `4.002 ms` (`prepareCount: 10`) in the joined SQLite pushdown path, while 5-ID `getWithProfileLinks` measures near parity (`1.658 ms` vs `1.559 ms`).
- **Cross-backend contract tests & WASM SQLite:** Dedicated tests in `tests/core/backend-lowering-delegation.test.ts` verify declarative capabilities, convex region legality, adapter version cache invalidation, `L0 -> L1 -> L2` `optimization` separation from `resultIdentityHash`, timezone parity (`+08:00`), snapshot isolation, and strict equality across SQLite pushdown, portable fallback, and `LanceMemoryBackend`. EdgeOne WASM SQLite builds and tests in `onlion` pass (`test:backend`, `test:add-log`, `test:edgeone-package`, `test:append-log`, `test:page-delta`).
