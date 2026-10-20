# Physical ownership of run records and the sole writer

[中文](run-record-ownership.zh-CN.md) · [Terms used](run-record-ownership.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../task-unit-semantics.md).

## Physical ownership of run records and the sole writer

The target puts non-rebuildable run facts in the current NMG daemon's SQLite database, in the same database, connection and transaction as `task_board_entries`. OoO task state is a recomputable view of those facts, not an authoritative `ooo_tasks` table. Do not create `<runDir>/store.sqlite`, cross-database state references or a reconciliation process. Use the daemon's existing database configuration; add no path setting.

The daemon is the only physical writer. The shared run coordinator is the only state-transition entry point and writes through an injected Store transaction. Runners, harnesses, workers and status/cancel clients do not open a writable database or construct their own `BoardAdmission`. Many collaborators may submit requests; they do not each write state. The coordinator does not inherit Store to gain another connection. Host model loops and check subprocesses run outside transactions and return ticket-bound facts.

New persistence has only two jobs: an immutable run manifest (the frozen existing plan, configuration and versions), and appended run facts the board cannot represent. These may use separate tables, but do not add a competing per-task current-state table. The table fixes fact ownership; physical table names follow the migration:

| Fact | Authority | Write/read rule |
| --- | --- | --- |
| `runId`, frozen plan/verification configuration, inputs and digests, retention policy | Immutable run manifest | Register through daemon Store coordination; derive dependencies from the plan. A new plan is a new run/version and cannot overwrite old input |
| Logical-task/board-entry binding, check issuance and terminal result, candidate bytes or content-addressed reference, cancellation | Append-only run facts in the same database, keyed by `runId`/sequence; task facts also carry `taskId`/`attempt` | Store only facts not derivable from manifest or board. Commit cancellation and its fence atomically. A candidate is not acceptance |
| Claim owner, lease, attempt, deliverable, independent verdict and resolution | Existing board records | Board lifecycle operations are the only writers of current board state. Managed-entry writes also pass through the same coordinated transaction; direct `judge`/`resolve` cannot bypass the run fence |
| Cost, execution-attempt observations and recovery evidence | Same append-only run facts | Host reports external results; the coordinator validates them before writing. Workers do not approve their own artifacts. Retries are idempotent and stale generations are refused. Board history may be recorded in the transaction, but board remains the authority for current state |
| Ready/blocked/accepted sets, satisfied dependencies, validity after cancellation, fusion candidates | No authoritative storage; derive from the sources above | One shared derivation serves status, next and dependency unlock. Cache if needed, but do not write independent state or repair a cache to change facts |
| Research JSONL/JSON and working-directory logs, including `run.jsonl` | File artifacts | Not authoritative state. Retired `RoundLog/round.jsonl` is historical; export failure does not roll back a committed decision |

### Transaction participation and connection lifetime

Read the complete responsibility: [Transaction participation and connection lifetime](run-record-ownership/transactions-and-connections.md).

### Shape of the run surface

Another process reaches run facts through daemon `taskRun`: `register` (register run identity; one plan per run), `freeze` (freeze the plan once; array order supplies positions; reject dangling/self dependencies by name), `bind` (bind an existing entry to a frozen task), `cancel` (cancel a run or one planned task) and `status` (read the run record). `taskBoard.put` has optional `adopt`, so creating an entry and binding it are one transition. A separate create-then-bind call could crash with an unmanaged entry between them, which is exactly the gap the fence closes.

`cancelRun` is the only writer of cancellation facts. Both write fences and dispatch derivation read them; before that writer existed, a test had to append the only cancellation state. `status` is read-only: it does not register, append, migrate, publish or derive ready/blocked/accepted. Those are a shared pure result over the same facts; deriving them again here would create the second truth this design forbids.

These additions remain within the compatibility epoch. An older daemon without `taskRun` reports the capability unavailable; it silently ignores `taskBoard.put`'s `adopt`, introduced with the same change. A client therefore sends `adopt` only when `hello.methods` advertises `taskRun` (see the compatibility section in [design.md](../design.md)). The CLI exposes the operator-facing half, `nmg run status` and `nmg run cancel`; the runner uses a daemon client for its own transitions, not new human commands.

Design the client for a server that may be blocked, not one assumed to answer. A process cannot answer its own endpoint while synchronously waiting for a child process; this is not fixed by transaction boundaries or locks. Bound `taskRun`/`taskBoard` calls and name the bound, endpoint and serving PID on timeout rather than exposing the transport's timeout. A client must not call an endpoint served by its own process: the lease PID makes that detectable. An in-process host calls `host.call(...)` (`round-host.ts`); a client that must use the wire runs in a separate process.

### Shape of the borrowed status view

The current CLI `taskRunStatus` uses typed Store reads to return the manifest, tasks, facts and bindings; it does not derive ready/blocked/accepted or expose a Store handle on the wire. The narrow query port below is the owner boundary for a future status projection, not the current `taskRunStatus` implementation. Research `BoardAdmission` has a separate `RoundQueryPort/openRoundQuery`, not the daemon `taskRun` path.

A shared-daemon status projection should use a narrow query port from the Store owner, on the current connection and shared derivation. It exposes typed reads only, never writes, the raw connection, arbitrary SQL, transaction control or `close`; constructing it creates no connection. Read-only is the caller's capability, not a switch that changes the shared connection. Do not set `query_only` on it and disrupt normal writes.

Queries must not call Store methods with migration, lazy-cleanup, lease-promotion or handoff-publication side effects. Compute expiry in the read view; a separate write entry point performs necessary cleanup. Status and dispatch read the same facts and predicates, but status does not act on pending work it discovers.

For offline inspection of an existing private research database, its owner may open a separate read-only connection and must close it. Use a genuinely read-only handle; skip migration, initialization, write PRAGMAs and close-time checkpoint. `query_only` may be an additional guard, not a substitute for read-only opening. A shared owner may provide this factory; a consumer under `src/integration` must not open a handle by path itself. The research `openRoundQuery` already opens a read-only SQLite handle for its round-specific view; it is not the daemon run-status path.

Do not turn `BoardAdmissionOptions.view` into a multi-mode initializer/executor. Compose an owner-supplied query port with an outer host that owns the connection. If `NmgStoreOptions.readOnly` implements independent read-only opening, it belongs to the owner factory, not a round ticket or caller-controlled connection switch. Cancellation uses the normal writable operation port; it must not reconstruct `BoardAdmission` to initialize a missing run as a side effect.

Refuse a missing database, missing/unsupported schema or absent requested run with distinct reasons. Do not create a database, migrate an old one or return an “empty run.” Report “run exists but has no events” only for a valid manifest, recognized schema and matching run identity. Read an old schema only with an explicit supported read rule; otherwise report unsupported rather than masking unknown fields with defaults.

Integration checks must cover both shapes: constructing/querying a shared port does not write or expose write/close capabilities, and releasing it leaves the owner able to read and write; offline read-only open does not create a missing file, migrate an old schema, write or checkpoint, and the host closes the handle it created. Both yield the same answer for the same fact snapshot and evaluation time. Mutate the independent open back to writable to prove the test catches it even if `query_only` remains; merely refusing the final write does not distinguish the guards.

### Scope and cost of recomputation

A view can be written as `derive(manifest, boardSnapshot, runFactsThroughSequence, now)`. Evaluate against one consistent database snapshot and fixed `now`, or an old claim can be combined with a new verdict. Lease expiry depends on time, so a cache cannot key only on event sequence; bind it to the fact version and invalidate it at relevant lease boundaries. Cache loss affects performance only.

Two callers may derive the same ready task, but only the daemon's atomic claim/fence check grants execution. Recompute is not concurrency control. Revalidate at commit; an earlier ready/accepted view is not a write license.

Recompute replays recorded facts; it does not call models or rerun checks to guess history. If execution was issued and the process crashed before recording its result, the result is unknown. Recover/retry only through an external idempotent query or an explicitly re-entrant operation; missing records do not prove execution never happened. Non-idempotent external operations are outside the first version.

Start with a plan-and-facts scan. If scale demands it, use a versioned in-memory cache or deletable checkpoint. Add a materialized view only after measuring a recomputation bottleneck and proving it can be deleted and rebuilt from authority. Do not copy `accepted`, `attempt` or `lease` into another source of truth to save a join.

Board TTL needs an explicit run-retention relation. A board entry referenced by a recoverable run or retained evidence must survive ordinary TTL pruning, even after resolution or round termination. Unbound entries keep their existing TTL. Once a run expires with no in-flight work or dependency references, explicit daemon GC removes references and related records in one database transaction; do not promise recovery after GC. Export history before deletion rather than keeping a stale cross-table pointer.

### Current implementation and integration prerequisites

Current research paths still own their storage: the granularity [plan-driver](../../../evals/ooo-execution/plan-driver.ts) constructs [BoardAdmission](../../../src/integration/ooo-board.ts) with `spec.databasePath` (default `:memory:`); [live-continuation](../../../evals/ooo-execution/live-continuation.ts) opens its own `NmgStoreBase`. `round-runner.ts`/`runCycle` retired on 2026-09-18 ([decision](../../decisions/implemented/2026-09-18-retire-the-round-instrument.md)). Current `ooo_probe_*` tables are partitioned by `run_id`, with a per-run channel from `roundChannel(runId)`; multi-run stores require an explicit run, while the old single-row `meta` shape is migration input only. The daemon `taskRun` surface already has `register/freeze/bind/cancel/status`, but the two research drivers do not use that namespace. Three evidence drivers ([board-worker](../../../evals/ooo-execution/board-worker.ts), [board-deliver](../../../evals/ooo-execution/board-deliver.ts), [board-judge](../../../evals/ooo-execution/board-judge.ts)) use [round-client](../../../evals/ooo-execution/round-client.ts) to reach the store served by [round-host](../../../evals/ooo-execution/round-host.ts); they refuse by name when no host is available.

Shared `acceptedFact`/`isAccepted` checks artifact digest, verdict, revision and cancellation under one rule. `BoardAdmission` uses it for both accepted queries and dependency release, and pins referenced board entries; no TTL divergence is known on that path. Daemon `taskRunStatus` returns only manifest/tasks/facts/bindings; `task-coordinator` binds entries and coordinates writes but does not automatically call `retainTaskBoardEntry`. The daemon path still needs run retention and shared status/dependency derivation. Legacy `ooo_probe_tasks` is only migration input; current research tables split manifest, facts and derived view by run. Retired `RoundLog` and `run.jsonl` are file artifacts, not atomic run authority.

Transaction and lifecycle review identified these integration facts; this documentation edit does not repair underlying code:

- `BoardAdmission.transaction()` delegates to `NmgStore.writeTransaction()`. Publication passes its live `TransactionPort` to `putTaskBoardEntry()`, which joins through `withPort()`. Managed daemon board writes likewise use `coordinateRunWrite()` and append run facts with the same port. The current implementation no longer has two independent `BEGIN`s here; future managed writes must still pass the live port.
- The retired `runCycle` early-cancel path is historical evidence, not the current runner. `plan-driver` closes its own `BoardAdmission` after `runParentCheck()`; `live-continuation` closes its own `NmgStoreBase` in `finally`. A daemon-borrowing mode must not copy local close paths; the outer resource scope must cover initialization, and each host's error cleanup must be reviewed at its actual owner.
- `submit()` awaits `afterCommit` and publishes after `commitArtifact()`. A later exception occurs after commit. The integration API must distinguish committed results from notification failure; one thrown error does not prove the database rolled back.

The current D-group status and itemized evidence are in the [task-unit-semantics obligations ledger](../task-unit-semantics-obligations.md).

The pure derived view, daemon `taskRun` manifest/facts, coordinated managed-board writes and multi-run namespace are implemented. Research-driver integration and automatic board-entry retention in the daemon run namespace remain. Keep old private runs read-only as research evidence; do not dual-write. To replay, create a new run explicitly with a new `runId`; never import an old `accepted` result as acceptance in the new run. Refuse incompatible identities or log formats by name rather than silently replaying them.
