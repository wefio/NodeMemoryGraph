# Single-vector-payload storage probe

## Scope

Local synthetic evidence for the
[one-payload decision](../../decisions/implemented/2026-10-07-single-vector-payload.md).
[Raw measurements](single-vector-payload-2026-10-07.json) were collected at
2026-10-07T11:59:06.590Z with Node 24.19.0 / SQLite 3.53.3. The storage change
is based on main `77f76446`; the implementation and this report share a commit.

The input is an isolated in-memory NMG graph, not the reported cloud database.
No provider, live embedding model, production database or official benchmark
runs. All stages use 4,096-byte pages. The numbers below are allocated SQLite
page bytes, not measured disk-file or WASM/VFS sizes.

## Method

1. Create a fresh `NmgStore(":memory:")` using its local 256D hashing embedder.
   Remember 300 statements in the `synthetic` node. For index `i = 0..299`, use
   ``Synthetic storage probe ${i}: ${"retained source text ".repeat(24)}``.
2. Add one 1024D `synthetic-dense` record embedding per memory. Element `j` is
   `Math.sin((i + 1) * (j + 1)) * 0.03`. There are 600 embedding rows total;
   no node/leaf embeddings. Mirror each decoded BLOB into `vector_json` using
   `JSON.stringify(storedVector(row))`, then `VACUUM` this private database.
   This is a controlled dual-format baseline, not a reconstruction of a
   particular provider's original JSON serialization.
3. Save vector/key/model/dimension/timestamp fingerprints and the returned IDs
   and vector scores from `searchByVector("storage probe", dense[0].vector,
   "synthetic-dense", { retrievalMode: "qwen3", maxTier: 3 })`.
4. Delete only the `vector_storage_format` completion marker in this fixture and
   run `ensureBinaryVectors`. Measure immediately, repeat the fingerprints and
   query, then measure again after a separate fixture-only `VACUUM`.
5. Require 300 history and memory rows, 600 embeddings, unchanged binary bytes
   and embedding metadata, unchanged retrieved IDs/vector scores, an `ok`
   integrity check, and no foreign-key violations. Missing or non-finite
   measurements fail the probe. Random stable IDs vary between runs; each
   fingerprint comparison is within the same database.

## Results

| Measurement | Compacted dual-format baseline | Migrated, no compaction | Migrated + compaction |
| --- | ---: | ---: | ---: |
| JSON vector bytes | 6,863,550 | 1,200 | 1,200 |
| BLOB vector bytes | 1,536,000 | 1,536,000 | 1,536,000 |
| Allocated pages | 2,845 | 2,846 | 1,033 |
| Free pages | 0 | 1,501 | 0 |
| Allocated page bytes | 11,653,120 | 11,657,216 | 4,231,168 |

All required assertions passed. Removing duplicate JSON releases approximately
6.54 MiB of logical payload in this particular dense-vector fixture. Comparing
both compacted endpoints gives approximately 63.7% fewer allocated page bytes;
that percentage depends on this synthetic JSON representation and is not a
cloud estimate. Migration alone does not shrink allocated pages.

## Limits

This is a storage measurement and a narrow retrieval identity check, not a
latency or recall-quality benchmark. It does not validate cloud upload costs,
real Qwen distributions, cold-cache behavior, Sites/WASM/VFS support, backup
recovery, multi-process upgrades or other page sizes. Production migration does
not automatically compact the database. Node/leaf persistence and rollback
contracts are covered separately by the product storage tests.
