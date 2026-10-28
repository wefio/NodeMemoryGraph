# Stopping rules for the append-log write path

**Status:** draft
**Created:** 2026-10-28

Companion to [Add as an immutable log entry](add-append-log-and-fold-design.md) and
[the pending counter's states](add-log-pending-counter-state.md). Those own the design;
this page owns **when the work stops**.

## Why this page exists

The first four review rounds each produced a real defect, and each was treated as
blocking. That loop had no termination: a reviewer cannot know what counts as
"finished" unless the owner writes it down, and an owner who accepts every finding as
blocking has no answer to "how much is enough". The cost is not the fixes; it is that
a class-A correctness issue and a missing metric queued in the same line.

## Defect classes

**A — blocking.** The only class that stops a slice. It can make already-accepted data
unsearchable, duplicated or lost; make a `200` claim something untrue; or make a
rollback unsafe. Every defect found so far is class A: the fold that iterated objects as
strings, the decrement that ignored retired entries, the zero that never reached the
manifest, the double subtraction, the entry written before its counter, the failed write
read as "did not land", the reset hand-off that dropped the count, and the window that
updated after truncation.

**B — recorded, not blocking.** Performance, observability, error wording, missing
fields: an extra listing per fold, `/capacity` byte accounting, per-phase timings. It
gets a written follow-up and an owner, not a slice.

**C — decided as out of scope.** Recorded so nobody re-proposes it:

- fault injection for a physically failing object write, beyond the fake bucket that
  already proves the three-state selection;
- a formal proof of the manifest CAS under concurrency (the design relies on retry);
- stale entries above 32 on the read path (bounded by `SCAN_FACTOR`, and self-healing
  because the reset hand-off carries their count into the fold trigger);
- latency tuning across regions.

## Slice 1 — the code lands, `NMG_ADD_MODE` stays `sync`

All five must hold:

1. the `onlion` CI job is green;
2. `verify:static` is green, including the complexity cap on the files touched here;
3. the state table covers every transition and names the function performing it;
4. the most recent review round found no class A;
5. production behaviour is unchanged — `sync` remains the default.

## Slice 2 — the default becomes `log`

1. a 16-way concurrent Add burst is measured, and the `log` p95 is below the `sync`
   p95; both numbers are recorded in the decision record, not asserted from theory;
2. `/admin/fold` answers 200 for the user before a code rollback, so the runbook step is
   executable rather than aspirational;
3. the switch is one setting and is reversible;
4. one review round after the switch finds no class A.

## Round cap

Two consecutive review rounds that find only B or C finish the slice. Findings after
that are follow-ups with an owner and do not block. A finding that claims to block must
name the class-A property it breaks — data visibility, honesty of a `200`, or rollback
safety — because "it could be better" is class B by definition.

## Accepted, known risks at slice 1

- a write that fails on a real store is only exercised with a fake bucket;
- concurrent folds are serialized by the manifest CAS, assumed rather than proven;
- the read window scans `4 × 8` keys, so a large stale generation delays but does not
  permanently hide current entries.
