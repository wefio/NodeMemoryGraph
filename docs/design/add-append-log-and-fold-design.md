# Add as an immutable log entry, folded into partitions afterwards

**Status:** draft
**Created:** 2026-10-28

## Problem

`Add` is a read-modify-write of the whole user partition under a per-user manifest
CAS. Every attempt costs a manifest read, a partition download, a SQLite export, a
partition upload, and a conditional manifest write. Concurrent Adds on one user
serialize through that CAS: a 16-way burst is sixteen rounds, and each round moves
megabytes.

Measured on the deployed service (`ap-hongkong`), 16 concurrent Adds to one user,
8 messages per Add:

| quantity                             | value                       |
| ------------------------------------ | --------------------------- |
| success                              | 16/16, zero failures        |
| p50                                  | 17.7 s                      |
| p95                                  | 27.1 s                      |
| snapshot per partition (probe store) | 3.0–3.9 MB                  |
| pages changed per 8-message Add      | 72–86 of 8 KiB (576–688 KB) |

The harness reported the same shape from its side: `/add` rising 36 s → 95 s → a
120 s platform timeout, while `/health` and `/search` stayed in the millisecond
range. Delta writing was measured and rejected: an 8-message Add changes 72–86
pages against a 32-page (`PART_DELTA_LIMIT` = 256 KiB) budget, 0 of 13 Adds fit, and
the overlay lives inline in the manifest that every writer contends for.

Two things do not apply here and were verified rather than assumed: this runs as an
EdgeOne **cloud function** (`Nodejs20.19`, no edge-middleware stage), and there is
**no database or queue client** anywhere in the service — storage is COS over
HTTPS only (no VPC, no TCP). The runtime exposes no `waitUntil`, so a "return now,
finish later" background write cannot be made durable either.

## Goal

Make acceptance cheap and independent of burst size, without weakening what `Add`
has already promised.

The contract requires that a 200 means the data is durable and that a later
`Search` by the same user can retrieve it, with `request_id` idempotent on retry.
The goal is therefore not "async write" — it is **durable accept with deferred
compaction**: one immutable HTTPS write to accept, bounded folding afterwards, and
a read path that can see what has not been folded yet.

Non-goals: no change to embedding, ranking, payload caps, or the storage engine; no
new managed service; no relaxation of the idempotency or durability contract.

## Design

### 1. Log entry

`users/<key>/log/<received_ms padded>-<request_hash>.json`, written with
`x-cos-forbid-overwrite` so the name is the idempotency key and an existing object
cannot be overwritten:

```
{ v: 1, generation, user_id, session_id, request_id, request_hash,
  fingerprint, received_at, messages: [{ role, content, indexText? }] }
```

The name sorts lexicographically in arrival order, which the fold relies on.
`indexText` for structured (image) content has to be prepared before the PUT — that
step is CPU and possibly a vision call, and it stays on the request path.

### 2. Accept

Validate → look for `<seq>-<request_hash>` in the log (replay returns the stored
response; a different fingerprint is `409 request_id_reused`) → prepare messages →
PUT the entry → 200 with the same echo as today plus `task_id` and
`status: "complete"`.

`complete` describes persistence, not compaction: after the PUT the entry is durable
and immediately readable through the log-aware read path. If the harness interprets
`/add/status/<task_id>` more strictly, that is an open question below.

### 3. Read path

`Search` merges two sources: the partition search it already performs, and the
pending log entries for that user, bounded by count (`PENDING_READ_LIMIT`) and
bytes. Pending entries are scored the same way partition records are, and fused by
the existing identity/highest-score rule, so a pending record can neither duplicate
a folded one (identity) nor outrank it spuriously.

### 4. Fold

After an accept — or at the start of a request when pending already exceeds the
threshold — fold up to `MERGE_BATCH` entries **in one partition write**: read the
entries in name order, apply them in a single SQLite session, write their receipts
into the manifest, commit the partition and the manifest atomically, then
batch-delete the folded entries.

Cost per fold is one partition round trip regardless of how many entries it
absorbs, which is the whole point: a 16-way burst needs two folds, not sixteen
partition rewrites. Work is bounded by count and bytes so one oversized entry
cannot make a fold unbounded.

### 5. Idempotency and receipts

The entry name is the idempotency key while pending; the partition receipt is the
key after folding. Fold skips an entry whose receipt already exists, so a fold that
committed and then crashed before deleting its entries is harmless. Deletion always
happens after the commit, never before.

### 6. Quotas

`USER_LIMIT` (1 GiB) and `MAX_RECEIPTS` (16 384) count partition bytes plus pending
bytes/entries. `/capacity` reports both. When pending would exceed
`PENDING_BYTES_LIMIT`, `Add` folds instead of accepting, so the log cannot grow
without bound; the caller sees a slower but successful Add, not a rejection.

### 7. Storage format

The manifest gains `pending` (count) and `format: "nmg-shards-v4"`. `loadManifest`
already rejects unknown formats, so an older deployment fails loudly instead of
silently ignoring pending data — which is the correct failure mode, but it means a
rollback must drain the log first.

### 8. Reset

`Reset` bumps the generation and deletes the log prefix. Entries carry the
generation they were written under, and `mutateUser`'s existing `user_reset` guard
stays, so a fold that races a reset cannot resurrect old data.

### 9. Observability

`/health limits` reports `add_mode`, `pending_read_limit`, `merge_batch`;
`/capacity` reports `pending_entries`, `pending_bytes`, `folded_total`. `Add`
`POST /admin/fold?user_id=` drains a log in bounded rounds and answers **409** until it
is empty, so the pre-rollback check cannot pass half-drained. `Add` responses gain phase
timings (`accept`, `fold`) so the next latency question can be
answered from a response instead of a log hunt.

## Frozen interfaces (slice 1)

Everything below is fixed before parallel work starts, so three writers cannot
disagree about the seams. Changing any of it is a design change, not an
implementation detail.

### Log entry

```
name:    users/<userKey>/log/<received_ms padded to 13>-<request_hash>.json
         written with x-cos-forbid-overwrite; the name is the idempotency key
body:    { v: 1, generation, user_id, session_id, request_id, request_hash,
           fingerprint, received_at, messages: [{ role, content, indexText? }] }
```

`userKey` is `keyFor(userId)`, `request_hash` is the existing `hash(requestId)`,
`fingerprint` is the existing `hash(JSON.stringify({ sessionId, messages }))`.
`messages[].content` and `indexText` are stored exactly as prepared for
`rememberBatch`, so a folded record's statement is the same text a pending record
is scored on.

### `onlion/backend/append-log.mjs` (new; injected bucket only)

```js
export const LOG_ENTRY_VERSION = 1;   // must equal HTTP payloads' `v`
export const MAX_PENDING_READ = 8;    // pending entries scored per search
export function logPrefix(userKey)                                   // "users/<k>/log/"
export function logEntryName(receivedAt, requestHash)                // padded, sortable
export async function putLogEntry(bucket, userKey, entry)            // { name, created }
export async function readLogEntry(bucket, userKey, name)            // entry | null
export async function findLogEntry(bucket, userKey, requestHash)     // { name, entry } | null
export async function listPending(bucket, userKey, options)          // [{ name, entry }] arrival order
export async function deleteLogEntries(bucket, userKey, names)       // batch, idempotent
export function foldPlan(entries, limits)                            // pure: { fold, keep }
```

`bucket` is the existing COS contract (`get`/`head`/`put`/`delete`/`list`). This
module must not import `worker.mjs`, `storage.mjs`, or SQLite.

### `onlion/backend/storage.mjs` additions

```js
export const STORAGE_FORMAT_V4 = "nmg-shards-v4";
export function manifestFormat(manifest)  // pending > 0 ? v4 : (parts have delta ? v3 : v2)
export function pendingCount(manifest)    // number written by the fold/accept path
export function withPending(manifest, count)
export async function clearLog(bucket, userKey)  // reset path; prefix must equal logPrefix()
```

`commitManifest` writes `manifestFormat(manifest)`; `loadManifest` accepts v4. The
format only becomes v4 once `pending > 0`, which is what keeps a flag-off deployment
byte-identical on disk.

`clearLog` takes its prefix from `append-log.mjs` instead of redeclaring the string.
That runtime dependency was deliberately avoided while the two halves were being
written in parallel, so that either could run alone; once they ship together, a
prefix that cannot drift is worth more than a module that loads on its own.

### Worker seams (single writer)

```js
const addMode = (env) => (env.NMG_ADD_MODE === "log" ? "log" : "sync");  // default until measured
async function acceptAdd(env, input)                       // 200 body, durable log entry written
async function foldPending(env, userId, limits)            // { folded, remaining }
async function pendingForSearch(env, userId, limit)        // provisional records, max MAX_PENDING_READ
```

`pendingForSearch` returns page-shaped items with `pending:`-prefixed ids so the
existing fusion applies unchanged; each item costs one embedding call, capped at
`MAX_PENDING_READ`.

## Invariants (each one becomes a test)

- **I1** After a 200, a later `Search` by the same user retrieves the data, whether
  it is still pending or already folded.
- **I2** A retry of the same `request_id` returns a byte-identical response; a
  different fingerprint returns 409.
- **I3** Folding is idempotent: any crash point followed by a retry produces no
  duplicate memory, guarded by receipt presence.
- **I4** No partition write crosses a generation; nothing written before a `Reset`
  can reappear after it.
- **I5** The read path does not fold. Folding happens on `Add` (or an explicit
  maintenance route) only, so read latency does not inherit write contention.
- **I6** Pending reads are bounded in entries and bytes, and `Search` cost does not
  grow with the size of the log.

## Failure matrix

| failure point                    | state                        | next request                           |
| -------------------------------- | ---------------------------- | -------------------------------------- |
| before the log PUT               | nothing written              | retry accepts normally                 |
| after the PUT, response lost     | entry durable                | retry finds the entry, same echo       |
| fold crashes before commit       | entries intact               | next fold redoes it (no receipt)       |
| fold commits, dies before delete | entry + receipt both present | fold skips it (I3), delete retried     |
| two folds race                   | manifest CAS serializes      | loser retries; entries still valid     |
| reset races a fold               | generation changed           | fold aborts; `user_reset` 409 as today |

## Migration

No backfill: the first `Add` after the upgrade writes a log entry, and existing
partitions keep serving. `NMG_ADD_MODE=sync` restores today's path and still reads
and folds pending entries, so the switch is reversible without data loss. Rolling
the **code** back after the manifest becomes v4 requires draining pending first —
that is a documented operational step, not an automatic downgrade.

## Work breakdown

| piece                                                    | file                                  | net lines |
| -------------------------------------------------------- | ------------------------------------- | --------- |
| append-log module (entry shape, put/read/list, receipts) | `onlion/backend/append-log.mjs` (new) | ~150      |
| accept path                                              | `onlion/backend/worker.mjs`           | ~70       |
| pending-aware read path                                  | `worker.mjs` (+ ranking fusion)       | ~70       |
| fold                                                     | `worker.mjs`, reusing `addOneBatch`   | ~60       |
| quota and health surface                                 | `worker.mjs`                          | ~30       |
| manifest `pending`, format v4, log cleanup               | `onlion/backend/storage.mjs`          | ~50       |
| tests (invariants, failure injection, 16-way burst)      | `onlion/scripts/test-backend.mjs`     | ~250      |
| **total**                                                |                                       | **~680**  |

Slices that can be verified separately:

1. **Plumbing, no behaviour change** — manifest `pending`, format v4, the log
   module, `/capacity` fields. `Add` still synchronous.
2. **Accept + fold + pending-aware read** — must land together, behind
   `NMG_ADD_MODE=log`; verified by a 16-way burst against the synchronous path.
3. **Default on, decision record, benchmark note.**

## Open questions

1. **How pending entries are scored at read time.** Embedding them per read costs up
   to `PENDING_READ_LIMIT` extra embedding calls on every search; scoring them
   lexically only is cheap but weaker. Bounded either way, but the choice changes
   what I1 means in practice.
2. **What `status: "complete"` may claim.** The service already returns `task_id`
   and serves `/add/status/<task_id>`. If the harness treats that endpoint as
   evidence of processing rather than persistence, the status value needs agreement
   before this ships.
3. **`indexText` cost for structured content.** If it calls a vision model, it stays
   a synchronous step in the accept path and sets a floor on Add latency that no
   amount of folding removes.

## Rejected alternatives

- **Fire-and-forget background write.** The runtime has no `waitUntil`; a background
  task is not guaranteed to run, so a 200 would sometimes mean "lost".
- **Delta/overlay writes for `Add`.** Measured: 0 of 13 Adds fit the 32-page budget;
  raising the limit grows the manifest every writer contends for.
- **Larger retry budget or shorter backoff.** Only converts a 503 into a longer wait;
  the 120 s platform cap still applies.
- **Folding on the search path.** Would move write contention into read latency,
  which is the one thing currently fast.
- **A queue or database service.** Not reachable from this runtime, and it would add
  a dependency the deployment does not have today.
