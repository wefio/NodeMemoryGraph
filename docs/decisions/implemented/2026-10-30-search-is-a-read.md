# The search is a read: no compare-and-swap on the query path

[简体中文](2026-10-30-search-is-a-read.zh-CN.md) · [Terms](2026-10-30-search-is-a-read.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

At 2026-10-30 01:31:48 a `/search` failed 503 in **90 ms** using 53 MB, with an empty platform log.
Memory evidence narrows the shape: a manifest CAS retry costs at least twelve object round trips
(measured 2.4 s+), and `storage_corrupt` needs one manifest read first — **90 ms is too short to
have touched storage at all**. The same evaluation window showed Adds answering normally, which fits
the known asymmetry: since the accept moved to the append log, **the search was the read path that
still wrote** — it staged partition deltas, encoded pages, and committed the manifest under an ETag
compare-and-swap, so it alone could die of a conflict or of a storage fault a write can meet.

The empty log is its own defect: the per-request memory trace samples 1-in-20, so a 90 ms request
usually leaves nothing. "Our handler returned an error" and "the platform never invoked us" are
indistinguishable afterwards.

## Decision

**A query never writes. Vector materialisation belongs to the write side; the read side embeds only
what it reads.**

- The search reads the manifest **once** and answers from what it read: no staging, no snapshot
  export, no `commitManifest`, no CAS, no retry loop. A reader that cannot write cannot lose a
  compare-and-swap, and can no longer die of `write_conflict` or `snapshot_changed`.
- The search's per-partition service **declines the vectorless-record backfill** (`allowBackfill:
false`). Documents stop being embedded inside a question unless the caller is on the write path.
- A record without stored vectors **scores lexically until a fold backfills it** — the fold is the
  compaction job, and it stays on the write path with its 20 s budget and its batch of 32.
- A pending record the accept already embedded **travels with the entry**; the fusion scores its
  stored vector and never asks the provider for the document text again. Only an entry whose
  accept lost the embed budget contributes its text to the one batch call.
- Legacy receipts are no longer copied into the manifest by a search; the fold, which writes,
  replays them.

This is the shape every engine in this class uses: RocksDB runs compaction in background threads
with the manifest recorded by the compactor; Hudi keeps `hoodie.log.compaction.inline` false
because inline scheduling "adds extra latency on the write path"; Cassandra operators disabled
`read_repair_chance` because it cost ~20% of read load for no guarantee, and what remains is
asynchronous. We were running all three of the paths they name as the expensive option: inline
compaction, blocking read repair, and a CAS on the query path.

## Evidence

| measurement                                                    | value                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| failing search                                                 | 503, 90 ms, 53.4 MB, empty log                                                                                                                                                                                                       |
| CAS-retired minimum                                            | 12 attempts × manifest read ≈ 2.4 s+ — the 90 ms request predates any CAS retry                                                                                                                                                      |
| serial add+search probe (post-fix build, clean network, proxy) | 20 rounds, all 200, search p50 ~1.4 s, the fold runs at round 16 (`parts` 0→1), zero failures                                                                                                                                        |
| zero-write pin                                                 | the parity test now asserts the manifest **bytes are unchanged** and the partition key is unchanged after two searches; the diagnostics runs assert `partition_save`/`sqlite_export`/`manifest_commit` absent from the timing stages |
| read-reuse pin                                                 | a search over pendings makes at most the feature batch call; the record texts of accept-embedded entries never reach the provider                                                                                                    |

## What this does and does not establish

- The 90 ms 503's exact cause is not reproducible after the fact — the request happened on the
  previous build, which staged and committed on the read path. This change removes the entire class
  (read path + CAS + staged object) rather than pinning one exception.
- A query does **more** work than idempotency requires: two identical searches re-read the
  partitions. That was always true; this decision changes nothing about it.
- The lexical-only window for vectorless records is real: data accepted before the inline-vector
  deployment, or whose accept lost the 8 s embed budget, scores lexically until its fold. The fold
  runs on the write path and backfills 32 per fold, so the window closes at the fold's cadence.
- Not verified on the deployed build yet; the suite (37 PASS) is the only current evidence.

## Alternatives considered

- **Keep search writes and retry more, or move the counter to KV.** The staging existed only to
  persist what a search produced (deltas, backfilled vectors, legacy receipts). Removing the
  production of those artifacts removes the reason to commit anything; retrying a write a read
  does not need to make is a bigger fix for a smaller problem than not making it.
- **Keep the backfill and stage only "when it did change".** That is the previous design: a */
  `readOnlyIfUnchanged` flag that converted the common case to a read and left the uncommon case
  exactly as dangerous — and it was the uncommon case that answered 503.
- **Fold-triggered probing from the read path.** Fold from search = read repair. Rejected on the
  Cassandra evidence: it puts the write-tradeoff on every query.

## Consequences

- The read path has one failure class left: what it read is absent or unreadable. That error is
  honest and raises `storage_corrupt` with a trace, not a speculative 503.
- A search is cheaper by what it no longer uploads: page deltas per changed partition and up to
  one manifest write — on a cold user with partitions, megabytes per answer.
- **Tests changed meaning**: the delta/snapshot persistence parity suite is retired; its
  replacement asserts the negative — both searches change nothing.
- `stageSearchPart` is deleted; the reuse plumbing for search staging goes with it. `stagePart`
  remains for the fold and the sync escape hatch.
- Every request now logs one `nmg_request` line (`trace_id, route, status, elapsed_ms, seq`),
  never sampled. A request whose handler never ran leaves no line at all — which is exactly the
  boundary between "our code failed" and "the platform never invoked us". Debug failures also
  carry the exception stack's first six lines.
