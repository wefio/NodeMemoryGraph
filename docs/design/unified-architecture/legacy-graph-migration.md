# Legacy memory convergence and graph migration rehearsal

[中文](legacy-graph-migration.zh-CN.md) · [Terms used](legacy-graph-migration.terms.yaml)

**Status:** current
**Authority:** [Unified architecture](../unified-architecture.md#validation-and-migration-gates)

## Behavior and data comparison

The legacy path is `NmgService` → `NmgStore` and its write, retrieval, graph,
and maintenance mixins. The explicit profile routes memory through
`MemoryEngine` → `MemoryBackend` → SQLite or LanceDB.

| Responsibility | Legacy path | Unified engine and remaining difference |
| --- | --- | --- |
| Admission and write defaults | Service applies admission, records rejected writes and unsafe bypass, sets truth defaults. Store normalizes markers and derives provisional residence. | Shared admission, marker and default-residence rules. Both service profiles return `WRITE_REJECTED` for secrets in structured evidence. Engine marks bypass. Legacy audit events and full write metadata parity still need work. |
| Evidence | History rows, source-message dedupe by session, primary evidence and additional links. | Evidence entities and links in memory payloads. Rehearsal preserves all cited IDs. New evidence still needs equivalent source-message reuse and conflict handling. |
| Deduplication and state | Scoped SQL exact match, normalized recent candidates, optional duplicate judgment, near-match suggestions, scope-aware state-key aliases and state replacement. | Normalized exact matching, scoped state replacement and update evidence role. Alias state and inference, candidate policy, and historical/temporal boundary cases are open. |
| Node identity and graph | SQLite graph tables with node redirects, merges/splits, evidence and relation metadata. | Node/edge payloads and bounded expansion. Reuses active LTG node IDs by name, including imported IDs. Spelling variants, provisional-node identity, topology transforms and retrieval semantics still differ. |
| Retrieval | Native SQLite candidate queries and indexes, with scope/actor and time filters, vector/FTS, AG and history. | Current lexical retrieval and exact get, with scope/tier/session constraints and graph expansion. Backend ranking can vary. SQLite FTS, index maintenance and SQL stay with the SQLite implementation; the engine owns semantic filters and graph rules. |
| Lifecycle and surrounding records | Deletion, markers, promotion, retention, chains, tesserae, feedback, session data, audit, and projections. | Withdrawal and current visibility. Rehearsal transfers domain rows only. Lifecycle behavior and dependent records need migration or an explicit compatibility path. |
| Physical layout | `memory_records`, `memory_nodes`, `history_records`, `memory_evidence_links`, `node_relations` and auxiliary SQLite tables. | Native SQLite namespace/entity/FTS tables, or Lance entity data plus published head. Both encode node, memory, evidence and edge domain values with the original IDs on import. |
| Local coordination | Task Board, run, events and activity in SQLite behind the store. | Service and orchestration see narrow coordination ports. The existing local SQLite implementation remains the owner. When SQLite also holds memory, both sets of tables use the same file. |

## Rehearse the domain graph

On a disposable copy of a current legacy SQLite file, call
`readLegacyMemorySnapshot(path)` from `src/core/store/legacy-memory-snapshot.ts`.
Its read transaction pins a snapshot without initiating schema upgrades or writes.
Pass the returned entities and a fresh backend namespace to
`importMemoryGraph(backend, entities)` from `src/core/memory/graph-import.ts`.
Use either `SqliteMemoryBackend` or `LanceMemoryBackend`. The SQLite
rehearsal can use the same disposable file as the source and its Task Board.

The rehearsal fits in one atomic publication of up to 512 entities. It preserves
IDs, node and edge values, primary and additional evidence, row timestamps,
status, supersession and in-graph references. It rejects dangling references,
cross-session references to private evidence or memories, dormant/quarantined
rows, node redirects and an already-populated target. Repeating an identical
snapshot acknowledges the same publication. Coordination and auxiliary tables stay
outside the import. This is a bounded library exercise on trusted data.

The [migration contract tests](../../../tests/core/legacy-memory-migration.test.ts)
read back imported payloads from both implementations, check current state
visibility and session isolation, follow the original edge, and append a successor
to a migrated state at its original node. They also read the original Task Board
after import and check that the source graph remains readable with the same data.
Lance exercises native local objects for this migration. The backend has a
separate S3 protocol fixture.

## Default-entry criteria

Resolve the behavior differences above, including all default entry point
capabilities, and verify parity against representative legacy databases and
project/session STG stores. Extend rehearsal to production-size data and
auxiliary records, and verify restart, source write fencing, and recovery
after new writes under the [migration gates](../unified-architecture.md#validation-and-migration-gates).
After those checks, switch the default entry point and remove mixins after
their remaining callers have migrated. The opt-in profile can be exercised
independently of those steps.
