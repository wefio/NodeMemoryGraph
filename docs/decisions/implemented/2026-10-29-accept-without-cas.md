# An accept takes no compare-and-swap

[简体中文](2026-10-29-accept-without-cas.zh-CN.md) · [Terms](2026-10-29-accept-without-cas.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Measured from a clean network against the deployed build, one user's write path answers in 2.6 s at
concurrency 1 and in **51-106 s** at concurrency 4, where 7 of 24 requests were killed at the
120 s invocation ceiling; at concurrency 16, 5 of 32 connections never completed. A killed request
does not cost a score, it voids the attempt: the harness probes `/health` first and stops.

The cause was structural, not a slow dependency. Every accept for one user read the manifest,
computed a new one and wrote it back under an ETag compare-and-swap; a loser re-read and recomputed,
up to twelve times, and each attempt re-read and re-exported a partition of up to 8 MiB. The only
thing the accept wrote there was the pending count.

## Decision

**The write path appends; it does not contend.**

1. **An accept writes one thing**: its log entry, under a key derived from its own request hash,
   which no rival can collide with. It reads the manifest once, for the two facts the log cannot
   answer - the generation, and the receipt of a request that was already folded.
2. **The pending count is derived, not written.** Its only consumer is an operator reading
   `/capacity`, which now lists a bounded prefix and reports `pending_capped` when the bound was
   reached. Nothing on the read path trusts a zero any more: two gates (`pendingForSearch` and
   `fusePendingRecords`) returned early on `pendingCount === 0`, and both are gone.
3. **The fold is scheduled, not counted.** Roughly one accept in `FOLD_TRIGGER` (overridable with
   `NMG_FOLD_EVERY`) attempts a fold; the fold lists the log first and does nothing when fewer than
   a batch is waiting, so a wasted attempt costs one listing while a missed backlog would hide data.
4. **An accept embeds its own messages, and the fold reuses those vectors.** The document text for
   this path is `[day ]statement` - the service never supplies `previous_turn` - so it is known
   before any partition is opened. Accept embeds under `NMG_ACCEPT_EMBED_MS` (8 s) and stores the
   vectors in the entry with the index identity that produced them; the fold seeds its client from
   them and applies storage only. Losing the budget is not an error: the entry is written without
   vectors and the fold embeds as before.
5. **Every long operation is bounded.** The fold has `NMG_FOLD_BUDGET_MS` (20 s) and is skipped, not
   failed, past it; the search loop stops at `NMG_SEARCH_DEADLINE_MS` (60 s) and answers with
   `partial: true`; the fold's embedding backfill takes one batch of 32 (`maxBatches: 1`), matching
   the search path, where it used to embed a whole partition's backlog in a single request.

## Evidence

| measurement                               | value                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Add p50, concurrency 1                    | 2.6 s (max 21.9 s: one fold)                                                                   |
| Add p50, concurrency 2                    | 3.6 s (max 41.2 s: one fold)                                                                   |
| Add p50, concurrency 4                    | 51.6-106 s, 7 of 24 killed at 120 s                                                            |
| connection failures at 16                 | 5 of 32                                                                                        |
| provider calls per Add, after this change | at most **1**, even when the Add triggers a fold (24 sequential Adds, fold proven to have run) |
| provider retry budget                     | 3 attempts, only for 429/5xx; a timeout is not retried                                         |

## What this does and does not establish

- Not verified against a deployed build. Every number above is the before-state; the after-state
  needs one real run.
- It does not remove contention from the fold itself: two concurrent folds on one user still meet at
  the manifest CAS and are retried. It removes it from the path that runs on **every** accept, which
  is where the amplification was.
- A count that lags can only cause an extra fold attempt, never a missed one: a stale-high count
  costs a listing, and the read path no longer trusts a zero.

## Alternatives considered

- **Keep the count and retry harder.** That is the measured failure: twelve attempts each redoing
  megabyte-scale work.
- **Shard the counter (AWS's "write sharding")**, or a **G-Counter / PN-Counter**. Sharding divides
  contention by the shard count and keeps it; a grow-only counter cannot express a backlog that
  shrinks, and a PN-Counter's decrement cannot be reconciled with a log without ceasing to be
  mergeable. Both were assessed as strictly worse than deriving the number.
- **Put the counter in KV** (1 GB, unused on this platform) - the industry-shaped answer, since
  object storage is not a queue. Not taken because the only consumer is one operator reading
  `/capacity`, and a listing answers it on demand.
- **Alibaba Batch API for the embedding.** Supported by `text-embedding-v4` at half price, but it is
  asynchronous with a poll to collect results and this runtime has no timer; the poll would have to
  be carried by later requests. Rejected for the serving path, retained as the right tool for an
  offline re-embed.
- **Fire the embedding after the response (waitUntil).** Our entry never receives an execution
  context - `edgeone-entry.mjs` documents that deliberately - so there is no continuation to
  register.

## Consequences

- An accept is one PUT of a few KB. A burst no longer amplifies into retries.
- `/capacity` costs a listing, which is why the operator path pays it and the request path does not.
- **Rolling the code back now requires draining the log first.** An older deployment short-circuits
  on `pendingCount === 0`, and this deployment no longer maintains that count, so it could read a
  log with entries as empty. `/admin/fold` answers 409 until it is empty, which is the guard.
- A record whose inline embedding exceeded its budget is embedded twice (once abandoned, once in the
  fold). That is the only duplicate spend this introduces, and it happens only when the provider is
  slower than 8 s.
