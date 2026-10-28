# Request-local query preparation, 2026-10-28

[中文](request-preparation-2026-10-28.zh-CN.md) · [Terms used](request-preparation-2026-10-28.terms.yaml)

## Result

For two healthy Store searches using the same query, request-local preparation
reduces query embedding calls from two to one. Across two independent process
runs, all 180 measured pairs returned exactly equal ordered candidate objects.
This is a synthetic retrieval equivalence check, not a dataset recall@20 result.

| Case (30 measured requests per run) | Calls before / after | First run p50 ms before / after | Repeat p50 ms before / after |
| --- | ---: | ---: | ---: |
| One query, one Store | 30 / 30 | 30.680 / 31.152 | 30.197 / 30.512 |
| Same query, two Stores | 60 / 30 | 60.624 / 32.656 | 59.258 / 32.411 |
| Different queries, two Stores | 60 / 60 | 61.501 / 61.046 | 60.635 / 60.330 |

The same-query case's p95 was 68.822 → 38.176 ms, and 67.793 → 39.827 ms
on repeat. These timings include a **simulated 20 ms provider wait per call**;
Windows timer scheduling and SQLite work contribute to elapsed time. They do
not estimate production provider latency. Cases without repeated queries show
no call reduction or established speedup.

## Method and reproduction

Base revision: `cd193624f10d`. Windows, Node v24.19.0. The retained probe uses two
in-memory SQLite stores with 60 generated memories each and fixed two-dimensional
record/query vectors. Both arms search the same fixtures; generated memory IDs
need not match across process runs. Fixture creation is outside the timer.
Each case warms up three pairs, then measures 30 pairs, alternating arm order.
The direct arm uses `searchMemoryContext` unchanged; the request arm supplies
`requestQueryEmbeddingClient`, as the daemon now does. Every invocation owns a
new wrapper. P50/P95 use the repository's `percentileFloor` convention.

```powershell
node --experimental-strip-types evals/retrieval/request-perf.ts --out docs/experiments/retrieval/artifacts/2026-10-28-request-reuse.json --iterations 30 --records 60 --delay-ms 20
```

The script rejects missing output, invalid counts, nonfinite measurements,
empty candidate pages, unexpected embedding call counts, and unequal complete
ordered result objects. Limit is 20; graph hops are zero, second pass and trace
persistence are disabled. No real provider, answer model, or production database
is accessed. Raw reports include runtime, options, input description, timestamp,
implementation hashes, call counts and both arms' latency distribution:

- [First run](artifacts/2026-10-28-request-reuse.json)
- [Repeat](artifacts/2026-10-28-request-reuse-repeat.json)

The separate [contract tests](../../../tests/integration/query-embedding-request.test.ts)
exercise real Store reads, deletion between reads, concurrent consumers, failed
and empty response retries, mutation isolation, automatic cancellation and
lexical-only selection. A loopback HTTP provider test exercises the actual
`NmgService` multi-query path and proves preparation ends with each invocation.

## Scope and remaining work

This change removes repeated query preparation in the local daemon. It does not
cache index health or memory results, batch distinct query texts, change ranking,
or alter cloud storage. It does not establish whole-daemon throughput, p99,
event-loop delay, request backpressure, or remote cancellation. Those need
separate workload measurements; no concurrency policy was added from this probe.
The [retrieval contract](../../design/design/progressive-retrieval.md#request-local-query-preparation)
owns behavior and the [decision](../../decisions/implemented/2026-10-26-retrieval-infrastructure-cost.md#request-local-query-preparation-extension)
owns the tradeoff.
