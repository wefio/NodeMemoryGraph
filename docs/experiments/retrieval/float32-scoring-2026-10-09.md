# Float32 scoring-kernel observation — 2026-10-09

Measured at `2026-10-09T14:09:25.937Z`, against the unchanged decoder and the
working-tree scoring view based on `7c18f6f61b375a129fc04ad6ba5ee62ebb0522ab`.
Raw samples and configuration: [JSON](float32-scoring-2026-10-09.json).

## Fixture and method

- Windows x64, Intel Core i7-12700H, Node v24.19.0, native SQLite 3.53.3.
- Private in-memory SQLite table: 300 BLOB vectors, each 1024D Float32.
  Value recipe: `Math.sin((i + 1) * (j + 1)) * 0.03`.
- 32 ordinary-array query vectors use the same recipe with query index `i`.
  SQLite loads all BLOBs before timing. Each sample scores all 300 records.
- Paired implementations alternate first position by round+query parity.
  Two warmup rounds are excluded; six measured rounds yield 192 samples each.
- Old expression: `cosineSimilarity(query, storedVector(row, "ve_"))`;
  new expression: `cosineSimilarity(query, scoringVector(row, "ve_"))`.
- Output scores are consumed by matching checksums outside the timed interval.
  Percentile uses nearest rank, `ceil(n * 0.95) - 1`.
- No live provider, embedding, official benchmark, production database or cloud
  workload was invoked. The owned throwaway probe was removed after measurement.

## Observed

| Kernel metric | Decode to ordinary array | Borrow Float32 view |
| --- | ---: | ---: |
| Median scan | 3.3905 ms | 0.3857 ms |
| P95 scan | 3.7301 ms | 0.4739 ms |
| Mean sampled process CPU | 3.5104 ms | 0.2344 ms |

Process-CPU samples include many zeros/coarse steps; retain their raw values,
but do not infer fine-grained per-query CPU savings from this Windows counter.

9,600 pre-timing record scores were exactly equal with `Object.is`; accumulated
scores across all warmup/measured samples also matched (`249.34857042008198`).
All 300 native BLOB rows were borrowable. Payload SHA-256 remained
`66fea4328026b961de6ffafd7255c6f3b05cf90f697643b9e9f8ca619583de3e`.
The contract tests separately check store result ordering, complete scores,
nonmutation and ordinary-array exports against forced decoder fallback.

## Limits

This is a **synthetic scoring kernel**, not end-to-end retrieval. SQL, NMG
filtering/ranking, hierarchy, second pass, chain expansion, RPC, embedding work,
Sites, SQLite WASM/VFS and deployment are outside the timed region.
Do not translate the kernel ratio into a retrieval or cloud speedup.

The user's reported LoCoMo conv-30/cached Qwen experiment (162 queries per
implementation, median 21.83→12.99 ms, P95 42.38→25.35 ms) remains separately
attributed and not reproduced. Its harness/cached-vector artifacts were not
available here. Basic WASM memory lifetime tests do not establish SQLite WASM
or Sites compatibility. Big-endian hardware is unexercised.
