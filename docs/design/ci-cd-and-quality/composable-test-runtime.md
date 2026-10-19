# Composable test runtime and behavior fragments

[中文](composable-test-runtime.zh-CN.md) · [Terms used](composable-test-runtime.terms.yaml)

**Authority:** [CI and quality](../ci-cd-and-quality.md#composable-test-runtime).

## Resources and cleanup

Only `tests/support/cordis-adapter.ts` uses Cordis. It exports
`createTestRuntime()`, minimal composable effects and idempotent `dispose()`,
without NMG Core, CLI or daemon imports. `tests/support/test-runtime.ts` composes
NMG resources for integration tests:

```text
TestRuntime
├── testWorkspace
├── testDatabase
└── testDaemon
```

`withTestRuntime(...)` or explicit `dispose()` supplies RAII-style cleanup.
Dependencies are explicit: database requires workspace, daemon requires database;
missing dependencies fail rather than create hidden global state. The in-process
daemon uses the real HTTP JSON-RPC handler, testing the protocol without leaving
a background process.

Choose the lightest isolated resources that expose the assertion boundary;
[the decision](../../decisions/implemented/2026-09-24-resource-matched-test-fixtures.md)
owns this distinction:

| Assertion boundary | Resource | Preparation that can be omitted |
| --- | --- | --- |
| Pure data/decision | In-process input | Workspace, database, external processes. |
| One SQLite connection | Independent `:memory:` store | Database files and cleanup. |
| Reopen, migration, WAL, separate connection or path | Unique file database/workspace per case | Unrelated files/services. |
| CLI, Git, HTTP, daemon lease, cross-process sharing | Actual required processes, ports and workspace | Starts/checks that do not participate in the assertion. |

File/cross-process assertions retain real boundaries. Policy/receipt/harness-only
assertions may inject `RepositoryProvider` observations, with separate real Git
tests for discovery, dirty scope, commit and forge bindings. `testDatabase()` uses
real paths shared with the daemon. Git fixtures retain `init/add/commit`, passing
identity to `commit` instead of spawning two `git config` calls per case. Resource
choice neither changes Safety/Contract/Guardrail classification nor blocking or
narrow/full scope, which remain owned by routes and verification contracts.

`@deepseek-ai/cordis@4.0.1` is pinned as a devDependency for effect/fiber lifecycle
only. NMG Core, daemon, Pi adapter and released packages do not depend on it; no
loader, HMR or configuration system is adopted. Separating the adapter from NMG
fixture composition confines a framework replacement to the lifecycle adapter.

Heap-growth checks requiring explicit Node GC execute only when `global.gc` is available; otherwise `node:test` reports a skip rather than a tautological assertion. The HA no-NaN stress case and heap-growth case in `tests/core/robustness.test.ts` are separate, so missing GC does not skip the former. Run the heap witness with `node --expose-gc --experimental-strip-types --test tests/core/robustness.test.ts`. That witness does not establish leak freedom for every allocation pattern; the [execution-reporting decision](../../decisions/implemented/2026-10-13-runnable-suites-and-executed-checks.md) owns the trade-off.

## Behavior fragments

Behavior composition is separate from resource lifecycle. Scenario construction stays local to the consumer. `tests/support/task-board-behavior.ts` exports `claimAndDeliver` over an existing entry reference: delivery and retention tests pass identity, digest, lease and `now` explicitly and receive the actual delivery snapshot. Those time inputs govern only the claim and delivery, not entry creation, final handling or the entire test.

The two operations are independent writes, not atomic. Delivery failure leaves the successful claim intact and propagates the exception. Tests needing intermediate states or a single refusal call the store API directly.

`tests/support/node-graph-behavior.ts` exports `linkNodePath(store, nodeIds, relationType)`. It links each adjacent pair of existing IDs in input order and returns the actual `linkNodes` snapshots. Empty/single-node paths return an empty array without writes. Repeated endpoints, explicit back edges and repeated-edge reconnect results remain. It creates no nodes, sorts or deduplicates nothing, does not close a cycle automatically, and does not impose memory-chain DAG restrictions. Each edge is an independent write using the product clock: a later exception propagates with the successful prefix still observable, without a new transaction or rollback. Scenario construction, relation metadata writes, idempotency/evidence-merge judgments and per-edge observations stay at the consumer.

Named declarations, assertions and resource lifecycles remain; no DSL or generator is introduced. The [behavior-composition decision](../../decisions/implemented/2026-10-12-deliverable-tests-compose-behavior.md) owns the rationale.
