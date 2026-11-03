# Reconcile legacy tessera migration atomically

[中文](2026-10-28-atomic-legacy-tessera-migration.zh-CN.md) · [Terms used](2026-10-28-atomic-legacy-tessera-migration.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

The legacy rename skipped `anchors` whenever `tesserae` existed, and the rename and marker update were separate statements. A failure or a mixed schema could leave records or references outside the current path. The original marker also used `anchorId`, which differs from the current `tesseraId`.

## Decision

The [tessera design](../../design/memory-tesserae-design.md) owns the migration contract. Copy nonconflicting legacy rows, preserve matching current rows, refuse mismatches and unsupported legacy columns, and repair marker type and ID in one savepoint. Remove legacy tables only after the safe merge inside that savepoint. The ordinary schema path builds or repairs FTS after the savepoint.

## Alternatives considered

Leaving both tables or choosing a winner silently can hide records or overwrite a different bookmark. Refusing every mixed schema leaves safe disjoint rows inaccessible. A separate manual migration would delay automatic recovery for nonconflicting stores.

## Consequences

A true ID conflict or unknown legacy column stops writable open and requires an explicit reconciliation. Read-only inspection remains available. The migration does not define a winner or delete conflicting data. FTS recovery remains a later schema step, so interruption between the savepoint and that step relies on the next writable open.
