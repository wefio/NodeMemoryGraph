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
| Admission and write defaults | Service applies admission, records rejected writes and unsafe bypass, sets truth defaults. Store normalizes markers and derives provisional residence. | Shared admission, marker and default-residence rules. Accepted writes publish with their audit event. Policy rejection records a separate metadata-only event. The full SQLite snapshot imports original audit records. |
| Evidence | History rows, source-message dedupe by session, primary evidence and additional links. | Preserves cited IDs. Writes reuse the same session and source-message pair, and reject different content or actor at that identity. |
| Deduplication and state | Scoped SQL exact match, normalized recent candidates, optional duplicate judgment, near-match suggestions, scope-aware state-key aliases and state replacement. | Normalized exact matching, scoped state replacement, update evidence role and application of imported aliases. Alias inference, candidate policy and temporal boundary cases are open. |
| Node identity and graph | SQLite graph tables with node redirects, merges/splits, evidence and relation metadata. | Node/edge payloads and bounded expansion. Reuses active LTG node IDs by name, including imported IDs. Spelling variants, provisional-node identity, topology transforms and retrieval semantics still differ. |
| Retrieval | Native SQLite candidate queries and indexes, with scope/actor and time filters, vector/FTS, AG and history. | Lexical retrieval and exact get, with historical results on request, node/actor filters, scope/tier/session constraints and graph expansion. Event-time windows, supersession-aware ranking, embeddings and host automatic recall still differ. |
| Lifecycle and surrounding records | Deletion, markers, promotion, retention, chains, tesserae, feedback, session data, audit, and projections. | Withdrawal and current visibility. The full SQLite snapshot imports existing file references and the engine returns attachments to visible results. File relocation, standalone file search, new attachments, promotion, retention, chains, feedback and projections remain legacy responsibilities. |
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

## Full SQLite copy and recovery

On a local copy, pass `{ fullSqlite: true }` to the snapshot reader and use
`SqliteMemoryBackend.installLegacySnapshot(entities)`. SQLite installs the graph,
alias, audit and file-reference rows in one transaction in a fresh namespace.
Existing legacy evidence and predecessor links keep their original IDs and
session provenance. Retrieval still checks the session of the memory returned,
and new links use the engine's access checks. Dormant and quarantined rows, node
redirects, and dangling graph references still fail installation. Original
SQLite tables, including coordination and derived indexes, stay in the copy.

On 2026-11-15, rehearsal on online backups of the owner's main SQLite and project
STG compared 1,249 and 3 memory IDs respectively. The paths agreed on all 982
visible results and their primary evidence. The owner copy contained 4,582
imported entities, including 1,326 audit events and 46 file references. Exact
reads returned all 45 references belonging to active memories. The remaining
reference belongs to a deleted memory. The rehearsal checked installed
entity payloads, an engine write followed by close/reopen, receipt replay,
restoring a backup taken after the write, and board access on the restored file.
The migration test also aborts an insert midway and verifies an empty target
before retrying.

## Local default after activation

On a stopped local daemon, `nmg daemon migrate --db FILE --json` takes the
daemon lease and makes an online SQLite backup beside the database. It imports
the graph, fences legacy graph writes and publishes the local namespace marker
in one SQLite transaction. Regular daemon starts and direct local CLI calls
automatically use the marked namespace. The main file continues to hold Task
Board and local run data. Existing project STG files are converted atomically on
first use in this profile. A project-scoped read against an absent STG uses the
shared database.

The Codex hook uses the shared session Active Graph runtime for state and
begin-disclosure, and queries the unified engine for project and shared memory.
Exact reads and versioned answer attribution use the same session visibility.
The real-copy rehearsal verified prompt submission, answer attribution,
legacy write refusal and recovery of a subsequent memory write and a board
entry from the same SQLite backup.

Activation selects the [local unified profile](native-backends.md). It provides
lexical recall and existing file attachments. Vector retrieval, independent file
search and relocation, chains and legacy maintenance methods remain on the
legacy profile. The activated daemon publishes its supported methods. A backup
made after activation restores the selected profile and its new writes.
