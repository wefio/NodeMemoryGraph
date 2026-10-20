# Store ownership, operation ports and borrowed read views

[中文](store-ownership-operation-ports-and-borrowed-views.zh-CN.md) · [Terms used](store-ownership-operation-ports-and-borrowed-views.terms.yaml)

**Authority:** [Parent scope](../lifecycle-and-integration-prerequisites.md).

## Store ownership, operation ports and borrowed read views

| node | obligation | state | evidence |
| --- | --- | --- | --- |
| D1 | Only the owner opens, migrates, checkpoints and closes a Store | proven | Product clients use daemon operations rather than its Store (D13/D14); the Store owner drains accepted calls and closes it (D8); the offline read-only handle is owned by the host that opens it (D6). Borrowed ports expose no close (D2). D7's round-specific proof is retired; the research runners remain separate Store owners (D14). |
| D2 | A port exposes no raw connection, SQL, transaction control or `close()` | proven | `RoundQueryPort` and `TransactionPort` in `src/integration/ooo-board.ts`; `tests/integration/ooo-round-query.test.ts` |
| D3 | A write inside an open transition without a port is refused | proven | `tests/core/store-transaction-port.test.ts`; the case `a write entry reached inside a transition without a port is refused, not nested` states it, and it also asserts that the refused write left nothing behind; the tooth `nested-write-transaction-is-allowed` was retired on 2026-09-24 |
| D4 | status's borrowed view migrates nothing, publishes nothing, initialises nothing | proven | `tests/integration/ooo-round-query.test.ts`; mutant `the-status-read-path-opens-the-rounds-store` (the mutant opens the writer's path, and the suite catches it) |
| D5 | The two read paths agree on the same facts and the same evaluation time | proven | `tests/integration/ooo-read-paths-agree.test.ts`. The comparison is no longer vacuous: the case accepts a task through the round's own host-verified path first, then requires both paths to report the same acceptance _and the same artifact bytes_. Mutant `the-offline-reader-decides-acceptance-on-its-own` (the borrowed port answers `{}` from its own rule; caught) |
| D6 | A read-only open is protected by the handle, not by `query_only` | proven | `tests/core/store-readonly-open.test.ts`; the case `a read-only open neither creates, migrates nor writes` states it - the refusal, the missing file that was not created, and the unchanged hash of the store; the tooth `the-read-only-factory-opens-a-writable-handle` was retired on 2026-09-24 |
