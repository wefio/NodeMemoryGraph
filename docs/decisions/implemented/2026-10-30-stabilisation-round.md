# Stabilisation round: the search answer must outrun the harness client, and the provider must not hold a CAS

[简体中文](2026-10-30-stabilisation-round.zh-CN.md) · [Terms](2026-10-30-stabilisation-round.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Live logs from a concurrency-16 burst plus steady-state reads (2026-10-30 15:2x-15:31) show four
distinct faults, all visible with the new always-on lines:

| fault                                                                 | evidence                  | class                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /search answered 503 in 4.2 s                                         | 15:26 trace `2d32d910`    | a fold retired the partition objects between the search's first (and only) manifest read and its partition GETs: `snapshot_changed` has nothing to retry now that the CAS loop is gone — the read-path round lost that safety net |
| SEARCH_TIMEOUT · 504 from the harness                                 | 15:31                     | our `SEARCH_DEADLINE_MS` is 60 s; the harness client's own window is shorter than 60 s (their docs publish no figure), so our "partial at 60 s" answer lands after their timeout                                                  |
| `dependency_timeout` ×9+ at embedding host `ws-2f72...ap-southeast-1` | `nmg_failure` batch 07:22 | a provider call stalls to the 25 s cap per call; a fold's 32-chunk backfill holds the manifest CAS open the whole time (three racing chunks × 25 s), so all other Calls pile behind it and adds leak 24-30 s                      |
| 120 s kills at 914/907 MB                                             | platform feed 15:20-15:21 | the invocation pays for those stalled chunks while holding SQLite state; not addressed this round beyond removing the stalls                                                                                                      |

## Decision

1. `SEARCH_DEADLINE_MS` 60_000 → 25_000 (`NMG_SEARCH_DEADLINE_MS`). A partial answer inside the
   client's window scores; a perfect answer after it is a 504.
2. The search catches `snapshot_changed` and re-runs from a fresh manifest read, twice; the third
   failure propagates. A pure read can still race a comparator's commit — it re-bases itself, the
   same way a lock-free reader re-checks its version.
3. `EMBED_DOCUMENT_TIMEOUT_MS` 25_000 → 12_000. Two chances per fold chunk instead of one stalled
   25 s hold on the CAS.
4. Document chunks are sent `NMG_EMBED_CHUNK_CONCURRENCY`-controlled (worker default `1`): the
   fold's batch of 32 becomes three sequential 10-row calls under a saturated provider, and the
   provider's per-account queue stops being hit four-wide.
5. The `nmg_request` line gains `execution: "waituntil" | "inline"`, so a deploy that silently
   kept a stale bundle (2026-10-30 14:41: the shipped zip still had the pre-waitUntil entry
   because `dist/` retained stale chunk files) is visible in one grep, not in a 40-minute misread.
6. `build:edgeone` already clears `dist/` before packaging; the deploy checklist gains "grep the
   built entrypoint for the current capability marker" so a stale zip is caught before shipping.

## Alternatives considered

- **Retry `snapshot_changed` by deleting the fold's retires**, e.g. delay `retireParts` by
  minutes. Keeping deleted objects duplicates every snapshot the CAS's correctness depends on
  deleting; a re-read of the manifest is cheaper than a tombstone every fold's trash.
- **Raise the search deadline to keep partial answers pending.** The partial answer exists to be
  worth scoring inside the client window; waiting for it defeats the same purpose.
- **Lower the fold backfill batch instead of the chunk concurrency.** The batch (32) bounds how
  many records one fold absorbs; the chunk race is what stalls the CAS. Different parameter, same
  wrong layer.
- **Defer the fold embedding altogether via `waitUntil`** on the accept. Rejected with the exact
  numbers from the 2026-10-30 15:00 fold probe: the provider's 25 s cap currently exists under
  burst; a whole fold moved there would extend the window at the provider's pace, not ours.

## Consequences

- `search` no longer depends on writer CAS contention for safety; the read path retries its own
  reads, and the retry costs one manifest GET.
- The search deadline change is one knob (`NMG_SEARCH_DEADLINE_MS`), tunable without code change;
  the shipped default assumes the harness client window is smaller than 60 s — the platform
  docs publish nothing more specific.
- Two new env knobs documented: `NMG_EMBED_CHUNK_CONCURRENCY` and the 12 s document timeout
  default (existing `NMG_EMBED_TIMEOUT_MS` covering both members still applies first).
- The 15:26 503 class (stale-partition races) ends; a read leaves the same manifest-generation
  barrier and loses nothing to a fold.
- Restated as before: the provider's 25 s cap is the throughput ceiling for backfill; the code
  parts can no longer wait on it while holding a manifest — the worker's 25 s budget is now
  effectively the ceiling, and 120 s kills no longer fits the model.
