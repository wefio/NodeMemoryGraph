# Incremental storage and index maintenance

[简体中文](incremental-storage-and-index-maintenance.zh-CN.md) · [Terms used](incremental-storage-and-index-maintenance.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Incremental storage and index maintenance

Writing a memory must not trigger a full vector/index rebuild.

```text
new MemoryRecord
  -> persist transactionally
  -> add to searchable Delta
  -> mark affected leaf/node dirty
  -> query Base + Delta immediately
  -> compact/rebuild affected regions later
```

`STG/LTG` and `Base/Delta` are orthogonal dimensions. STG/LTG describe semantic
lifecycle and consolidation status. Base/Delta describe physical index
maintenance. An LTG fact can be in Delta immediately after insertion, and an STG
candidate can already be compacted into Base without becoming long-term memory.

Maintenance has three scopes:

1. **Local:** rebuild only the affected block, leaf vector, or node header.
2. **Accumulated:** compact when record/token/dirty-ratio thresholds are reached
   or during an idle period.
3. **Neighbourhood:** batch nearby dirty nodes when they share records,
   embeddings, or likely topology work.

The resident service implements the accumulated scope as an amortized queue.
Writes increment durable per-node `memory_index_delta` rows and exact memory
use increments `pending_access_count`; a small process-local counter avoids a
database due-check after every call. On the first signal after daemon startup,
and thereafter only when a threshold is crossed, an event-loop maintenance
slice examines at most a bounded number of nodes. It rebalances tiers for due
access changes, compacts due leaf blocks, acknowledges their Delta rows, and
records `maintenance.batch` latency plus rows touched. Defaults are centralized
in `src/integration/config.ts` and may be overridden with
`NMG_MAINTENANCE_WRITE_THRESHOLD`, `NMG_MAINTENANCE_ACCESS_THRESHOLD`, and
`NMG_MAINTENANCE_NODE_LIMIT`. A separately bounded semantic phase runs on the
first daemon backlog check and then every configured number of productive local
batches (`NMG_MAINTENANCE_SEMANTIC_EVERY`). It expires a limited number of STG
records, reconciles a limited number of independently observed relation pairs,
and generates—but never automatically accepts—a limited number of topology
proposals. Failed slices leave durable counters intact for a later retry and
never turn a successful `remember` into a failed write.

The due check is deliberately a dual trigger. A single hot node is selected as
soon as its own write or access counter reaches the corresponding threshold. If
many sparse nodes keep every local counter below the threshold but their global
pending total reaches it, the same bounded slice selects the largest then oldest
non-empty node backlogs. The resident service schedules another bounded slice
while a full `nodeLimit` batch was consumed, so pressure falls below the global
threshold without an unbounded synchronous pass. A below-threshold tail remains
deferred; it is bounded rather than permanently growing. This preserves local
Huffman-style rebalancing while preventing small-node graphs from starving Base
compaction.

Topology proposal acceptance remains an explicit semantic review. Edge
stability can justify reversible relation consolidation or demotion, but it
cannot establish node identity and therefore cannot authorize a node merge.

SQLite is authoritative and should own transactions, content hashes, version
markers, dirty queues, FTS, and crash recovery. NMG decides semantic grouping,
summary invalidation, and topology changes. A process-local contiguous
`Float32` matrix may cache active record, node, or leaf embeddings; it is
disposable and rebuildable from versioned binary vectors in storage.

Per-model record, node and leaf embeddings persist one little-endian Float32
payload in `vector_blob`; `vector_json` is an empty `[]` compatibility placeholder,
not another export format. Legacy JSON-only rows remain readable. The first
writable migration backfills missing binary values and removes duplicate JSON
only when binary byte length matches declared positive dimensions. All three
tables and the completion marker commit atomically; a completed migration does
not rescan them at every open. Preferred-vector queries return one storage form;
pure FTS retrieval neither joins nor decodes embedding payloads. Binary-aware
readers remain compatible; JSON-only integrations must use stored-embedding APIs
or decode the BLOB. No page-size/durability change or `VACUUM` accompanies migration.

Immediate record-vector scoring may borrow a Float32 view only on little-endian
hosts, for a four-byte-aligned complete payload backed by a private, non-resizable
ArrayBuffer. Cosine similarity consumes it synchronously: it must not escape to
public results, caches or async work, or survive WASM memory growth. Other payloads
retain decoder precedence and fallback. Public stored-vector readers still return
independent ordinary arrays. Stored bytes, precision, candidate selection and
ranking weights do not change.

Lexical `memory_fts` is contentless-delete FTS5. Postings, positions and BM25
document sizes remain without another full-text copy. History content and memory
statements remain independent authorities even when bytes match. Han bigrams,
recall triggers and contentless surface trigrams retain their transformations.
`memory_fts_registry.lexical_rowid` maps lexical rows to stable memory IDs; the
registry rowid still maps surface rows. Migration preserves both rowid orders,
rebuilds once from authority and commits indexes, registry schema and format
markers in one savepoint. Refresh updates both indexes and mappings atomically.
Deleted memories are not reindexed on reopen; dormant/restored records follow
storage state. Current read-only queries support legacy full-content tables
without migration and resolve the small registry after writer upgrade. Older
executables/SQL using `memory_fts.memory_id` for reads or deletes are incompatible:
upgrade readers/writers together or adopt registry-aware queries. Binary-vector
support alone is insufficient. FTS migration changes no page size and performs
no automatic compaction.

The same authority boundary applies to write-time candidate acceleration. An
optional process-local per-scope index may retain raw and normalised statements,
pre-tokenised terms, current status and stable memory IDs. It exists only to avoid
repeating exact, near-duplicate and supersession candidate scans; SQLite is still
the source of truth. The index is built lazily, updated after successful writes,
and invalidated when rollback, deletion, retention, expiry or node transformation
makes an incremental update uncertain.

`rememberMany` is an ordered transaction primitive, not an unordered bulk loader.
Each item observes earlier writes in the same transaction so duplicate and state
replacement semantics remain identical to repeated `remember`; one failure rolls
back the batch. Callers may batch memory writes while retaining a distinct history
session model. They must not reuse a memory `sessionId` merely to group evidence,
because that field controls STG ownership and retrieval visibility.

The resident daemon exposes this primitive as the additive, capability-negotiated
`rememberBatch` RPC (`batch-remember`) without changing the protocol compatibility
epoch. A request is bounded to 512 items and must target one physical LTG or
session-owned STG store, which preserves one-transaction rollback and ordered
deduplication. Interactive Agent writes stay on single `remember`; integrations
use the batch RPC only at natural bulk boundaries. Pi uses it when replaying the
crash-safe session-archive staging backlog in chunks of 32, deleting a staged file
only after its whole chunk commits. It falls back to sequential idempotent writes
when connected to an older same-epoch daemon that does not advertise the optional
capability. Session shutdown itself remains a latency-sensitive single write.

ANN is optional. It must not replace exact vector scanning until exact-vs-ANN
recall audits show acceptable quality at a scale where exact scanning violates
the latency budget. Current near-duplicate tests and the LoCoMo record-vector
run do not justify enabling the prototype USearch path or a separate vector
database by default.

Long-lived storage adds two lifecycle states after the indexed cold tier:

```text
L0 Hot -> L1 Warm -> L2 Cool -> L3 Cold
        -> L4 Dormant/Unindexed
        -> L5 Quarantine
        -> physically deleted
```

L4 retains authoritative content and minimal lookup metadata but removes the
record from normal FTS, vector/ANN, automatic recall, recommendations, and
Active Graph construction. It remains addressable by stable ID and explicit
archive search. Embeddings and other rebuildable caches may be discarded.
Explicit reuse does not have to promote a record immediately: repeated use, an
active project, or a user restore request can return it to an indexed tier and
rebuild the necessary indexes.

L5 is a deletion-candidate zone, not an ordinary memory tier. A record enters it
only after a further retention interval and a dependency/protection review. It
is invisible to retrieval during a configurable recovery window, after which
its content and dependent indexes may be physically purged. Eligibility must
combine age, time-decayed use, importance, lifecycle state, and dependency
coverage; access count alone is insufficient. Pinned memories, current states,
critical constraints, conflicts/exceptions, user-protected records, active
references, and sole evidence for a surviving conclusion are not automatically
eligible.

Normal retention cleanup follows `indexed -> dormant -> quarantine -> purge`.
An explicit privacy deletion may bypass the recovery window and must propagate
through evidence links, summaries, FTS/vector/ANN entries, caches, and learned
signals. In the initial implementation these states may remain rows in one
SQLite database; physical cold partitions are an optional future optimization.
History is immutable while retained, not guaranteed to be retained forever.

The current store implements these states as
`memory_records.storage_state = indexed | dormant | quarantine`, independently
of retrieval `tier = 0..3`. `setMemoryStorageState` performs explicit
transitions: entering L4/L5 removes FTS, record embeddings, pending index
deltas, leaf membership, and in-memory vector-cache entries; restoring to
`indexed` rebuilds FTS immediately and queues rebuildable semantic indexes.
Stable-ID `getContext` remains available for L4/L5 recovery. The conservative
`retentionCandidates` API is dry-run only and protects STG records, preferences,
states, constraints, contradictions/exceptions, marked records, high-value or
frequently used records, and evidence with surviving derivations. Automatic
purge is deliberately not implemented.

Retention protection and resident injection are distinct. A record is protected
from automatic L4/L5 movement when its type is `constraint`, `preference`, or
`state`; its evidence role is `contradict` or `exception`; it supports a surviving
derivation; or it carries a `critical`, `pinned`, `protected`,
`safety_constraint`, or `user_defined` marker. This protection does not inject
the record into every prompt. The resident kernel is narrower: only active,
indexed, tier-0 constraints of importance at least `0.8`, asserted or verified by
a user/tool/system source, are eligible, and the harness still applies a small
global limit. Thus a rare safety constraint cannot disappear through heat-based
retention, while ordinary protected history does not consume permanent context.

Physical privacy erasure is a separate, explicit operation with a stronger
contract than logical withdrawal. Its implementation must run as one reviewed
job and produce an erasure receipt containing only non-sensitive identifiers
and counts. The required propagation order is:

1. compute the unsupported derived-memory closure and freeze concurrent writes;
2. remove memory/evidence links, deleting a HistoryRecord body only when no
   surviving memory, relation, or audit obligation references it;
3. remove vectors, FTS rows, leaf membership, ANN/cache entries, dirty deltas,
   claim events/posteriors, and proposals based on erased evidence;
4. delete retrieval traces that referenced the target rather than merely
   editing result arrays, because their query text may repeat the private fact;
5. invalidate and rebuild summaries, relation evidence, aliases, and empty nodes
   whose material depended on erased content;
6. reset non-subtractable learned node/edge/controller aggregates for affected
   identities and invoke adapter-specific erasure hooks for shadow logs/caches;
7. physically delete target and unsupported derived rows, then use SQLite
   secure-delete/VACUUM or encrypted-key destruction for the deployment threat
   model.

Until that full job and adapter-hook contract exist, `forget`/`memory delete`
must describe themselves as logical withdrawal. The logical path is tested to
remove normal retrieval, FTS, record embeddings, leaf membership, index deltas,
claim state, evidence links, unsupported derivations, in-process vector-cache
entries, Active Graph references, and pending evidence-dependent proposals.
