# Controlled daemon code reload

[中文](2026-10-13-daemon-controlled-reload.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [State entry](2026-10-12-state-space-entry.md)

## Problem

Reloading a host extension does not replace a resident daemon's loaded code.
Uncoordinated stop/start lets other clients race to create a replacement and
can obscure whether accepted work finished. Replaying a mutation after a lost
response can duplicate work.

## Decision

The user accepts explicit process replacement with volatile AG state and writer
leases cleared. `nmg daemon reload` acquires an exclusive handover gate, requires
the live owner's `controlled-reload` capability, drains accepted calls and waits
for that owner to exit. Only its ticketed child can acquire the daemon lease
during handover. Success requires the replacement's authenticated ready handshake.

Clients wait for handover, rediscover endpoint and capabilities, and do not
claim ownership of the controller's replacement. Connection failures after
dispatch retry reads only; uncertain mutations report an error without replay.
Legacy administrative restart remains distinct.

The normative boundary, recovery conditions and verification are owned by
[daemon lifecycle](../../design/daemon-lifecycle-design.md#controlled-code-reload).

## Alternatives considered

- Rename restart to reload: rejected; that supplies neither drain nor handover fencing.
- In-process module hot loading or AG/lease migration: rejected for this slice;
  the accepted boundary permits clearing volatile state and avoids preserving
  old executable code and authority across a partially migrated service.
- Automatically replace an old daemon when a capability is missing: rejected;
  a shared owner is not a client's disposable resource.
- Automatically delete malformed or abandoned handover gates: rejected;
  absence of reliable owner identity is not permission to create a second owner.

## Consequences

The command loads the current built entrypoint and preserves durable SQLite data;
it does not rebuild source, preserve volatile sessions, or promise uninterrupted
availability. Handover and readiness have explicit deadlines. Failure is not a
successful reload. Drain failure reopens the original service; a failed
replacement is not silently claimed healthy or rolled back to an old binary.

The first upgrade from a daemon without controlled reload still needs a safe,
coordinated lifecycle boundary. No shared production daemon is stopped by the
isolated unit, HTTP and real-process tests.

## Deferred

- Migrating AG, writer leases or other process-local state.
- In-process module hot loading, automatic code watching and cross-version handover with old startup binaries.
- Automatic recovery of an orphaned handover gate after a killed controller.
