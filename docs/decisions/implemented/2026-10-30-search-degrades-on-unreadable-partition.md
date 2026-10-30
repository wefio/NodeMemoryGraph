# An unreadable partition shortens the page, not the answer

[简体中文](2026-10-30-search-degrades-on-unreadable-partition.zh-CN.md) · [Terms](2026-10-30-search-degrades-on-unreadable-partition.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

At 20:18:31, 20:19:40, 20:20:21 and 20:20:57, `/search` answered **503** with
`stage=partition_download`, code `dependency_timeout`, after 29-31 s. On the same instance
(uptime 3699 → 3731 s, one user id) `/add` answered **200** at 24 s three seconds earlier.

Three things follow from the record:

| fact                                 | meaning                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 503, not 120 s                       | a business failure, not a platform kill — a different class from every earlier window                     |
| `stage=partition_download`           | the object-store body download timed out; retrieval never ran (`sqlite_loaded:false`, `live_databases:0`) |
| same instance, same user, `/add` 200 | the write path degrades and the read path did not                                                         |

A 5xx on `/search` costs the harness a whole attempt. A short page costs one question's recall.
Those are not the same price, and the read path was the only surface paying the higher one.

The same logs also showed `embedding_host`/`embedding_model` beside `stage=partition_download`,
which is why the two were suspected of sharing a dependency. They do not: the fields were attached
to **every** failure record whenever the environment configured an embedding provider.

## Decision

- `search` treats an unreadable partition as a missing one: the page is marked `partial: true`
  with `degraded: <error code>`, and after **two consecutive** failures the loop stops paying the
  timeout per partition and answers with what it has already read.
- "Unreadable" is an explicit list — `snapshot_changed`, `dependency_timeout`,
  `embedding_timeout`, `operation_aborted`, `TimeoutError`, `AbortError`, connection resets.
  Everything else still propagates: a bug in our own code must stay visible, not be folded into a
  quieter answer.
- Failure records carry `embedding_host`/`embedding_model` **only when the failing stage is an
  embedding stage**. A field that is always present carries no information.

## Evidence

| before                                                                       | after                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| delete a folded partition, search → 5xx (the suite surfaced it as a failure) | search → **200**, `partial: true`, `degraded: "snapshot_changed"` — pinned in `test-backend.mjs` |
| 4 × 503 in 2.5 min, 29-31 s each, while `/add` answered 200                  | the same condition now answers in one partition timeout instead of failing the request           |
| `partition_download` failures reported `embedding_host`                      | that field appears only for embedding stages                                                     |

## What this does and does not establish

- It does **not** diagnose why the partition download took 29-31 s. The write path was uploading
  snapshots and the search path was downloading them on the same instance while the embedding calls
  crossed to `ap-southeast-1`; a saturated egress or object-store throttling both fit, and neither is
  proven. This change bounds the blast radius, not the cause.
- It does not make a degraded page score well. Two unreadable partitions out of five still mean
  three partitions of recall — better than a failed attempt, not equal to a healthy read.
- The two-consecutive-failure stop is a judgement: it converts "N partitions × timeout" into two
  timeouts, which is what keeps a degraded search inside the 25 s deadline.

## Alternatives considered

- **Retry the download more times.** `cos-bucket.mjs` already retries 429/5xx twice; a timeout is
  deliberately not retried (see `2026-10-29-embedding-invocation-budget`), because retrying a
  stalled dependency inside an invocation multiplies the time to fail.
- **Return 503 with Retry-After** so the harness retries. The harness records a 5xx as a failed
  attempt for that run; a partial page at least reaches scoring.
- **Cache the partition between the write and the read.** A write path already uploads it; caching
  the same bytes for the read would double the memory the request already pays for, on a platform
  that starts a fresh isolate per request.

## Consequences

- `search`'s response can now contain `degraded`, alongside the existing `partial`. A caller that
  ignores both still gets a well-formed page.
- The stop-after-two rule makes the worst case predictable: two partition timeouts, not one per
  partition.
- Failure records lose `embedding_host` on non-embedding failures. That is the point, but it also
  means an incident timeline that used to have the field everywhere will now have it only where it
  applies.
