# The embedding path is bounded by the invocation, not by the provider

[简体中文](2026-10-29-embedding-invocation-budget.zh-CN.md) · [Terms](2026-10-29-embedding-invocation-budget.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

A scored run was killed twice. The platform log for 2026-10-29 holds **220 invocations
that all ran exactly 120000 ms** - the EdgeOne ceiling, already configured as
`cloudFunctions.maxDuration: 120` - with resident memory between 762 MB and 1014 MB
(p50 892, p95 999). Every one of them was killed, not merely slow.

The failure had two phases with different causes, and the account balance was not one of
them:

| window              | what happened                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 05:18:45 - 10:43:36 | 220 invocations hung to the ceiling with credit available (34 in the 05 hour, 17 in 08, 129 in 09, 40 in 10)                                    |
| 10:44:17 - 10:45:36 | 21 `embedding_http_400` events across 17 traces, all inside 52 seconds: the provider started rejecting requests, and those requests failed fast |

Arrears explains the second window only. The first window is the one that consumed 7.3
instance-hours of stalled invocations, and it happened while the provider was _slow_, not
refusing.

## Root cause

`onlion` forced a per-attempt embedding timeout larger than it thought:

```js
// onlion/backend/worker.mjs
NMG_EMBED_TIMEOUT_MS: env.NMG_EMBED_TIMEOUT_MS ?? "90000",
```

The provider client retries a timeout, on the theory that the request may simply have been
slow:

```js
// src/core/openai-embedding.ts
} catch (error) {
  // A timeout is retried too: the request may simply have been slow.
  if (attempt >= RETRY_DELAYS_MS.length) throw error;
}
```

So one logical call costs `90 s + 0.15 s + 90 s` before it fails - already past the 120 s
ceiling - and the pending-record fusion made up to **forty sequential calls** in a single
search:

```js
for (const list of features) for (const text of list) await client.embedQueries([text]);
for (const record of waiting) await client.embedQueries([record.content]);
```

Forty calls that each abort at 90 s within a 120 s invocation is not a slow request. It is
a request that cannot finish, and the platform answers for us by killing it. A killed
invocation leaves no diagnostics at all, which is why the incident looked like "every
request took exactly 120 s" and nothing more.

## Decision

Bound the embedding path by the invocation:

1. **Per-attempt timeout 10 s** (`EMBED_TIMEOUT_MS`), the provider client's own default,
   instead of the forced 90 s.
2. **A timeout is not retried.** A connection reset still is: it says nothing about the
   endpoint being slow.
3. **One batch call, not one call per text.** The vectors are identical; only the number of
   round trips changes. The fusion now collects every feature text and every pending
   record into a single request.
4. **A 25 s total budget per request for query-side embedding** (`NMG_EMBED_QUERY_BUDGET_MS`),
   shared by every call site. Past it, a call rejects, and every caller already degrades to
   scoring by term overlap. Documents are excluded: they carry the memory itself, so the
   per-attempt timeout and the batch size bound them instead.
5. **A 20 s timeout on every COS request**, surfaced as a retryable error. Nothing bounded
   these, so a stalled bucket produced the same 120 s death.
6. **A 60 s slow-request report** (`nmg_slow_request`, with trace id, route, elapsed time
   and queue state) because the 120 s kill leaves nothing behind.
7. `/health limits` reports `embed_timeout_ms`, `embed_query_budget_ms` and `slow_report_ms`
   so the numbers that bound an invocation are visible instead of inferred.

## Evidence

| claim                                    | how it is established                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| the platform ceiling is what killed them | 220 of 220 timeout rows report `运行时间 = 120000`; `maxDuration: 120` is already the platform maximum                   |
| the timeouts were not the arrears window | the 21 provider rejections are all inside 10:44:17-10:45:36, after the last timeout at 10:43:36                          |
| the path issued one call per text        | before the change, a search over six pending records produced **7 embedding calls with 1/1/1/1/1/1/1 inputs**            |
| it now issues one call                   | after the change, the same search produces **1 call with 8 inputs**, and the test asserts it                             |
| a timeout is not retried                 | `tests/core/openai-embedding.test.ts`: a server slower than the budget is contacted exactly once, past both retry delays |
| resets still retry                       | same file: a socket destroyed on the first attempt is retried and the embedding succeeds on the second                   |

## What this does and does not establish

- **Memory pressure is not ruled out.** 220 invocations died between 762 MB and 1014 MB, and
  if the instance limit is 1 GiB that is 88-99% occupancy. A killed invocation reports no
  stage timings, so the data cannot separate "waiting on a slow provider" from "GC thrash at
  the ceiling". The 60 s report is what will separate them next time.
- **The provider's own behaviour is unverified.** A 400 was classified by status only. The
  response body is already in the exception message, and `NMG_DEBUG_ERRORS=1` records it;
  without that flag the log cannot distinguish "insufficient balance" from a malformed batch.
- **The 90 s default was not chosen deliberately anywhere.** No record explains it; it is
  treated here as a defect rather than a decision being reversed.

## Alternatives considered

- **Raise `maxDuration`.** Already at the platform maximum of 120 s.
- **Blame the OPFS initialisation noise.** `sqliteReady()` memoises its instance, so the
  VFS install happens once per isolate and its failure is swallowed by the SQLite module.
  The repeated log lines are concurrent isolates, not retries, and they cost no measurable
  time.
- **Treat the provider rejections as the cause of the timeouts.** A non-retryable status is
  returned immediately by the client, and those rejections arrive 41 seconds after the last
  timeout.

## Consequences

- A slow provider now costs a degraded score, not a dead invocation: the search still
  answers, from term overlap where a vector is missing.
- Batch fusion is also cheaper for a healthy provider: one round trip instead of up to
  forty, which is the same reduction in latency and in the provider's own load.
- The write path keeps its generous behaviour. Documents are not budgeted, so a large Add
  is not truncated by the query budget - it is bounded by the per-attempt timeout and the
  batch size instead.
- An operator can read the three bounding numbers from `/health limits`, and a request that
  survives 60 s now says so in the log while it is still alive.
- Not addressed: resident memory between 762 MB and 1014 MB per invocation. If the instance
  limit is 1 GiB this is the next failure to look for, and the slow-request report is what
  will show whether it is memory or waiting.
