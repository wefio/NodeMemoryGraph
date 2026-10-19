# Agent-independent CLI and resident service

**Authority:** [Parent scope](../product-boundary.md).

Per-adapter capability coverage is compared in the [harness capability matrix](../../harness-capability-matrix.md); an adapter entry point alone does not establish full coverage.

## Agent-independent CLI and resident service

The target integration boundary is an agent-independent `nmg` CLI rather than
direct access from a harness to NMG internals. Pi still requires a small
TypeScript extension, but that extension should translate Pi lifecycle events
and tools into a stable language-neutral protocol. It must not make the core
storage or processing implementation TypeScript-specific.

The CLI supports both one-shot administrative use and a resident mode:

```text
nmg remember ...
nmg search ... --compact-json  # agent-facing headers
nmg search ... --json          # full diagnostics
nmg get ... --active-graph-id <ID_FROM_SEARCH> --json
nmg status --json
nmg daemon start
nmg daemon status
nmg daemon stop
```

The current `activeGraphId` is not decorative continuation metadata. Agent-independent
clients must return it on exact `get` so the owning retrieval trace records
which candidates were **disclosed**. Search, injection, and exact loading are
observable exposure states, not evidence that an API model relied on a record.
Keeping them separate prevents candidate exposure from becoming
self-reinforcing positive feedback.

This remains the portable observation invariant during migration. The target
protocol renames this immutable exposure identity to `projectionId` and adds a
separate session `agId`; `get(projectionId=...)` records disclosure through the
stable RPC. An adapter may additionally record
answer-to-memory overlap, but that is provider-dependent diagnostic telemetry,
not proof of causal use and not a training label. Only auditable user
confirmation, tool-verified outcomes, and official benchmark evidence may mark
records useful/contradicted and train routing or graph stability. Labels such as
task success, evidence sufficiency, expansion usefulness, and excessive noise
depend on native answer, correction, token, and tool lifecycle events, so they
remain harness-adapter telemetry. Silence or candidate exposure is never
converted into a positive label.

For current Pi ergonomics, `nmg_remember(action="feedback")` may omit `activeGraphId`
only to target the latest retrieval owned by that same Pi session. A supplied ID
is still session-checked and remains necessary when reviewing an older graph.
This avoids fragile UUID transcription without allowing cross-session labels.

One-shot commands remain useful for people and diagnostics. Harnesses normally
connect to the resident HTTP JSON-RPC service so the bounded in-memory working set,
session/STG state, projection continuations, node directory, and hot caches
survive across calls. The daemon speaks JSON-RPC 2.0 over HTTP on an
OS-assigned `127.0.0.1` port, using Node's built-in `http` and `fetch` and
requiring no third-party transport dependencies. SQLite opens lazily on first
durable work.

The CLI is a fallback and administrative surface for harnesses without a full
adapter; it is not a requirement that every internal mechanism gain a command.
Query-internal policies such as edge activation reuse `search` and its trace
output. A dedicated command is justified only when a person or incomplete
adapter needs to invoke, inspect, or recover that operation explicitly.

Resident instances use a PID lease scoped to the selected SQLite database.
The lease records the loopback endpoint and a random bearer token. Starting a
second daemon for the same database is rejected, stale leases are recovered,
and `Shutdown` performs the normal close path. PID termination is only a
fallback when the HTTP endpoint cannot be reached.

#### Runtime ownership and concurrency contract

One resident daemon is the application-level authority for one LTG database and
for every project STG handle it has opened. Harness adapters and ordinary CLI
commands must use that daemon rather than opening a second writable `NmgStore`.
The PID lease prevents two cooperative daemons from owning the same LTG file.
SQLite WAL and `busy_timeout` provide crash recovery and bounded tolerance for
administrative or test processes; they do **not** define semantic ordering for
unsupported multi-process writers.

Inside the daemon, concurrency is phase-based rather than request-global:

- each SQLite phase is synchronous and therefore runs to completion on the
  Node.js event loop before another SQLite phase begins;
- external embedding and summary calls may wait concurrently and never hold a
  SQLite transaction across `await`;
- a search takes its database view after its query embedding returns; it is not
  a snapshot begun before the external call;
- leaf-summary writes carry a membership fingerprint and reject a result when
  the block changed in flight; node summaries deliberately accept bounded
  staleness and record the member-count baseline used by refresh hysteresis;
- maintenance runs in bounded event-loop slices. Its durable dirty/delta state
  makes an interrupted or failed slice retryable and keeps `remember` success
  independent from opportunistic maintenance.

This model permits concurrent Agent turns without holding all work behind a
slow model call, while retaining a single authoritative writer for persistent
state. Request arrival determines the order of otherwise concurrent write
phases. It does not promise distributed transactions, linearizable ordering
across independent OS processes, or parallel execution of synchronous SQLite
work. Read replicas or a worker-thread database queue remain performance options
only if measurements show the event-loop writer exceeds its latency budget.

Protocol compatibility epoch `nmg.v9` exposes the typed lifecycle, memory,
retrieval, maintenance, STG-sync, memory-chain, Task Board, run-record, Lab, and
session-Active-Graph methods declared in `protocol.ts` over JSON-RPC 2.0. HTTP is
the only resident protocol;
NMG does not maintain a parallel NDJSON or platform-specific socket API.
The lease records the compatibility epoch. Additive RPCs, optional fields, and
optional behavior do not advance that epoch. The daemon advertises them in
`hello.capabilities`; clients preserve unknown capability names for forward
compatibility, gate optional calls locally, and report a feature-unavailable
error only when the caller invokes a missing capability. Clients fail closed
only when a live daemon uses a different compatibility epoch and then require an
explicit `nmg daemon restart` at a safe coordination point; they never replace a
shared daemon automatically.
`NMG_RPC_DESCRIPTORS` is the runtime declaration source for method existence and
same-epoch optional capability gates. It derives the server whitelist, the
TypeScript method union, the client gate table, and the optional `hello.methods`
discovery list; bidirectional contract tests
reject a descriptor without a service handler or a handler without a descriptor.
The descriptor catalog is frozen for the lifetime of the daemon and has a
deterministic `sha256` fingerprint published as `hello.catalogFingerprint`.
Clients validate the complete hello shape, retain the advertised method set and
catalog fingerprint, and refresh both after reconnect. The fingerprint is only a
discovery/cache identity: a different fingerprint inside the same compatibility
epoch is not an incompatibility verdict. Optional calls are admitted only when
both the advertised method set (when present) and the descriptor's capability
gate permit them. Runtime method registration and catalog hot reload are not
implemented; adding them would first require a bounded trusted registration,
handler-ownership, and in-flight-request policy.
This automation intentionally stops at the wire declaration. Parsers,
cross-field invariants, transactions, side effects, CLI syntax, host exposure,
and epoch-bump decisions remain explicit because structural generation cannot
establish their semantics or safety.
`nmg.v5` was deliberately incompatible with v4 because the ambiguous
`recordActiveGraphUse` RPC was replaced by diagnostic-only
`recordActiveGraphAttribution`; silently connecting to v4 would lose attribution
at Agent completion and would preserve the old, unsafe training semantics.
`nmg.v6` additionally preserves `natural|controlled|legacy` provenance on claim
outcome events. Connecting the current adapter to v5 would silently discard that
optional field and contaminate natural-maintenance audits, so clients again fail
closed until an explicitly coordinated restart.
`nmg.v7` completes the memory-chain boundary with member removal, explicit DAG
edge mutation, structured edge reads, topological order, and STG session routing.
A v6 daemon exposes only the earlier partial chain API, so v7 clients do not
silently downgrade.
`nmg.v8` adds daemon-owned Lab capability leases and invocation. `nmg.v9` moves
session Active Graph ownership into the daemon and changes returned Active Graph
ids from persisted retrieval-trace ids to immutable runtime projection ids. A v8
daemon cannot preserve that ownership or feedback identity, so the epoch change
is intentionally incompatible. Further additive features remain within v9 and
negotiate by capability unless they alter established semantics, ownership,
security, or durable interpretation. An additive RPC may safely carry an
optional field that an older same-epoch daemon would ignore only when support
is discoverable from `hello.methods` and the client gates the field on the
advertised method. The run surface follows this rule: clients gate the optional
`adopt` field on a board `put` when the daemon advertises `taskRun`. Without that
gate, an older v9 daemon could create the entry while ignoring its run binding,
leaving the caller to believe the run manages it.
