# NMG scale and cache-breakthrough evaluation

This evaluation keeps the same eight answerable queries while growing the store
through 100, 1K, 10K, and 100K memories. The expected memories are inserted
before newer distractors, so the test deliberately pushes cold evidence outside
the legacy 500-row candidate window.

Run:

```powershell
npm run eval:scale
```

Use `NMG_SCALE_SIZES=100,1000` for a quick run and
`NMG_SCALE_VERBOSE=1` for per-query traces.

Reported dimensions include evidence accuracy, tier hit rate, returned context
size, P50/P95 latency, bulk ingestion throughput, and FTS backfill cost. The
retrieval baselines are:

- `legacy`: the original bounded hot-window hybrid scorer;
- `fts5`: SQLite full-text retrieval;
- `hashing`: deterministic hashing vectors over the bounded window;
- `qwen3`: Qwen3 vectors from the configured OpenAI-compatible endpoint;
- `hybrid`: FTS candidates plus the semantic/hot working set.

When Qwen is enabled, the matrix records vector-build time separately. The
persisted USearch HNSW index can then be built with `npm run index:ann` so ANN
recall and maintenance cost can be compared with the measured brute-force scan.

The first cache-breakthrough run established the ANN gate: at 100 memories the
legacy path achieved 100% accuracy with a roughly 3 ms P50; at 100K it achieved
37.5% with a roughly 568 ms P50. FTS5 stayed at 75% and below 1 ms, while the
pre-ANN hybrid recovered 87.5% but retained roughly 522 ms P50 because graph and
semantic routing still scanned large candidate sets. These figures are local
synthetic measurements, not general benchmark claims.

The synthetic workload is a systems test, not a replacement for LongMemEval or
BEAM. It answers one narrower question: does a relevant memory remain reachable
after the shallow working set has been exhausted?
