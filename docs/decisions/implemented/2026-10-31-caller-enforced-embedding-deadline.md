# A dependency call gets a deadline the caller enforces

**Status:** implemented
**Approved:** explicit
**Relates to:** [search-time-budget-design](../../design/search-time-budget-design.md)

## Problem

Six `/search` requests were reported at 60.0–60.2 s with `stage_isolate: "embedding"`, then ran to
the platform's 120 s ceiling and were killed with no answer line at all.

Two facts made that unexplainable from the logs:

1. The deployed configuration bounds the embedding phase well below 60 s: a caller-enforced budget
   clock started at request start, a per-call timeout of 10 s, and every call gated on the budget. A
   single embedding call should not survive past ~35 s.
2. The same reports contained `last_embedding: { status: "ok", ms: 168 }` — an embedding that had
   **completed** — beside a stage that claimed to still be embedding. So the stage name was not
   evidence that the call was blocked there.

Three stall classes were then measured on the production runtime version (Node 20.19, and again on
Node 24): a peer that accepts and never answers, an unfinished TLS handshake, and a stalled body
after headers. All three aborted on time (10 019 / 5 012 / 5 010 ms). So "the abort does not work" is
false in general, and the specific path that hung stays unknown.

What is not unknown is the shape of the hole: the cancel signal was the **only** bound, and the
transport's own backstop is `headersTimeout` / `bodyTimeout` = **300 s** (undici's documented
default, with no promise of exact firing). Any signal that fails to settle therefore had nothing
behind it but a 120 s kill.

## Decision

- Every embedding call now carries a caller-enforced deadline as well: the call's own timeout plus a
  grace (`EMBED_DEADLINE_GRACE_MS`, 3 s), enforced by `hardDeadline`. The signal normally wins, so
  the classification callers already handle is unchanged; the deadline fires only when the promise
  does not settle at all. Its code is `embedding_deadline`, treated like a dependency timeout by the
  breaker and by the read path's degrade list.
- The slow-request report carries `ms_in_stage`, and every request line carries `stage_at_exit`.

## Evidence

| check                                                                              | result                                                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `hardDeadline` on a promise that never settles                                     | rejects with `embedding_deadline` at the deadline                                                             |
| `hardDeadline` on a value / on the caller's own error / on slow-but-finishing work | value passes through, the caller's error object is preserved, a 30 ms call under a 200 ms deadline is not cut |
| stage age inside a stage, after it ends, and nested                                | reports its own age, stops being current, restores the outer stage with its own age                           |
| end to end: provider answers documents and never answers the query text            | `Add` 56 ms, `/search` 200 in 176 ms, with at least one hung call observed                                    |
| `npm run verify`                                                                   | 46 PASS                                                                                                       |

## What this does not establish

- It does not identify what hung in that window. It makes the next occurrence answerable: a kill
  that leaves only a 60 s report will now say how long the stage had been entered, and a request that
  does finish records the stage it left from.
- It does not make a hung provider fast. It bounds the cost per call; a request that needs several
  calls still pays several bounds, which is why the budget stays the outer bound.

## Consequences

- A call that never settles now costs its timeout plus 3 s instead of running to the ceiling. On the
  read path the result is a shorter page with `degraded` naming the code; on the write path the
  record is stored vectorless and a later fold retries.
- `embedding_deadline` joins the breaker's trip list and the read path's degrade list, so one hung
  call suppresses the rest of that invocation instead of repeating the cost.
- Two log fields are now always present: `ms_in_stage` on the slow report and `stage_at_exit` on the
  request line. Anything reading the log by field name gets one more field, and the next incident is
  answerable without another round of hypotheses.
- The mechanism document gained invariants 8 and 9 rather than a new section about timeouts: tuning
  costs must still not edit it.

## Alternatives considered

- **Trust the signal and lower its timeout.** Already false for at least one path, and lowering it
  does not cover a promise that never settles.
- **Disable vector search while a breaker is open.** The breaker already does this after one failure;
  it cannot help the first call, which is the one that hung.
- **Do nothing and read the next incident.** The next incident would print the same unanswerable
  line.
