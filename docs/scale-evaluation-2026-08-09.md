# NMG lexical scale evaluation — 2026-08-09

This is a synthetic storage/retrieval engineering check, not an answer-quality
benchmark. It used `evals/scale/run.ts`, disabled every external embedding
provider, and measured eight fixed probes among generated unrelated records.

## Results

| Records | Bulk insert | Open + FTS backfill | FTS5 P50 / P95 | Hashing P50 / P95 | Legacy P50 / P95 | Hybrid P50 / P95 |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 6 ms | 4 ms | 0.39 / 0.74 ms | 1.83 / 2.20 ms | 3.33 / 5.36 ms | 1.37 / 3.03 ms |
| 1,000 | 23 ms | 9 ms | 0.34 / 0.44 ms | 6.75 / 7.56 ms | 12.51 / 15.44 ms | 6.49 / 13.41 ms |
| 10,000 | 197 ms | 90 ms | 0.38 / 0.56 ms | 16.91 / 18.14 ms | 64.84 / 70.41 ms | 51.15 / 66.81 ms |
| 100,000 | 2.06 s | 0.90 s | 0.33 / 0.56 ms | 95.70 / 96.67 ms | 598.84 / 660.13 ms | 519.29 / 626.95 ms |
| 1,000,000 | 20.15 s | 9.95 s | 0.46 / 0.91 ms | 1.26 / 1.29 s | 6.80 / 7.16 s | 6.18 / 7.03 s |

The bulk generator sustained about 49.6k records/s at one million records. The
temporary one-million-record SQLite file was approximately 1.3 GiB and was
removed after measurement.

## Interpretation

- SQLite storage and FTS5 remain operational at one million synthetic records;
  exact lexical lookup stayed below 1 ms P95 in this probe.
- Unindexed record/node scoring is not scale-independent. Hashing, legacy, and
  no-external-vector hybrid modes become seconds-level at one million records.
- The fixed probes are deliberately mixed lexical/semantic cases. FTS5 reached
  5/8, while the unindexed alternatives did not recover enough cold semantic
  evidence to justify their scan cost. This is evidence against pretending that
  hashing or graph routing replaces a real semantic index at this scale.
- NMG should keep FTS as the exact/string path, use a built vector index for
  semantic retrieval when large-scale semantic recall is required, and keep ANN
  adoption conditional on exact-vs-ANN recall audits. A separate vector database
  is still not required by these results.

No LLM, embedding API, local embedding model, Pi daemon, or benchmark-specific
answer logic was used.

## Single-service concurrency probe

`evals/concurrency/run.ts` submitted 800 governed LTG writes from 32 logical
sessions through one `NmgService` and its single synchronous SQLite writer, then
ran one scoped FTS lookup per session. It completed with zero write/search
failures in 1.11 s (about 720 writes/s). Observed write latency was 38.3 ms P50,
52.9 ms P95, 117.5 ms P99, and 133.8 ms maximum. This verifies correctness and
bounded behavior for modest local concurrency; it is not a multi-process load
claim and does not justify a distributed writer.
