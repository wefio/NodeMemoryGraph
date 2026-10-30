# The fold runs after the response

[简体中文](2026-10-30-fold-runs-after-the-response.zh-CN.md) · [Terms](2026-10-30-fold-runs-after-the-response.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Measured from a concurrency-16 Add burst against the deployed build at 2026-10-30 14:09-14:15:

| observation                                              | value                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| requests killed at 120 s                                 | **5** (14:09, 14:11 ×2, 14:13, 14:15; one reported 707 MB)                     |
| ordinary Adds                                            | 11-25 s routinely; tail 40.8 / 62.8 / 76.4 / 84 / 100.7 s                      |
| every slow-report at 60 s (`queue.running:1, waiting:0`) | the isolate was **not** congested                                              |
| every slow/failed path's stack                           | `addRoute → foldPending → mutateUser → sqliteReady` — **all of them the fold** |
| `last_embedding` locally                                 | ok but 19-24 s per document call under burst                                   |

The mechanism: the accept returned its entry, then **awaited the fold inline** — the trigger had a
20 s budget, but the budget only gates whether it _starts_. With 16 writers on one user, several
folds ran into each other on the same manifest CAS and each loser re-read the whole partition; and
because the cross-region provider needed 19-24 s per call under burst, folds also paid a 32-record
backfill per round. The invocation clock, not the fold budget, was the ceiling being hit.

Also corrected this round: the previous record's claim that the accept could not move its fold
because "our entry never receives an execution context" was **wrong on the platform**. Both
documented models carry `waitUntil` — Edge Functions' `event.waitUntil` (doc 52688), and the
Makers Functions handler's EventContext (`request / params / env / waitUntil`, doc
162227908259442688). The entry (`edgeone-entry.mjs`) simply never destructured it, which is also
why the opt-in shared failure history (`NMG_ERROR_HISTORY=1`, `monitoring.mjs`) never ran in
production. That claim is superseded by this record.

## Decision

**The response comes first; the fold runs inside the invocation's extended life (`waitUntil`).**

- The accept still embeds its messages inline (8 s race) and writes its log entry: the entry is
  durable **before** any fold work, which is what makes the folded outcome idempotent and a fold
  killed mid-flight cost one provider call instead of a scored attempt.
- The scheduled trigger (1-in-`FOLD_TRIGGER` accepts) is unchanged, and so is the 20 s fold
  budget — past it the backlog waits for the next scheduled attempt.
- When the EventContext supplies `waitUntil` (production), the scheduled fold starts **after** the
  response; when it does not (tests, wrangler dev), the fold runs inline exactly as before, still
  budgeted. `NMG_FOLD_INLINE=1` forces the inline path for determinism.
- The entry adapts the context's `waitUntil` into the execution slot shim that `monitoring.mjs`
  already consumes, which turns the opt-in shared failure history on.

## Evidence

| before (this deployment)                                                | after (this round, measured live after deploy)                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Adds routinely 11-25 s in a 16-way burst; tail to 100.7 s               | same burst shape returns: Add ≈ 0.5 s non-folding, folds run in the background |
| 5 of the burst's requests killed at 120 s, every stack in `foldPending` | a killed post-response fold costs one backfill, not a 503                      |

## What this does and does not establish

- The provider's 19-24 s document call under burst is **not** addressed: `waitUntil` moves work
  out of the client's path, it cannot make the provider faster. Concurrency at the harness (1-2)
  or provider quota is the lever; if the client sets It, burst-side queueing does not change.
- A search can still take tens of seconds on a wide user (provider query window, partition size).
  This round touches neither.
- Folds that start in the same isolate still contend on the manifest CAS between themselves. They
  are only hidden from the client now.
- A fold's 32-record backfill is the maximum one fold may embed; recordings with more departed
  cache until a later fold — unchanged.

## Alternatives considered

- **Keep the fold inline with a stricter budget.** That is the pre-fix state: the budget gates the
  start, and a fold in progress cannot be preempted, so the same meeting of fold/CAS contention
  plus a slow provider still went to 100 s and 120 s.
- **Move the embedding behind `waitUntil` as well** (store the entry vectorless, embed after the
  response). Rejected: it would push document embedding onto the search path, which is where the
  "search is a read" round just removed it; and it adds a window in which records score lexically
  with no bound but the provider's lag.
- **A shared admission counter (KV) to cap the accept rate.** The burst's failure mode (fold
  contention) does not involve the counter anymore, and the counter reintroduces the hot shared
  key this round of refactors removed.

## Consequences

- `edgeone-entry.mjs` now passes `{ waitUntil: (task) => context.waitUntil(task) }` as the
  execution shim. Any code that read `monitoring.mjs`'s `context.execution?.waitUntil` gate
  switches to the async form once the context carries it.
- An Extra: with the fold moving out of the response, the accept path's folding cost lands in the
  post-response window instead of delaying the client; nothing else reads that window.
- Postmortem 0006's concurrency conclusions stand: no change here moves the provider or the
  platform limits.
