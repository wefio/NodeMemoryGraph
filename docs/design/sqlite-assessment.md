# SQLite Assessment and Performance Tuning

[English](sqlite-assessment.md) | [简体中文](sqlite-assessment.zh-CN.md) · [Terms](sqlite-assessment.terms.yaml)

Historical assessment and recommendations created 2026-07-20. Actions such as “add immediately” were recommendations at that time, not a current TODO list, and do not establish measured performance gains.

Current source check: As of 2026-10-16, the writable store in [`src/core/store/base.ts`](../../src/core/store/base.ts) sets `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64000`, `temp_store=MEMORY`, `mmap_size=268435456`, and `busy_timeout=5000`. The read-only store uses the listed settings except `journal_mode` and `synchronous`. This is a source inspection, not a fresh performance measurement.

**Created:** 2026-07-20

## 1. Does NMG really need SQLite?

### 1.1 NMG's storage requirements

```
✓ Relational queries (JOIN memory ← node ← evidence)
✓ Full-text search (FTS5)
✓ Transactions (atomic multi-table writes)
✓ BLOB storage (vector embeddings)
✓ Embedded (starts with the Pi process; zero configuration)
✓ Single-machine local storage (one .sqlite database file)
```

### 1.2 Alternatives considered in the historical assessment

| Option | JOIN | Full-text search | Transactions | Embedded | Assessment at the time |
|---|---|---|---|---|---|
| **SQLite** | ✓ | ✓ FTS5 | ✓ | ✓ | **Suitable** |
| LevelDB / RocksDB | ✗ no SQL | ✗ | ✗ single-key | ✓ | Not selected: NMG queries join memory, node, and evidence; a KV layer would require application-side joins |
| LMDB | ✗ no SQL | ✗ | ✓ | ✓ | Not selected for the same KV-join reason |
| DuckDB | ✓ | ✓ | ✗ (as characterized by the note) | ✓ | Not selected: the note treated it as an OLAP rather than frequent-small-transaction OLTP engine |
| PostgreSQL | ✓ | ✓ GIN/tsvector | ✓ | ✗ separate process | Not selected under the local-first, zero-config principle |
| Plain JSON files | ✗ | ✗ | ✗ | ✓ | Not selected: each retrieval would load and parse the whole dataset |

The note concluded SQLite fit NMG's relational memory → node → evidence model, many-to-many links, and FTS needs. This is a dated architecture assessment, not a current comparative benchmark of database products.

### 1.3 The alternative scenario identified at the time

For multi-process concurrent writes—for example, multiple Pi agents sharing memory—the note observed that SQLite WAL supports one writer and concurrent readers, but is not designed for high write concurrency. It listed these possibilities for a future deployment change:

- **LiteFS** (distributed SQLite over FUSE), retaining the SQLite API and replicating across nodes;
- **Turso** (libSQL, SQLite-compatible with remote synchronization);
- **PostgreSQL**, only if deployment changed from embedded to service-oriented.

The note classified these as P3 and cited the design rule that cloud sync is optional and never authoritative. These were future possibilities, not approved migration plans.

---

## 2. SQLite tuning proposals from the assessment

### 2.1 State recorded at the time

```sql
-- The 2026-07-20 note recorded only these two pragmas
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
```

### 2.2 Pragmas recommended then

```sql
-- The note proposed NORMAL for WAL mode, with crash recovery through WAL
PRAGMA synchronous = NORMAL;

-- Default cache was recorded as 2 MB (-2000 KB); the proposal suggested 16–64 MB
PRAGMA cache_size = -64000;  -- 64 MB

-- Keep temporary tables and indexes in memory
PRAGMA temp_store = MEMORY;

-- Map part of the database file into the process address space
PRAGMA mmap_size = 268435456;  -- 256 MB
```

The proposal suggested adding these after the existing pragmas in the constructor. Its safety/performance statements were design reasoning, not a current guarantee or result. The current settings are listed in the source-check block above.

### 2.3 Periodic maintenance proposals

```sql
-- Refresh planner statistics
PRAGMA optimize;

-- Reclaim free pages after substantial database growth
PRAGMA vacuum;
```

The note suggested `PRAGMA optimize` after a number of changed records or on a schedule, possibly after `rebalanceNode`, and proposed `VACUUM` only after substantial delete/update activity. These are dated recommendations; consult the current maintenance owner before adding a new trigger.

### 2.4 Query optimizations proposed

#### 2.4.1 Hot path: `#searchWithVector`

The note described a three-table join with a left join to embeddings:

```sql
SELECT ... FROM memory_records m
JOIN memory_nodes n ON n.id = m.node_id
JOIN history_records h ON h.id = m.evidence_id
LEFT JOIN memory_embeddings ve ON ve.memory_id = m.id AND ve.model = ?
WHERE m.tier <= ? AND ... AND n.status = 'active'
ORDER BY m.tier ASC, m.importance DESC, m.access_count DESC
LIMIT ?
```

It proposed a `memory_records(status)` index, while warning that the query planner might prefer a tier index depending on data distribution. The suggested check was `EXPLAIN QUERY PLAN`; the index proposal is not asserted as a current missing index.

#### 2.4.2 Large `IN` clauses

For up to 2,000 `forcedCandidateIds` or `ftsIds`, the note illustrated a large parameterized `IN` list and proposed a temporary candidate table joined by ID if this became a measured bottleneck. It judged the existing `IN` approach adequate for its then-estimated scale (<500 candidates). Neither the scale estimate nor the need for a rewrite is a current benchmark result.

#### 2.4.3 FTS5 query cost

The note described `#ftsCandidates` using FTS5 BM25 and quoted this historical table definition:

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED,
  statement,
  node_name,
  evidence,
  tokenize = 'unicode61'
);
```

It raised Chinese tokenization as a possible concern and listed ICU, a trigram tokenizer, or `LIKE` as alternatives. It also judged `unicode61` adequate for the then-assumed scale of agent memory. These are historical observations and suggestions; verify the current FTS schema and corpus before changing tokenization.

### 2.5 Write path and statement-cache proposals

The note described the write path as already using WAL, `BEGIN IMMEDIATE`, batched transactions, and prepared statements. It proposed `synchronous=NORMAL` as a way to reduce commit waiting, while explicitly treating the data-loss risk under combined OS crash and disk-write reordering as acceptable for agent memory. That risk assessment is not a current durability guarantee.

The note also suggested explicitly caching a prepared statement for a high-frequency query, but observed that dynamic SQL with variable-length `IN` clauses limits reuse. It classified explicit statement caching as low priority.

## 3. Historical action summary

| Recommendation in the 2026-07-20 note | Expected effect at the time | Historical action |
|---|---|---|
| `synchronous = NORMAL` | Faster writes | “Add immediately” |
| `cache_size = 64MB` | Lower retrieval latency | “Add immediately” |
| `mmap_size = 256MB` | Lower read latency | “Add immediately” |
| `temp_store = MEMORY` | Faster temporary operations | “Add immediately” |
| `PRAGMA optimize` | Better query plans | Periodic |
| `idx_memory_records_status` | Possible retrieval improvement | Add only with `EXPLAIN` evidence |
| Prepared-statement cache | Lower CPU overhead | Low priority |
| Temporary table for large `IN` | Faster large candidate sets | Only if measured/benchmarked |

This table is retained for historical context; it is not a current work list. Current code and current measurements take precedence.