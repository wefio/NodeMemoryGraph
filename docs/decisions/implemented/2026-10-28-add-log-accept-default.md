# Add is accepted into the log by default

[简体中文](2026-10-28-add-log-accept-default.zh-CN.md) · [Terms](2026-10-28-add-log-accept-default.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

`Add` was a read-modify-write of the whole user partition under a per-user manifest CAS.
Sixteen concurrent Adds on one user serialize into sixteen rounds, each moving megabytes,
and the harness saw the result as `/add` rising 36 s → 95 s → a 120 s platform timeout
while `/health` and `/search` stayed in milliseconds.

The append-log path was built for this (see
[the design](../../design/add-append-log-and-fold-design.md)): accept writes one immutable
entry, fold absorbs up to `MERGE_BATCH` entries per partition write, and the read path
sees entries that have not been folded. It shipped behind `NMG_ADD_MODE` and stayed
`sync` until a measurement justified the switch.

## Decision

`log` is the default. `NMG_ADD_MODE=sync` restores the old path without a code change, so
the switch is configuration and is reversible in one deployment.

The gate was "no regression" rather than an absolute latency target: the base cost of a
request on this path is dominated by the connection and the embedding call, so the
question was whether accepting through the log made an Add slower, not whether it made
the link fast.

## Measured result

16 concurrent Adds of 8 messages to one user, same client, same endpoint
(`ap-hongkong`), one warmup Add first, `concurrency=16` therefore one round per run.
Rounds that crossed the fold trigger are excluded, and with `rounds=1` none did.

| mode   | runs           | responses                | p50                           | max                           | failures |
| ------ | -------------- | ------------------------ | ----------------------------- | ----------------------------- | -------- |
| `sync` | 1 clean round  | 16 x 200                 | 21.8 s                        | 30.7 s                        | 0        |
| `log`  | 4 clean rounds | 16 x 200 each (64 total) | 3.8 s / 4.3 s / 4.3 s / 3.8 s | 5.9 s / 5.2 s / 7.3 s / 4.9 s | 0        |

The accept path is roughly five times cheaper at the median and six times cheaper at the
worst case in this burst. Nothing regressed.

### Instability is part of the result

Roughly half the runs taken during the same hour could not establish a connection for 5 to
20 of the 16 requests (`UND_ERR_CONNECT_TIMEOUT`), in **both** modes, while other requests
in the same run answered in milliseconds. Those runs are not "noise to be discarded": a
client that cannot reach the endpoint is the experience the leaderboard reports, and the
log switch neither causes nor cures it. What matters for this decision is that the clean
runs in both modes were taken an hour apart on the same path, and the difference between
them is far larger than the run-to-run spread within a mode.

## What this does and does not establish

- **The fold cost is not measured.** With `rounds=1` and a fresh user, pending peaked at
  17 and never reached `FOLD_TRIGGER` (24), so no request in these runs paid for folding.
  What is measured is the accept path. The fold's cost is one partition write per batch and
  is bounded by `MERGE_BATCH`, but its latency in production is unknown.
- One region, one user, one payload shape (8 messages). A different burst size, a longer
  running user, or a different region can differ.
- The instability above means individual runs are not comparable; only runs with zero
  client-side failures were used, and there were four of those for `log` and one for `sync`.
- No answer-quality or retrieval effect is claimed: this changes when an Add becomes part of
  a partition, not what is stored.

## Alternatives considered

- **Keep `sync` and lower the retry budget.** The 503s come from twelve CAS attempts
  running out under sixteen writers; a shorter budget turns them into faster 503s, and a
  longer one into slower successes. Neither changes how many partition rewrites a burst
  costs.
- **Additive delta writes for `Add`.** Measured and rejected earlier: an 8-message Add
  changes 72–86 pages of 8 KiB against a 32-page (`PART_DELTA_LIMIT`) budget, 0 of 13 adds
  fit, and the overlay lives inline in the manifest every writer contends for.
- **Pool `Add` requests server-side.** Functions are stateless across instances, so
  "collect concurrent Adds and write once" needs a coordinator the deployment does not have
  and a queue this runtime cannot provide.
- **Wait for a stable-client measurement before switching.** The base cost here is the
  connection and the model call, both of which are shared by the two paths; a five-fold
  difference in the accept path is far larger than the run-to-run spread, and the switch is
  one environment variable away from being reverted.

## Consequences

- An accepted Add is now readable through `pendingForSearch` until a fold moves it into a
  partition, capped at `MAX_PENDING_READ` entries per search.
- `/capacity` reports `pending_entries`; `sqlite_bytes` stays zero until the first fold,
  which is why the EdgeOne smoke had to stop asserting `sqlite_bytes > 0` after an Add.
- Rolling the **code** back after pending entries exist requires draining first:
  `POST /admin/fold?user_id=` answers 409 until the log is empty, and a v4 manifest is
  unreadable to an older deployment.
- Folding happens on the `Add` path when pending reaches `FOLD_TRIGGER`; it never happens
  on the read path, so search latency does not inherit write contention.
