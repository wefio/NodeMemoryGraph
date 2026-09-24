# Match test fixtures to the resource an assertion observes

[中文](2026-09-24-resource-matched-test-fixtures.zh-CN.md)

**Status:** implemented
**Approved:** auto

## Problem

The four resource needs in product tests were confused with four fixed runner
partitions. A fixed schedule was slower on the current worktree, but that result
does not answer whether each resource class has avoidable setup cost.

## Decision

Choose fixtures by the assertion's observable boundary: in-process data for pure
decisions, an independent in-memory SQLite store for one-connection behavior, a
unique file database or workspace for persistence and path behavior, and real
Git/CLI/HTTP/process resources for external behavior. This choice is orthogonal
to Safety/Contract/Guardrail and narrow/full verification membership.

RCP orchestration tests that do not observe Git discovery, dirty scope, or commit
provenance inject a fixed `RepositoryProvider` observation and create no Git
repository. The tests that assert those boundaries keep the real provider and
repository. That real-Git fixture still runs `init`, `add`, and `commit`, but
supplies identity through `git -c` on the commit call instead of launching two
separate configuration processes for every fixture.

## Alternatives considered

- Treat the classes as fixed Node worker partitions. Rejected: the measured
  partition and file-order candidates were slower than the existing route.
- Use a fixed observation for every RCP test. Rejected because scope, commit,
  forge, and Git-failure assertions must exercise real repository behavior.
- Initialize Git for every orchestration test. Rejected because these tests
  consume the provider result without asserting how Git produced it.
- Share one mutable database or Git repository between tests. Rejected because
  test order and concurrent runs could then affect the result.

## Consequences

- Ten reconciliation tests retain real Git observation; eight use the fixed
  observation. Each real-Git fixture also starts two fewer Git child processes.
  The repeated file-level improvement is measured, but a whole-suite speedup
  remains unproven.
- The fixture rule guides setup only; route coverage and the 150-second result
  deadline remain owned by the verification contracts.
- Restore real Git for any fixed-observation test whose assertion comes to
  depend on Git scope or provenance. Repeal the commit-identity shortcut if a
  test needs repository-local Git identity configuration or a supported Git
  environment behaves differently.
