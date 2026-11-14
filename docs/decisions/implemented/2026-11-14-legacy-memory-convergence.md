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
single bounded commit. Keep SQLite-specific queries and row decoding in
SQLite code. Route local coordination through explicit board/run/activity ports
while retaining the shared SQLite file for pure-local use.

## Alternatives considered

- Replay legacy statements through remember, which allocates new identities and applies current write policy to historical data.
- Switch the default as soon as basic get and search work, before testing migration, feature parity and recovery.

## Consequences

The opt-in [rehearsal and comparison](../../design/unified-architecture/legacy-graph-migration.md)
verify one graph slice. Full migration and behavior gates govern a subsequent
default switch and retirement of the old memory mixins.
