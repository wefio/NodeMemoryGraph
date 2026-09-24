# Use memory SQLite for single-connection store tests

[中文](2026-09-23-single-connection-store-tests-in-memory.zh-CN.md)

**Status:** implemented
**Approved:** auto
**Relates to:** [Tests do not need a filesystem](2026-09-20-tests-need-no-filesystem.md)

## Problem

`tests/core/store.test.ts` and `tests/core/store/maintenance.test.ts` created and removed a separate file database for tests whose assertions use only one connection. File setup and writes spent time on a persistence boundary those tests did not observe.

## Decision

The single-connection helper opens a fresh `NmgStore(":memory:")` for each test and closes it afterward. Tests that assert restart persistence, migration from an existing file, or an independent reader continue to create separate file databases. The test's Safety or Contract role and blocking product coverage do not change. Resource choice follows the property being asserted; it is independent of narrow/full verification scope.

The shared integration `testDatabase()` remains file-backed because the daemon and service use its path. CLI, Git, lease, and cross-process tests keep real workspaces and processes.

## Alternatives considered

- Keep every store test file-backed. This exercises disk I/O repeatedly but adds no new persistence assertion to tests that never reopen or share the database.
- Use one shared file database. This removes setup but lets records and schema state leak between tests and makes parallel runs order-dependent.
- Move every test to memory. This would erase the independent connection, restart, and migration evidence.

## Consequences

The 52 store tests passed with the original file helper in 12.153 seconds, and with the single-connection helper in memory in 9.363 and 8.706 seconds in two local targeted runs. The 55 maintenance tests passed in 2.494 seconds with a file store and 1.470 seconds with a memory store. A 40-run setup probe measured mean 0.258 ms for directory create/remove, 17.419 ms for memory store open/close, and 32.874 ms for file store open/close plus directory cleanup. These local timings are comparative evidence, not a worst-case guarantee; the [experiment](../../experiments/verification/product-file-partitions-2026-09-23.md#resource-boundary-trial) records the method.

If a test begins asserting a file, WAL, restart, or cross-connection property, move it to a unique file-backed fixture. Revert this choice if the full blocking test route fails or if file-backed behavior is left without direct coverage.
