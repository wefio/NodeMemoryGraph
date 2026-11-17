# Rehearse graph migration before changing the memory default

[中文](2026-11-14-legacy-memory-convergence.zh-CN.md) · [Terms used](2026-11-14-legacy-memory-convergence.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [architecture direction](2026-11-05-unified-architecture-direction.md)

## Problem

The two memory paths have different domain behavior and physical schemas.
Recreating old memories as new writes would lose identities, references and
historical relationships. Local coordination has an independent lifecycle even
where it shares the same SQLite file.

## Decision

Converge domain rules in slices and exercise a consistent legacy graph snapshot
against both backend contracts. Retain identifiers and publish the rehearsal in a
single commit. The full local SQLite rehearsal uses a dedicated import into an
empty namespace on a copy, with existing audit records, state aliases and file
reference rows. Keep SQLite-specific queries and row decoding in
SQLite code. Route local coordination through explicit board/run/activity ports
while retaining the shared SQLite file for pure-local use.

Select the local SQLite engine through an activation record published in the
same transaction as graph import and the legacy write fence. The record belongs
to the physical SQLite file. A project opened through a different daemon keeps
its existing namespace and memory identities. Codex state and disclosure use the shared session
runtime and project recall reads the unified backend.

SQLite carries record vectors across activation with their model identifiers
and references the retained node/leaf projections. The engine fuses results
through a vector-candidate port. The host owns provider calls and bounded
indexing work, and SQLite writes vectors after that I/O returns.

## Alternatives considered

- Replay legacy statements through remember, which allocates new identities and applies current write policy to historical data.
- Switch the default as soon as basic get and search work, before testing migration, feature parity and recovery.

## Consequences

The opt-in [rehearsal and comparison](../../design/unified-architecture/legacy-graph-migration.md)
cover the bounded cross-backend graph and the full local copy. All local memory
entry points use MemoryEngine. First use backs up and migrates a legacy SQLite
file. The migration command accepts the main file and selected projects together.
Original tables support recovery, chain projection and vector hierarchy queries.
