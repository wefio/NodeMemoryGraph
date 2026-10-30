# The fold budget is a deadline; and this runtime has no waitUntil

[简体中文](2026-10-30-fold-budget-is-a-deadline.zh-CN.md) · [Terms](2026-10-30-fold-budget-is-a-deadline.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Two facts, both from production log lines rather than from reading code.

**One: the previous round's premise was wrong for this runtime.** The always-on request line
reports `execution: "inline"` on every request since the stabilisation deploy — the adapter's
`context.waitUntil` probe never found the hook. That is correct behaviour on a platform that does
not supply it: the Makers **Node cloud function** context documents `uuid / params / env /
clientIp / server{region,requestId,geo}` and nothing else. The `waitUntil` the earlier record cited
belongs to **Pages Edge Functions** (`FetchEvent`) and to the Pages edge handler — a different
runtime from the Node cloud function this project deploys. So "the fold runs after the response"
never took effect in production; the entry in `2026-10-30-fold-runs-after-the-response` claimed
otherwise and is superseded here. The 15:00 Add p50 of 1.02 s with a 6.5 s tail was **inline**
folding at a 1-in-8 schedule, and the 16:59 rows show the same: `execution: "inline"`.

**Two: the fold budget only gated the start.** `if (dueBySchedule && Date.now() - startedAt <
foldBudget)` decided whether a fold _began_; a fold beginning at 19.9 s then ran a whole partition
rewrite plus its 32-record backfill. That is the mechanism behind the 14:09-14:15 numbers (Adds 11-25
s, tail 100.7 s, five kills at 120 s, every stack in `foldPending`) and it survived the previous two
rounds because nothing bounded the fold after it started.

A third, smaller finding from the same logs: two `/add` and `/search` requests answered **404 in
24-47 ms on dead-cold isolates** (81 MB, `wasm_linear_mb: null` — SQLite was never touched). Our
`/add` and `/search` accept POST only, so those were not work requests; the request line now
records `method` so the next occurrence is identified instead of guessed.

## Decision

- **The fold takes a deadline and honours it.** `foldPending(env, userId, { deadline })` refuses to
  start past it and, between applying entries, stops and leaves the remainder of the batch in the
  log. The accept passes `startedAt + foldBudget`; `/admin/fold` passes its own 100 s.
  Stopping is always safe: the entry is durable, folding is idempotent, and the next scheduled
  accept retries it.
- **No dependency on `waitUntil`.** The branch stays for a runtime that provides one (tests do),
  but the shipped path is the bounded inline fold, which is the only shape this platform supports.
- The request line gains `method`. Diagnostic only.

## Evidence

| before                                                                               | after                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14:09-14:15: Adds 11-25 s, tail 40-100 s, 5 kills at 120 s, all stacks `foldPending` | a fold that runs out of budget returns `{ folded, remaining: null, deferred: "budget" }` and the rest of the log waits for the next scheduled accept |
| 15:00 p50 1.02 s / max 6.5 s: inline folding at 1-in-8, budget gating only the start | same schedule, now bounded by the same clock the caller measured                                                                                     |
| no `method` in the request line; two 404s of unknown origin                          | `method` recorded, so a 404 either becomes explainable or stays provably non-mutating                                                                |

## What this does and does not establish

- It does not make Add fast at 16 concurrent writers: folding is still on the request path. The
  measured cost of one fold (partition rewrite + bounded backfill) is what an accept pays when the
  schedule lands on it.
- `waitUntil` remains unverified for any other EdgeOne runtime; nothing here assumes it.
- The 404 rows are still unexplained. `method` is what will explain them; the guess that they are
  connectivity probes is a guess.

## Alternatives considered

- **Deploy the Pages Edge Function runtime to get `waitUntil`.** A different product and a different
  deployment path; a migration is not a way to fix a fold budget in the same week as a scored run.
- **Raise `FOLD_EVERY` so folds coincide less often.** That trades latency for a growing backlog,
  which is the mechanism that hid accepted data in the last three rounds. The backstop stays folded.
- **Stop folding on the request path and add a timer.** This runtime has no timer; a cron would be a
  second deployment to operate, and the fold would still need to be bounded.

## Consequences

- One accept in `FOLD_TRIGGER` still pays the fold, but never for longer than the accept's own
  budget: past it the reply is the same 200 with the log longer.
- The fold's persisted "deferred" outcome is visible in `/admin/fold`'s counters, which is the
  drain path a rollback needs.
- `nmg_request` now carries `method`, `execution`: both are diagnostic-only and cost no round trip.
- The two earlier records (`fold-runs-after-the-response`, `accept-without-cas`'s waitUntil
  argument) are superseded on the platform claim; the mechanism they added (bounded, idempotent,
  write-side folding) is what this record strengthens.
