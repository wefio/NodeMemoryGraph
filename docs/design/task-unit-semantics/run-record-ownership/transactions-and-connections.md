# Transaction participation and connection lifetime

[中文](transactions-and-connections.zh-CN.md) · [Terms used](transactions-and-connections.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../run-record-ownership.md).

### Transaction participation and connection lifetime

One connection does not imply one transaction. The Store owns transaction boundaries; a run coordinator joins one synchronous state transition, never a whole run or asynchronous RPC. This contract builds on existing `writeTransaction`, `withPort`, `TransactionPort` and `coordinateRunWrite` primitives. `BoardAdmission` and managed `taskRun` writes already have paths that join transactions; that does not mean every research runner uses the daemon namespace.

| Capability | Owner | Responsibility |
| --- | --- | --- |
| Connection creation, schema migration, checkpoint and close | Daemon Store owner; the outer host owns an offline fixture | Initialize at startup; stop and drain all users before close; creator handles exceptional cleanup |
| Synchronous write-transaction entry | Store | Sole executor of `BEGIN IMMEDIATE/COMMIT/ROLLBACK`; begin when no outer transaction exists, otherwise require an explicit valid transaction scope |
| Operation port for an existing transaction | Shared coordinator and internal board operations | Call only typed operations bound to this Store; expose no raw connection, SQL transaction control or `close()` |
| Run execution scope | Shared coordinator | Manage this run's workers/checks, subscriptions and timers; releasing them does not close a borrowed Store or remove directories the run does not own |

The Store issues a transaction port as a capability valid only during the synchronous callback, bound to its connection and current transaction generation. Refuse a port from another Store, one used after the callback, or a nested write transaction entered without a port. Do not infer permission to join from `isTransaction` or global depth.

Independent and composed board writes reuse one implementation: the Store wraps a standalone call in a transaction; a call inside a run uses the current transaction port and does not issue a second `BEGIN`. Every put, claim, deliver, judge, resolve, retention and run-fact write touched by one transition must obey this rule. Cleanup and serial promotion also stay within that boundary or use an explicitly separate maintenance transaction. Existing Store ports do not imply every board operation already accepts one; future wiring must not omit an independent entry point's transaction boundary.

The first version uses one atomic transaction, without savepoint-level partial recovery. If an inner operation throws, mark the transaction rollback-only; the outermost caller must not commit even if it catches the exception. Return an expected stale/conflict before the operation's first write, or fail and roll back the whole transaction; never hide a partial write behind an ordinary return. Only the outermost scope decides whether the transaction committed. If `ROLLBACK` itself fails, preserve the original error and quarantine the connection rather than assuming it is usable.

Callbacks are synchronous and reject Promise/thenable results. The port is revoked when the callback ends, preventing delayed writes. External verification, model calls and notifications must not hold a port across `await`. Keep the commit path: read and freeze verification input → verify outside a transaction → in a new short transaction, reread the fence/lease/cancel state and write atomically. Transaction reuse does not remove the post-verification check.

The shared runtime returns a committed result and sends notifications only after the transaction succeeds. If a notification must be delivered reliably, persist its intent in the same transaction and send it outside; a transient notification failure must not rewrite committed facts. `BoardAdmission` currently uses the committed artifact row as the reconstructible source for `publishReady()` and republishes on restart/retry. If a caller did not receive a response, query/retry with the same identity; do not rerun the worker. An `afterCommit` hook has post-commit observation semantics; its exception does not mean the database rolled back.

Use one outer-owner/inner-borrower path. In shared mode the daemon creates the Store and passes a no-`close` operation port to the run; an offline host first creates its own Store, calls the same run entry point and closes it in an outer `finally`. Do not spread `ownsStore` branches through the run. Normal return, initialization failure, early cancellation and check exceptions all go through each resource owner's cleanup; add each resource to that scope immediately after successful creation. Constructing a borrowed status view does not migrate a schema, publish a handoff or write to initialize a run as a side effect of querying.

Daemon shutdown should stop accepting work, cancel/fence in-flight attempts, revoke subscriptions and await asynchronous Store users, complete any synchronous transaction already started, then checkpoint/close once. An external process that cannot be stopped must lose database-write capability; the closed run scope rejects its late result. The current service drain/close boundary covers daemon request lifetimes, not cancellation or fencing of external workers. This ordering must be coordinated by the daemon owner and execution host; merely forbidding a borrower from calling `close` does not prevent other background users from writing after the database closes.
