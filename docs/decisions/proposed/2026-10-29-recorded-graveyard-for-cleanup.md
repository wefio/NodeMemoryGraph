# A recorded graveyard for cleanup the commit could not finish

[简体中文](2026-10-29-recorded-graveyard-for-cleanup.zh-CN.md) · [Terms](2026-10-29-recorded-graveyard-for-cleanup.terms.yaml)

**Status:** proposed

## Problem

Cleanup of superseded partition snapshots happens **after** the manifest compare-and-swap
succeeds, because a key may only be deleted once the manifest that stopped referencing it is
durable. That leaves three ways to leave an orphan with no name:

- the function is killed after the commit and before the delete (the platform ceiling, a
  restart);
- a delete fails and the caller's `.catch(() => {})` swallows it;
- the delete is now batched at the provider's 1000-key limit, so a later batch can fail after
  earlier ones succeeded - a **partial** cleanup that reports nothing and names nothing.

None of these is visible from the manifest, which is the only thing a later request reads. The
invariant that matters - every key under `parts/` is referenced by the manifest - holds only
during a quiet period with no crash and with every delete batch succeeding, which is exactly the
condition an incident violates.

## Proposal

Record the doomed keys in the manifest before deleting them, so a failed delete has a name that
survives the request.

1. **Order: record, then delete.** The keys are appended to `manifest.graveyard` inside the same
   CAS that stops referencing them. Deletion of the previous graveyard happens **before** that
   CAS, on the keys that are in neither the new `parts` nor the new `graveyard` - and never on
   keys written by this same commit, or the drain would eat what it just recorded.
2. **A failed delete stays named.** Whatever could not be deleted remains in the new
   `graveyard` and is carried to the next commit at no extra round trip. Retries are idempotent,
   and a rival cannot reference our graveyard keys, so re-deleting is safe.
3. **Never delete doomed keys before the CAS.** Tempting - they are not in the new manifest - but
   a retry's content fingerprint can still point at one of them, and the committed manifest would
   then reference an object that no longer exists. The drain before the CAS is a different shape
   with the opposite conclusion, and the reason is worth keeping: graveyard keys come from
   **earlier requests**, so they can never appear in this request's `reuse`, while staged keys
   **belong to this request** - which is exactly why deleting a staged key also has to remove it
   from `reuse`. Same appearance, opposite answer, different reason.
4. **Bounded, newest first.** The field has a cap; over the cap, drop the **oldest** entries and
   keep the newest, because the newest are the ones a partitioned delete just failed to remove.
   An unbounded field would grow the manifest without limit under contention.
5. **A corrupt graveyard never blocks service, and is not blindly overwritten.** On read, a value
   that is not an array, or one longer than the read cap, is **skipped** (no drain this request)
   and counted, never sliced - slicing would drop keys from the cleanup list and manufacture the
   leak this record exists to prevent. Writing does not simply overwrite, because a partially
   corrupt value can still contain valid keys: a value that is not an array contributes nothing, an
   array contributes the entries that are non-empty strings, and everything else is dropped and
   counted as `graveyard_dropped_unparseable`. The salvaged keys, this commit's doomed set and the
   carried-forward remainder are then unioned, filtered against the new `parts` - a graveyard entry
   that is also a live part is a contradiction, and the next drain would delete live data -
   deduplicated, capped newest-first (drops counted as `graveyard_dropped_cap`), and only then
   written. Overwriting outright would discard keys that were perfectly parseable, which is our own
   leak rather than the corruption's. `/add`, `/search` and `/capacity` keep serving regardless of
   what the field contains.
6. **The counters ride the channel an operator already reads.** `userCapacity` returns
   `pending_entries` and `manifest_bytes` per user and already raises `warnings` at 80% of a
   limit, so `graveyard_pending`, `graveyard_dropped_unparseable` and `graveyard_dropped_cap`
   belong in the same object, and a non-zero drop counter raises a warning ("leaking") there
   rather than in a field nobody has a reason to look at. `graveyard_pending` measures **only
   what was recorded**; orphans created before this mechanism existed are invisible to it and
   must be measured separately.

7. **Reset keeps the names.** `resetManifestState` builds a fresh object literal, so any field it
   does not name is dropped, and `clearResetPendingKeys` only knows `parts` keys plus
   `reset.pending_keys`. A graveyard key would therefore survive a reset with nothing referring to
   it - permanently, since reclamation only sweeps other epochs - and reset is supposed to be the
   escape hatch. Reset merges the graveyard into `reset.pending_keys` (already de-duplicated there)
   and drops the field; `clearResetPendingKeys` already deletes in the same 1000-key batches, so
   this adds no new limit.

## What this does and does not establish

- It gives a **bounded and self-healing** residue, not an **immediate** one: the last batch of a
  quiet period waits for the next commit, so the invariant holds "after the last commit", not "at
  any instant".
- It does not repair orphans that already exist. A local memory-bucket soak or a one-off admin
  LIST is the only way to see those, and the two numbers must not be compared as one series.
- It does not make a stalled bucket fast; it makes the residue named.

## Rollback

During a rollback, an older writer does not know about the field and drops it while rewriting the
manifest, so keys recorded by the newer writer lose their only name. Rolling forward again does
not restore them. Storage does not shrink; the leak becomes unnamed. This is recorded here so it
is not later investigated as a new defect.

## Acceptance criteria

- **Empty state is byte-identical**: with an empty graveyard the manifest contains no
  `graveyard` key at all, so a user who never triggers the mechanism is indistinguishable from
  one written by today's deployment. `JSON.stringify` must not contain the string.
- **Availability with a corrupt field**: seed a manifest with `graveyard: "not-an-array"` and one
  with an array longer than the read cap; assert `/add`, `/search` and `/capacity` all answer
  normally, that the value is preserved until the next successful write, and that the counter is
  reported. Without this test nothing prevents a future edit from turning it back into a 503.
- **The write side is an assertion, not a description.** Feed several corrupt graveyards - a
  non-array, an array holding non-string entries, one longer than the cap, and one containing a
  key that is also a live `parts` entry - and after one successful write assert that the field is
  either absent or (an array of non-empty strings **and** no longer than the cap **and** disjoint
  from `parts`). Without this, an implementation that forgets the `parts` filter or the cap passes
  every other criterion here, and the first entry under Risks - a wrong filter deleting live data -
  stays a paragraph instead of a test. In the live-key case also assert the referenced **object
  still exists**: an implementation that deletes first and tidies the field afterwards satisfies
  disjointness while destroying live data. In the over-cap case assert **which** keys survive, not
  just the length - the newest entries and the newly doomed ones must be kept and the oldest
  dropped - because a reversed comparison passes a length-only test.
- **Record then delete**: a failed delete leaves the key in the next manifest's graveyard, and the
  following successful commit removes it.

## Risks

- **The drain deletes a live key.** The filter is "in neither the new `parts` nor the new
  `graveyard`". A mistake there destroys a referenced snapshot, which is data loss, not residue:
  this is the reason the filter is spelled out and tested before the mechanism is enabled.
- **The cap drops a key that is still referenced.** Newest-first exists to avoid it, but a wrong
  comparison could drop the newest instead of the oldest; the acceptance test has to pin the
  direction, not just the length.
- **An older writer drops the field** (see Rollback): in-flight keys lose their only name and
  never come back.
- **Manifest growth under contention.** Bounded by the cap, but the cap has to be small enough
  that 128 partitions of doomed keys never approach `MAX_MANIFEST_BYTES`.

## Companion pit: a manifest at the byte ceiling also has no way back

`commitManifest` throws when the receipt count exceeds `MAX_RECEIPTS`, and it throws the same way
when the encoded manifest exceeds `MAX_MANIFEST_BYTES`. Both are the same class as an unparseable
graveyard - a user that cannot be written to at all, repairable only by `/reset` or an admin
action - and both deserve to be recorded together rather than one being fixed and the other
forgotten. This record does not fix them; it notes that the graveyard's cap must be small enough
that it can never be the reason a manifest crosses that ceiling.

## Alternatives considered

- **A timeout heuristic** ("delete anything under `parts/` older than N") without recording: needs
  a background sweep for a scenario that has no background execution on this platform, and it
  guesses at a threshold instead of knowing which keys were doomed.
- **Delete before the CAS** so the failure window disappears: breaks retries, see rule 3.
- **Unbounded graveyard**: grows the manifest without limit exactly when writes are contending.
- **Swift at delete time rather than recorded**: batching turned a whole-batch rejection into a
  partial one; a retry-driven sweep inside the same request is what actually finishes the job.

## Consequences

- One new manifest field, written only when there is something to record, so a drained manifest
  stays byte-identical to today's.
- Cleanup costs at most one extra commit to converge, and nothing extra on the wire.
- An operator gets a number (`graveyard_pending`) that says how much recorded backlog exists.

## Scope

This is **not** part of the append-log accept slice, and not part of its gate. It changes the
manifest format, so it gets its own decision entry (this one) and its own commit boundary; it must
not land quietly inside the add-log ticket, or a later reader cannot tell which intent added a
field to the manifest.
