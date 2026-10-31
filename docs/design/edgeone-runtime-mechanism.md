# The EdgeOne Makers runtime: what the platform actually does

**Status:** draft
**Created:** 2026-10-31

This document owns the **platform's** mechanism — how EdgeOne Makers cloud functions invoke,
reuse and limit a Node handler. It is not about our code; see
[search-time-budget-design](search-time-budget-design.md) for that.

It exists because the same three platform facts were re-derived from samples, wrongly, more
than once: that a module-level variable survives between requests, that a `waitUntil` hook
exists, and that the memory figure in a log line belongs to the request. Each wrong assumption
produced a fix that did nothing in production.

Every statement carries its **source class**. A statement may only be changed by a new
measurement or a new official document, never by inference from a single sample.

## 1. Invocation lifecycle

| statement                                                                                                                                                         | source                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Each invocation runs in a **fresh isolate**: `instance.seq` was 1 on every one of 40+ observed request lines, across containers with `uptime_s` from 1210 to 3731 | measured                              |
| The **container is reused** for roughly 40–60 minutes; `uptime_s` grows across otherwise independent requests                                                     | measured                              |
| A module-level variable therefore does **not** outlive one request in practice                                                                                    | measured (follows from the two above) |
| There is **no documented** instance-reuse guarantee, reserved instance, or provisioned concurrency                                                                | official (absence)                    |
| Cold start of this bundle costs **~2–5 s**; a warm container answers `/health` in ~25 ms                                                                          | measured                              |

**Consequence.** Any cross-request cache, breaker or counter is, on this platform, a per-request
construct. Code that relies on it must still be correct when an isolate happens to be reused —
the reuse window is undocumented, not forbidden.

## 2. Concurrency

| statement                                                                                                                                                               | source                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Requests to one container are **serialised**: a burst spreads across few instances and the per-instance latency ladder grows with concurrency (measured 1 → 2 → 4 → 16) | measured, `postmortem/0006` |
| The operating decision that followed: run the benchmark at concurrency 1                                                                                                | decision                    |
| A slow request on an instance lengthens the others on that same instance                                                                                                | measured                    |

**Consequence.** "Our per-request latency" is only meaningful at a stated concurrency. A latency
comparison across two builds at different concurrency is not a comparison.

## 3. Hard limits

| limit                 | value                    | source             |
| --------------------- | ------------------------ | ------------------ |
| invocation duration   | **120 s** (default 30 s) | official           |
| request/response body | 6 MB                     | official           |
| code package          | 128 MB                   | official           |
| memory                | **not documented**       | official (absence) |
| runtime               | Node 20.x                | official           |

**Consequence.** A request killed at 120 s was killed by the platform, not by us; a request that
answers in 30–60 s was not. These are different fault classes and must not be counted together.

## 4. The handler context

The Node.js runtime page documents the handler context as `uuid`, `params`, `env`, `clientIp`,
`server` (`region`, `requestId`, `geo`) — a closed enumeration with no `waitUntil`. The same
`waitUntil` is documented, explicitly, on the **Edge Functions** `EventContext`, whose fields are
`params`, `env`, `waitUntil`. So the hook exists in this product family and belongs to the other
runtime, not to this one.

| statement                                                                                    | source   |
| -------------------------------------------------------------------------------------------- | -------- |
| `waitUntil` belongs to Pages Edge Functions (`FetchEvent`), not to this runtime              | official |
| Our log line reports `execution: "inline"` on every production request                       | measured |
| Nothing in the code depends on `waitUntil`; the branch remains for runtimes that provide one | code     |

**Consequence.** Work after the response does not exist here. Every deadline must be inside the
invocation, which is why a budget expressed as "start before X" was replaced by a real deadline.

## 5. What the platform's own log columns mean

| column            | meaning                                               | caveat                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| duration          | the platform's own timing                             | reported as **0 ms** for some record classes, including records whose status is a timeout — a row reading `timeout / 0 ms / 0.0000 MB` is an unreported field, not a fast request |
| memory            | **container** RSS at sampling time, not per-request   | explains a stable ~500–800 MB figure that does not grow with traffic                                                                                                              |
| domain / path     | empty for some records                                | a record with no path has no handler completion; it is not evidence about a route                                                                                                 |
| request-id suffix | shared suffix across rows hints at the same container | a hint, not proof                                                                                                                                                                 |

**Consequence.** A row whose duration and memory are both zero cannot support any conclusion
about speed or memory. Two rows agreeing on RSS is weak evidence of the same container.

## 6. Scheduled invocations

`edgeone.json` documents a `schedules` array that invokes a function route on a cron expression:
`name`, `cron` (five fields, or six with seconds), `path`, `method`, `payload`, `timezone`. The same
page shows an hourly example **and** a sentence that reads as a one-day minimum interval, so the
interval is not established.

**Do not ship one until that is resolved.** An A/B on 2026-10-31 showed that deploying this array as
documented left a project where no function route answered at all. The finding belongs here rather
than in a bug tracker because it is a property of the artefact the platform reads.

| statement                                                                                                                                                                                                                                                   | source                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| a cron-driven invocation exists and needs no external caller                                                                                                                                                                                                | official                                           |
| the minimum interval is at least a minute                                                                                                                                                                                                                   | official                                           |
| whether 30 minutes is honoured                                                                                                                                                                                                                              | **unknown** - measured by whether the beats appear |
| a schedule fires with no client request, so its log line proves the platform invoked us                                                                                                                                                                     | official + reasoning                               |
| **a `schedules` block as documented took every function route down**: with it deployed, `/health`, `/add` and `/search` all answered 404 while the domain served the platform default page; the same commit without it deployed correctly (A/B, 2026-10-31) | measured                                           |
| the route `/beat` itself works when no schedule points at it                                                                                                                                                                                                | measured                                           |

## 7. Deploy behaviour

| statement                                                                         | source                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A deploy switches versions atomically: no request is served by a mix of revisions | measured                                               |
| Previous revisions stay available for rollback                                    | official                                               |
| A deploy is a window of unavailability for anything measured during it            | measured — a deploy mid-run cost one measurement round |

## 7. How to extend this document

Add a row only with a measurement or an official citation. If a row must be **changed**, say
which earlier measurement it contradicts in the commit message; that is the signal that the
platform changed under us rather than that we stopped guessing.

Frequent edits here are a symptom, not a maintenance style: they mean the behaviour is still being
inferred sample by sample instead of being measured once.
