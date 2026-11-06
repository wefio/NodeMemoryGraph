# Rebuild both full-text indexes when the FTS5 import runs

[中文](2026-11-06-fts-shadow-id-overflow.zh-CN.md) · [Terms](2026-11-06-fts-shadow-id-overflow.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Deleting a memory failed with `Value is too large to be represented as a
JavaScript number: 9010497789624320`. The number came from an FTS5 shadow table:
`memory_fts_data.id` and `memory_surface_fts_data.id` encode a segment id as
`segid << 31`, one segment per commit, so a long-lived store drifts past
`Number.MAX_SAFE_INTEGER`. `node:sqlite` cannot convert such a rowid to a JS
number, so `DELETE FROM memory_fts WHERE rowid IN (…)` throws before the delete
happens. Every forget on that store failed, and any later write that merged
segments was at risk.

The migration that rebuilds the lexical index dropped `memory_fts` — which
resets that table's segment ids — but only ran `DELETE FROM
memory_surface_fts`. A delete leaves the surface index's shadow ids untouched,
so its segment counter kept climbing with no way to reset it.

## Decision

The format migration now drops and recreates **both** full-text tables, so both
shadow id spaces start clean. Reading the previous rowid order is best-effort:
the query against the old index throws once its ids overflow, so it is wrapped
and an unreadable index degrades to a fresh rowid assignment instead of aborting
the migration. The surface schema moves into an exported constant shared with
the main DDL, so a rebuild cannot drift from the create path.

The format marker advances, which makes every existing store run this rebuild
once on its next open. The live store was migrated in place with the same code
after a file backup; its maximum shadow id moved from `9.0e15` to `3.2e12`.

## Alternatives considered

- Enable `setReadBigInts` on the affected statements. It only covers statements
  the store itself prepares; the failing read happens inside the virtual table's
  delete path, which the store cannot annotate.
- `VACUUM` or `INSERT … VALUES('rebuild')`. Neither resets a shadow table's id
  space; only dropping the table does.
- Leave the surface index on `DELETE` and only rebuild the lexical one. That is
  the defect: the surface counter never returns to a safe range.

## Consequences

One full reindex per store on the next open after the marker change. Segment ids
return to the low hundreds, and a store needs roughly four million further
commits to reach the limit again; reaching it is repaired by advancing the
marker, which is the same path.

A store whose old ids are already unreadable loses its previous lexical rowid
order, so BM25 tie order can shift once. Everything else — terms, doc sizes,
registry mappings, evidence — is rebuilt from the source rows.

## Deferred

Nothing schedules a proactive rebuild before the limit is reached again. The
repair path exists but only runs when the marker changes.
