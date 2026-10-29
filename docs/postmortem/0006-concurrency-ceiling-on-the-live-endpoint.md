# 0006 - The submission fails before the first question: concurrency ceiling on the live endpoint

[中文](0006-concurrency-ceiling-on-the-live-endpoint.zh-CN.md) · [Terms used](0006-concurrency-ceiling-on-the-live-endpoint.terms.yaml)

**Status:** open

## Executive summary

Seven scored attempts in one day never produced a score, and none of them failed inside the
retrieval logic. Measured on the deployed endpoint from a clean network, the service answers
every request at concurrency **1** and **2**, and stops doing so at **4**: 7 of 24 Adds died at
the 120 s invocation ceiling and the median Add went from 2.6 s to 106 s. At **16**, five of
thirty-two connections never completed at all.

The harness probes `/health` before it starts, so a single connection failure voids the attempt
before any question is asked - which is what the two `PARTICIPANT_ENDPOINT_UNAVAILABLE` results
were. Two further attempts earlier in the day were `SEARCH_TIMEOUT · HTTP 504`, produced by this
same mechanism one layer down: a request that runs to the platform ceiling.

The operating decision is to **run with concurrency 1**. That is a choice to trade wall-clock
time for a run that finishes, because a voided attempt costs everything and a slow one costs
minutes.

## Summary

Three independent limits, each sufficient on its own:

1. **The write path redoes multi-megabyte work per CAS attempt.** An Add reads the user
   manifest, reads and rewrites a partition of up to 8 MiB, and retries up to twelve times when
   a rival writer wins the compare-and-swap. Concurrency does not help this: the writers
   serialize on one manifest, so concurrency multiplies the number of losing attempts rather
   than the throughput.
2. **Connection establishment becomes unreliable at four concurrent requests.** `/health`
   answered in 2.3-14.5 s across probes, with two samples landing at ~10 s, which is the
   default connect timeout of the clients involved. Past that boundary the client reports no
   status at all.
3. **Every deployment is a window of unavailability.** Requests issued while a deployment
   switched over were refused, twice today, and both times the resulting error was
   `PARTICIPANT_ENDPOINT_UNAVAILABLE`, indistinguishable from a network fault.

## Impact

| attempt  | error                                   | class                             |
| -------- | --------------------------------------- | --------------------------------- |
| 05:34:20 | `SEARCH_SERVICE_UNAVAILABLE · HTTP 503` | server 5xx, older build           |
| 10:45:38 | `SEARCH_TIMEOUT · HTTP 504`             | request reached the 120 s ceiling |
| 13:50:50 | `SEARCH_TIMEOUT · HTTP 504`             | same                              |
| 16:01:11 | `SEARCH_TIMEOUT · HTTP 504`             | same                              |
| 18:11:50 | `ADD_CONNECTION_FAILED`                 | connection never established      |
| 18:55:57 | `PARTICIPANT_ENDPOINT_UNAVAILABLE`      | preflight connection failed       |
| 19:01:59 | `PARTICIPANT_ENDPOINT_UNAVAILABLE`      | same                              |

No score was recorded; the failures were not distributed over the workload, they happened before
it.

## Timeline

- 05:18-10:43 - 220 invocations killed at exactly 120000 ms. Diagnosed as a 90 s per-attempt
  embedding timeout that the client retried, multiplied by up to forty sequential calls in one
  search. Fixed by a 10 s per-attempt timeout, no retry of timeouts, one batch call per purpose,
  a 25 s query budget and a 45 s write budget.
- 17:4x - the provider endpoint was removed from the embedding index identity after it made
  every existing user's next write re-embed their whole store inside the retry loop; Adds went
  from 53-76 s back to 0.6-3.8 s.
- 18:55 and 19:01 - two `PARTICIPANT_ENDPOINT_UNAVAILABLE` results with clean platform logs,
  which is the signature of a request that never arrived.
- 19:1x - measured from a clean network at concurrency 1, 2, 4 and 16.

## Root cause

Measured, same user, fresh user per run, deploy `8d5d91d3`:

| concurrency | Add                                                             | Search              | failures               |
| ----------- | --------------------------------------------------------------- | ------------------- | ---------------------- |
| 1           | 24/24 200, p50 **2.6 s**, max 21.9 s                            | 8/8, p50 7.2 s      | none                   |
| 2           | 16/16 200, p50 **3.6 s**, max 41.2 s                            | 4/4, p50 5.7 s      | none                   |
| 4           | 17/24 200 + **7 x 504**, p50 106 s (round 1) / 51.6 s (round 2) | 8/8, p50 8.4-11.1 s | 7 x 504                |
| 16          | 27/32 200, p50 **45.6 s**                                       | 15/16               | 5 connect timeouts + 1 |

The maxima at concurrency 1-2 (21.9 s, 41.2 s) are the fold: one partition rewrite per eight
accepted entries. At concurrency 4 the folds and the accepts contend for the same manifest, and
the losing attempts redo a multi-megabyte partition read, export and upload each time - which is
how a 5 s operation becomes three figures.

The preflight then fails for the same reason: sixteen invocations each holding an instance for
tens of seconds leave nothing for the health probe, and the probe's connect timeout is shorter
than the wait.

## Guardrails added

- `onlion/scripts/soak-endpoint.mjs`: the harness's own order from any network - preflight twice,
  a concurrent Add phase, a concurrent Search phase - reporting per-status counts, p50/max and
  connection errors. Exit code 1 when anything other than 200 appears, so it can gate a run.
- `/admin/status` reports the live embedding endpoint, model, index identity and the four
  timeouts that bound a request, so "which endpoint is this build talking to" stops being
  inferred from latency.
- Search and Add now carry explicit budgets (25 s query, 45 s write) and every COS round trip has
  a 20 s timeout, so a stalled dependency fails a request instead of consuming the ceiling.

## Lessons

- **A health preflight turns every availability problem into a zero.** The most valuable thing to
  protect is the first request, not the average one.
- **Concurrency is not free when the write path serializes per user.** It multiplied attempts
  instead of throughput, and the cost landed exactly on the requests that had nothing to do with
  the contention.
- **Measure from the client's network.** Three rounds of diagnosis were spent on numbers taken
  through a proxy, which produced failures and latencies that the real client never saw - and hid
  the ones it did.
- **A deployment is an outage.** Both times an attempt died at the endpoint, a deployment had
  happened within the hour. Freezing deployments for the duration of a run is not caution, it is
  part of the measurement.
- **A silent partial failure in cleanup costs nothing to look at and everything to reason about.**
  Batching deletions made the cleanup more robust and the residue less observable; the fix is to
  record what could not be deleted, not to hope it was nothing.
