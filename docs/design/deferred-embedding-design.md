# Deferred document embedding

[简体中文](deferred-embedding-design.zh-CN.md) · [Terms](deferred-embedding-design.terms.yaml)

**Status:** draft

## Problem

An Add currently cannot finish without the embedding provider. The accept path writes the log
entry, and the fold that follows it embeds the batch before the partition is rewritten, so a
provider that is slow turns a write into a request that runs until the platform kills it. A
run of 220 invocations died exactly at the 120 s ceiling on 2026-10-29 for this reason; the
per-attempt timeout and the batch call that now bound it are a _limit_, not a decoupling - one
slow provider still costs about thirty seconds per Add and can still fail it.

That matters more than it sounds because the evaluation shape is serial: every Add finishes
before the first Search starts. The Add phase is therefore the only phase whose failure ends
the run, and a single failed Add is enough. A search that loses a vector loses one question's
evidence; an Add that fails loses the run.

The obvious answer - embed after responding - is not available. The deployment has no
scheduled or background trigger (`edgeone.json` carries only `maxDuration` and `regions`), and
a functions platform does not promise that work continues after a response is returned.

## Goal

Make the write path depend on the durable write, not on the provider:

- an Add succeeds once its entry is committed, whatever the provider is doing;
- retrieval quality degrades per record while a vector is missing, never per run;
- a provider that _rejects_ requests still fails loudly and immediately, because a run scored
  on term overlap alone would be a silently wrong result rather than a visible error;
- no new failure mode, no lost entry, no unbounded backlog.

## Design

### Entry format v2

A log entry gains an optional `vectors` array, aligned with `messages`:

```jsonc
{ "v": 2, "generation": "...", "messages": [ { "role": "user", "content": "...", "indexText": "..." } ],
  "vectors": [ null, [0.1, ...] ],        // present when v === 2, null while a vector is missing
  "vector_model": "<model>:<dims>:<profile>" }
```

`vector_model` is the identity of the vector space, the same one the partitions use. An entry
whose `vector_model` no longer matches the configured one is treated as vectorless and
re-embedded, exactly like a partition whose identity is stale - half a migration would serve
vectors that cannot be compared with the query's.

The entry already carries everything an embedding needs (`indexText` plus the message time),
which is what makes a later embedding possible at all: the original request does not have to
be alive.

### Accept path

1. Commit the entry with `vectors: null` (one PUT, as today).
2. Best-effort inline embedding with its own deadline (`EMBED_INLINE_MS`, default 8 s):
   one batch call for the entry's messages.
3. If it returns in time, rewrite the entry once with the vectors.
4. If it times out, leave `vectors: null` and return 200. The entry is durable; only the
   vector is outstanding.
5. If the provider **rejects** (any non-retryable status, or a retryable one exhausted), fail
   the Add with `embedding_unavailable`. A rejection is not slowness; it is a state the
   operator has to see, and the alternative is a whole run scored without vectors.

The healthy path costs one extra PUT compared with today and the same single batch call.

### Drain

Nothing runs after a response, so the backlog has to be carried by later requests. Any request
that touches a user may drain that user's backlog:

- bounded by count (`DRAIN_ENTRIES`, default 2) and by time (`DRAIN_MS`, default 4 s);
- newest-first is wrong here: the fold wants the oldest, and a search wants the newest, so the
  drain takes the **oldest vectorless** entries, which are the ones closest to being folded;
- one batch embedding call for all drained entries, then one PUT per entry;
- a drain that fails for a reason other than timeout stops for this request and leaves the
  entries for the next one; it never fails the request that carried it.

Adds drain before their own accept (they are already writing); searches drain only when their
budget allows and never after the first miss, so a phase boundary cannot turn one slow search
into several.

### Fold

The fold uses a stored vector when there is one and embeds the remainder in the same batch as
today. It never waits for the drain: a fold is allowed to be the thing that embeds.

This also defines the ceiling of the backlog: the fold trigger (one batch, eight entries) plus
whatever arrived since the last fold. That is the same bound the read window already has to
cover, so a vectorless record cannot outlive the log entry that holds it.

### Read path

Pending records score by vector when the entry has one and by term overlap when it does not -
the two paths that already exist. No new read behaviour, no new short-circuit: an entry is
visible either way, which is the property the log was introduced for.

## Frozen interfaces (slice 1)

```js
// append-log.mjs
export function putLogEntry(bucket, key, entry)             // existing
export async function listVectorless(bucket, key, options)  // {limit, generation}: oldest first
export async function attachVectors(bucket, key, name, vectors, model)  // rewrite one entry

// worker.mjs
async function drainBacklog(env, ctx, budgetMs)             // returns {drained, remaining}
```

`attachVectors` is the only writer of `vectors`, and it must be a rewrite of the same name so
the entry keeps its arrival position: reordering the log would change what a fold applies
first.

## Invariants (each one becomes a test)

| id  | invariant                                                              | the test that fails without it                                           |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| E1  | An Add whose entry committed returns 200 even when embedding times out | provider stub that never answers; the entry must be readable immediately |
| E2  | A rejecting provider fails the Add and stores nothing                  | stub answering 400; no entry, no receipt                                 |
| E3  | A vectorless record is searchable by term overlap                      | drain disabled, search still returns the record                          |
| E4  | The vectorless backlog never exceeds fold trigger + one arrival window | burst of Adds with the drain disabled                                    |
| E5  | A stale `vector_model` is re-embedded, never compared                  | entry written with a different model must not score by vector            |
| E6  | The drain never fails the request that carries it                      | drain against a broken bucket, request still 200                         |
| E7  | A folded record's vector is the one that was drained, not a second one | fold after drain must not call the provider                              |

## Failure matrix

| provider     | bucket  | Add result                                          | retrieval                          |
| ------------ | ------- | --------------------------------------------------- | ---------------------------------- |
| healthy      | healthy | 200, vector stored inline                           | full                               |
| slow (> 8 s) | healthy | 200, vector deferred                                | term overlap until the drain lands |
| rejects      | healthy | 5xx `embedding_unavailable`, entry not stored       | unchanged, and visible             |
| healthy      | slow    | 200 after the write commits (COS timeout bounds it) | full                               |
| slow         | slow    | 200 deferred, or 5xx if the write itself times out  | as above                           |
| down         | healthy | 5xx, nothing stored                                 | none for that Add, loudly          |

## Migration

`v === 1` entries stay readable: no `vectors`, therefore vectorless, therefore drained or
folded with an inline embedding. No rewrite is needed to upgrade, and a deployment that never
drains still behaves exactly as the current one. The same lazy rule as the pending count
applies: `vectors` is absent in a drained log, so a drained log stays byte-identical to one a
previous deployment wrote.

## Work breakdown

| slice | content                                                  | gate                                                                   |
| ----- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1     | entry v2 + `attachVectors` + inline deadline + E1/E2     | Add succeeds against a provider that never answers; rejects still fail |
| 2     | drain (`listVectorless`, budget) + E3/E4/E6              | backlog bounded and carried by later requests                          |
| 3     | fold uses stored vectors + E5/E7                         | a drained entry costs no provider call at fold time                    |
| 4     | docs, `/health` counters (`vectorless`, `drained_total`) | operator can see the backlog                                           |

## Open questions

- Should a search drain at all? It costs up to 4 s of a scored request to improve records that
  the same request may then score by vector. The alternative - searches never drain - leaves
  the phase-boundary backlog to term overlap.
- `EMBED_INLINE_MS = 8 s` is a guess. The right value is the observed p99 of a healthy batch
  call, which nobody has measured per phase.
- Does the extra PUT per vectorised entry matter under 16-way concurrency on one user? The
  manifest CAS is not involved, but the bucket sees one more write per entry.

## Rejected alternatives

- **Fire and forget after the response.** The platform does not promise post-response
  execution; a vector that "will be written later" would silently never arrive.
- **Embed in the fold only (today).** Any Add that triggers a fold inherits the provider's
  latency, which is what killed the run: the fold is on the accept path by construction.
- **Store vectors in a side object** (`vectors/<name>`), one PUT per entry. Same write count
  as a rewrite, but the entry and its vector can then disagree after a failed write, and the
  fold has to union two listings. The rewrite keeps one record of truth.
- **A scheduled job.** No trigger exists in the deployment, and adding an external cron adds a
  moving part whose failure mode is a permanently vectorless store.
