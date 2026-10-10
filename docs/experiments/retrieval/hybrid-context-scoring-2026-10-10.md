# Hybrid correctness and context-level scoring — 2026-10-10

## Correctness before timing

Base `ee32e448b2d978174754ab5d97c47bf0a0d72588` has the hybrid positional-binding
defect tracked in temporary TODO item 8. Eight tier-2 FTS hits form a bounded
fixture. Six positive cases failed before the fix: unfiltered, each time bound,
both bounds, multi-key scope, and time/scope together. Some returned no records;
one controlled window-only run returned seven when five were eligible. These
observations do not estimate production frequency or overall recall loss.

The fix moves only the repeated `ORDER BY` ID bindings after all `WHERE`
parameters. The nine [binding contracts](../../../tests/core/store/hybrid-bindings.test.ts)
cover correct eligible IDs, inclusive bounds, missing date/scope keys, rejected
records, stable repeated ordering, FTS-only/vector-only/forced/no-hit controls and
public second-pass context. With existing retrieval/scoring tests, 57/57 passed.
The context fixture explicitly requests QPP expansion: an initial maximum-limit
assumption returned one eligible hit because QPP legitimately stopped sufficient;
debugger evidence confirmed that behavior, and `qppThreshold: 1` requests the
expected two-record expansion without altering production behavior.

## Method

[Raw artifact](hybrid-context-scoring-2026-10-10.json) records samples, parity
hashes, source/storage hashes and environment. Windows x64, Node v24.19.0, native
SQLite 3.53.3, Intel i7-12700H; no live embedding/LLM/provider calls.

Private 300-memory/history corpus, eight nodes, all memories tier 2. Each statement
is `scoring corpus entry {i}`; node is `Corpus node {i%8}`. Dense vectors have
1,024 dimensions, `Math.sin((i+1)*(j+1))*0.03 + 0.03`. The positive bias ensures
non-vacuous fallback results; an initial zero-centred probe correctly abstained
on some filtered queries and was not accepted as a timing result. This is
synthetic geometry, not cached Qwen embeddings. Project is `Other` at `i%4==0`,
`Atlas` otherwise, tenant `north`. Time is absent at `i%10==0`, `2026-10-04` at
`i%10==1`, otherwise October 5 for even indices and October 6 for odd indices.
The filter retains 180 records. Query vector is corpus vector `q`, q=0..31.
Queries 0..15 are `scoring corpus` (300 FTS hits), 16..31 are
`unmatchedsemanticprobe` (zero hits). Both use conjunctive scope and the inclusive
October 5–6 window.

Timed API is the complete synchronous `store.searchContext(query, options)`:
cached embedder invocation, SQL/FTS and candidate reads, time/scope filtering,
record decoding/scoring/mapping, node routing, ranking, AG budget/projection,
QPP expansion and chain lookup. Limit 10, `secondPass: true`,
`initialEvidenceTarget: 1`, `qppThreshold: 1`, `expandChains: true`; every sample
has positive eligible evidence and at least two QPP stages. No chains are
injected. This path does not invoke hierarchical semantic node/leaf routing.

Three paired rounds alternate decoded→borrowed / borrowed→decoded /
decoded→borrowed. Each reader gets a fresh Node process and read-only byte-copy
of the same closed fixture DB, one 32-query warmup and two measured rounds:
192 samples per reader, 96 per FTS condition. Store open, vector generation,
module load, subprocess startup, FTS precondition assertions, output/parity
hashing and data fingerprints are outside the timer. Date.now is frozen at
`2026-10-10T08:00:00Z`; performance.now remains monotonic. `persistTrace: false`
excludes trace/learning writes.

Borrowed mode runs the unmodified repaired module. Decoded mode uses one strict
in-memory Node module-load substitution at the immediate cosine call:
`scoringVector(row, "ve_")` → `storedVector(row, "ve_")`. It neither copies BLOBs
into unaligned buffers nor rewrites source/database files. The script asserts
exactly one replacement; uses shared mean/median/nearest-rank percentile parts;
rejects empty/missing inputs or any failed child; and is removed after use.

## Results

| Timed context path | Decoded median | Borrowed median | Decoded P95 | Borrowed P95 |
| --- | ---: | ---: | ---: | ---: |
| All queries (192 each) | 10.3724 ms | 7.1587 ms | 15.1341 ms | 11.5715 ms |
| Positive FTS (96 each) | 10.8198 ms | 7.9370 ms | 16.3959 ms | 12.0945 ms |
| No-hit fallback (96 each) | 9.6909 ms | 6.5602 ms | 12.7449 ms | 9.2450 ms |

The combined sample median is 31.0% lower; positive-FTS median is 26.6% lower.
All 192 paired result projections have identical memory IDs/order, complete
result score fields, selections, QPP decisions and non-timing AG usage. Six
processes retain identical pre/post storage fingerprints. The actual source SHA
is preserved in the artifact and unchanged after the probe.

## Boundaries

Both readers execute the corrected SQL. This does not time the broken empty
path against a valid result or claim that correctness recovery is speedup.
No production-impact estimate, real LoCoMo/Qwen replication, hierarchy-semantic
benchmark, trace-write cost, RPC/harness/network latency, cloud/WASM/VFS result,
CPU profile or universal gain follows. Three live-workstation pairs are measured
observations, not a worst-case guarantee. Real LoCoMo/Qwen replay still needs the
cached vectors and original harness; a dataset URL alone is insufficient.
