# Contentless lexical FTS: bounded local storage probe

## Scope and setup

Measured **2026-10-07T13:12:49.636Z**, Node **v24.19.0**, SQLite **3.53.3**,
4096-byte pages. [Raw result](contentless-fts-2026-10-07.json).

One private in-memory graph held 300 synthetic memories and 300 history rows,
with default local hashing embeddings only. Node/leaf embedding tables were
empty. No cloud database, provider, live session or production file was used.

Each statement was:

```text
Storage corpus item {index}. 用户希望保留中文解释与原始证据。 C++ v2.4.1
+ 'retained source text '.repeat(24)
```

The node name was `FTS corpus`, each record had a distinct fixture item scope,
and each indexed `fixture-alias` as a recall trigger. History and statement bytes
happened to match in this fixture; both authoritative fields were retained.

The baseline mirrored current transformed documents into the old full-content
FTS5 schema, preserving lexical rowids. Vector storage was already single-payload.
It was compacted first. The same database then underwent the normal FTS
migration, followed by a **separate fixture-only `VACUUM`** for endpoint allocation.
The temporary probe used `--rows 300 --out <raw-result-path>`, asserted a nonempty
dataset and every preservation check, and was removed afterward.

## Observations

| Measurement | Compacted full-content baseline | Contentless, no compaction | Contentless + fixture-only compaction |
|---|---:|---:|---:|
| Memory/history rows, each | 300 | 300 | 300 |
| Lexical/surface FTS rows, each | 300 | 300 | 300 |
| Original history UTF-8 bytes | 176,290 | 176,290 | 176,290 |
| Statement UTF-8 bytes | 176,290 | 176,290 | 176,290 |
| Duplicate FTS full-text UTF-8 bytes | 418,580 | 0 | 0 |
| Pages | 774 | 774 | 619 |
| Free pages | 0 | 154 | 0 |
| Allocated bytes | 3,170,304 | 3,170,304 | 2,535,424 |

FTS text bytes count its transformed statement, node-name and evidence fields,
excluding the old unindexed memory-ID column and page overhead. They include
Han-bigram and trigger text, so they are not simply twice the input byte count.

Assertions passed: complete history/memory/node row fingerprints unchanged;
all three embedding-table fingerprints unchanged (node/leaf empty); positive
English, Han-bigram and trigger queries returned identical IDs, lexical rowids
and BM25 scores; punctuation surface queries returned identical IDs; row counts
preserved; integrity `ok`; zero foreign-key violations.

## Interpretation and limits

About **408.8 KiB** of logical duplicate full text was removed. Migration freed
pages but did **not** reduce allocated size. The compacted endpoint used
**634,880 fewer bytes (620 KiB, about 20.0%)** in this fixture. Neither figure is
a cloud saving or a latency measurement; page layout, corpus and embeddings
change the result.

The probe does not establish recall quality outside those queries, cloud
compatibility, SQLite WASM/VFS behavior, backup recovery or crash-time
multi-process upgrades. No production compaction or page-size migration was run.
Older FTS SQL consumers must adopt the registry mapping before using the migrated
database; binary-aware vector reading by itself does not provide that compatibility.
