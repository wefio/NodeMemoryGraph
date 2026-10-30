# An embedding outage must cost latency, not the write

[简体中文](2026-10-30-embedding-breaker.zh-CN.md) · [Terms](2026-10-30-embedding-breaker.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Tencent's log analysis of 16:52-17:52 (74 rows, all `调用超时`) split the outage into three
classes:

| class                         | signature                                                                                                        | rows       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| A — fast fail                 | 53 ms, 54.48 MB, no business code ran                                                                            | 31 (41.9%) |
| B — blocked on the dependency | 120000 ms, 588-770 MB, `kind=embedding_failure code=dependency_timeout` at `text-embedding-v4` in ap-southeast-1 | 39 (52.7%) |
| C — idle to the ceiling       | 120000 ms, 54.48 MB                                                                                              | 4 (5.4%)   |

Class B is ours and is a mechanism, not a slow dependency:

1. The accept embeds inline (8 s race) and **loses** the race — the entry is stored vectorless.
2. The fold then backfills vectors: `syncRecordEmbeddings` inside `rememberBatch`. When the
   provider times out, that **throws**.
3. The throw leaves `rememberBatch` → `addOneBatch` → `mutateUser`, which treats it as a lost
   compare-and-swap and **re-runs the whole attempt** - up to twelve times, each paying the same
   provider timeout. Twelve attempts x 12 s is 144 s, which is how a request reaches the 120 s
   ceiling while "the fold" is the only thing on the stack.

The write had already succeeded by then. Every one of those retries was spent re-embedding records
that were already durable.

## Decision

**A vector backfill is an optimisation, so it may not fail the write; and a provider that is down
must not be called at all.**

- `memory-service`'s backfill never throws except for `EmbeddingPreparation`, which is **control
  flow**: `runPart` relies on it to unwind the SQLite session, embed outside it, and re-enter.
  Swallowing that one silently dropped records (caught by the fold it must keep searchable test);
  every other error is recorded in `backfillStatus` and the write continues.
- `monitoring.embeddingOperation` gains a **circuit breaker**: provider-side failures
  (`dependency_timeout`, `embedding_timeout`, `embedding_network_error`, 429, 5xx) open it for
  `NMG_EMBED_BREAKER_MS` (default 30 s). While open, an embedding call fails in microseconds with
  `embedding_suppressed` instead of waiting out the timeout. Records accepted during the window
  are stored vectorless and score lexically until a later fold backfills them.
- A 400 from a malformed input does **not** trip the breaker: that is our bug and must stay visible.

## Evidence

| before                                                                                                | after                                                                                               |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 39 rows at the 120 s ceiling in 18 minutes, all `dependency_timeout`, Adds 22-63 s when they survived | one timeout opens the breaker; the next Adds inside the window do no embedding work at all          |
| a fold whose provider timed out re-ran the manifest CAS up to 12 times                                | the fold's storage work completes regardless of the provider; only the vectors are missing          |
| `Add` p50 in the window: 22-36 s                                                                      | unmeasurable until deployed; the accept no longer waits on a provider call that is known to be down |

## What this does and does not establish

- It does not make the provider fast, and it does not add capacity. During an outage, retrieval
  quality drops (lexical instead of vector) for records accepted in the window - that is the
  deliberate trade, and it is bounded by the breaker window.
- Class A (53 ms, 54.48 MB, 31 rows) and class C are **not** addressed. Those invocations never
  reached the handler (no `nmg_request` line), so nothing in the worker can fix them; the honest
  next step is to reduce the per-instance baseline (600-800 MB rss measured) so the platform has
  less reason to fail fast, which is a separate task.
- The OPFS init noise (`Ignoring inability to install 'opfs' sqlite3_vfs`) comes from the vendored
  SQLite WASM loader, not our code.

## Alternatives considered

- **Raise the document timeout back to 25 s.** That is the 15:2x configuration: each attempt waits
  longer and the retry multiplier still applies.
- **Lower `mutateUser`'s attempt count.** It would cap the damage but keep the embedded call on the
  request path; a breaker removes the call, which is strictly better under an outage.
- **Batch API for the backfill.** Needs a polling driver this runtime does not have (documented in
  `2026-10-29-embedding-invocation-budget`).

## Consequences

- `/health limits` and `/admin/status` can report `embeddingBreakerStatus()`; `resetEmbeddingBreaker()`
  is the operator action after a provider recovers.
- A record accepted during an outage is retrievable lexically and gains a vector at a later fold.
  Nothing is lost; quality recovers on its own.
- The fold's outcome no longer depends on the provider at all, which is what
  `2026-10-30-search-is-a-read` promised for the read path.
