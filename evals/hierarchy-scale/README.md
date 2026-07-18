# Hierarchical vector granularity evaluation

Compares full MemoryRecord vector scans, node-only routing, node plus leaf/block
routing, and record-level USearch ANN on the same wide-node workload.

```powershell
npm run eval:hierarchy
$env:NMG_HIERARCHY_SIZES = "100,1000"
$env:NMG_ANN_CANDIDATES = "64"
```

The deterministic hashing embedder is a systems baseline, not a semantic-quality
claim. Repeat with Qwen3 after the local embedding endpoint is available.

## Initial local result (hashing baseline)

| memories | vectors: records / nodes / leaves | full scan P50 | node+leaf scan P50 | leaf ANN P50 |
|---:|---:|---:|---:|---:|
| 1,000 | 1,000 / 16 / 40 | ~21 ms | ~2 ms | not measured |
| 10,000 | 10,000 / 16 / 328 | ~524 ms | ~9–10 ms | ~5 ms |
| 100,000 | 100,000 / 16 / 3,144 | ~9.1 s | ~80–88 ms | ~12–18 ms |

At 100K, node plus leaf headers used about 31.6x fewer vectors than per-record
vectorization. Hashing recall was unstable: node-only reached 37.5%; node plus
leaf scanning reached roughly 62.5–75%; leaf ANN ranged from 25% at Top-64 to
50% at Top-512. Record ANN also degraded badly amid near-duplicate distractors.
These are useful negative results: hierarchical indexing fixes scaling cost, but
cannot compensate for a weak semantic representation. Qwen3 must be tested before
choosing the production candidate budget or selective record fallback policy.
