// Append-only Add log: one immutable object per accepted Add, folded into
// partitions afterwards (docs/design/add-append-log-and-fold-design.md).
//
// The object name is the idempotency key, so an entry is written with
// x-cos-forbid-overwrite and can never be replaced: a retry of the same
// request_id finds the existing entry instead of overwriting it. Names sort
// lexicographically in arrival order, which is the order folding applies them.
//
// This module only uses the injected bucket contract (get/head/put/delete/list)
// and must never import worker.mjs, storage.mjs or SQLite: it is the seam that
// lets the accept path, the fold and the read path be built in parallel.
import { Buffer } from 'node:buffer';

export const LOG_ENTRY_VERSION = 1; // must equal the HTTP payloads' `v`
export const MAX_PENDING_READ = 8; // pending entries scored per search

// received_ms is padded to a fixed 13 digits (enough for any millisecond
// timestamp until year 2286), so plain string order is arrival order.
const SEQ_DIGITS = 13;
const MAX_RECEIVED_MS = 10 ** SEQ_DIGITS - 1;
const REQUEST_HASH = /^[0-9a-f]{64}$/;
const LIST_PAGE = 1000; // COS list page size
const READ_CONCURRENCY = 4;
// A generation-filtered read may look past the first `limit` entries, but never
// past a multiple of it: a log stuffed with entries from an older generation must
// cost bounded reads instead of a scan of the whole prefix.
const SCAN_FACTOR = 4;

export function logPrefix(userKey) {
  if (!isPathSegment(userKey)) throw new RangeError(`Invalid user key: ${String(userKey)}`);
  return `users/${userKey}/log/`;
}

export function logEntryName(receivedAt, requestHash) {
  const sequence = String(receivedMs(receivedAt)).padStart(SEQ_DIGITS, '0');
  return `${sequence}-${requestHashSuffix(requestHash)}.json`;
}

/** Durably append one entry. `created: false` means an entry with the same
 *  request_hash was already accepted, so the caller replays instead of writing. */
export async function putLogEntry(bucket, userKey, entry) {
  if (entry?.v !== LOG_ENTRY_VERSION)
    throw new RangeError(`Unsupported log entry version: ${String(entry?.v)}`);
  const name = logEntryName(entry.received_at, entry.request_hash);
  const written = await bucket.put(
    logPrefix(userKey) + name,
    JSON.stringify(entry),
    { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } },
  );
  return { name, created: !!written };
}

/** `null` means the entry is gone (folded, reset or never written). A missing
 *  entry is an ordinary answer; a corrupt or newer-version one is not. */
export async function readLogEntry(bucket, userKey, name) {
  const object = await bucket.get(logPrefix(userKey) + stripPrefix(userKey, name));
  if (!object) return null;
  const entry = await object.json();
  if (entry?.v !== LOG_ENTRY_VERSION)
    throw logError('log_entry_version', `Unsupported log entry version in ${name}`, name);
  if (!REQUEST_HASH.test(entry.request_hash ?? ''))
    throw logError('log_entry_corrupt', `Log entry ${name} has no valid request_hash`, name);
  return entry;
}

/** Did this entry reach the bucket?
 *
 *  Three states on purpose: `null` means the question could not be answered, and a
 *  caller that reads "unknown" as "absent" releases a reservation for an entry that
 *  is already on disk - a counter below the truth, which is the one direction that
 *  hides accepted data from search. Existence is asked with HEAD, not by reading the
 *  entry: `readLogEntry` throws on an entry it cannot parse, and that error says
 *  nothing about whether the object was written.
 *
 *  Exported beyond the frozen set on purpose: the write path needs it to decide
 *  whether a failed write actually failed. */
export async function logEntryLanded(bucket, userKey, entry) {
  try {
    const name = logEntryName(entry.received_at, entry.request_hash);
    const object = await bucket.head(logPrefix(userKey) + name);
    return !!object;
  } catch {
    // A failed HEAD, or an entry that cannot be named, is "unknown", never "absent".
    return null;
  }
}

/** Finds the oldest entry carrying one request_hash. The oldest match wins so a
 *  retry that recomputed received_at still resolves to the accepted entry. */
export async function findLogEntry(bucket, userKey, requestHash) {
  const suffix = `-${requestHashSuffix(requestHash)}.json`;
  const objects = await listObjects(bucket, userKey);
  const match = objects.find((object) => object.key.endsWith(suffix));
  if (!match) return null;
  const name = match.key.slice(logPrefix(userKey).length);
  const entry = await readLogEntry(bucket, userKey, name);
  return entry ? { name, entry } : null;
}

/** Pending entries in arrival order. `limit` defaults to MAX_PENDING_READ (the
 *  read path's cap); pass Infinity for the fold path, which wants everything.
 *  `generation`, when given, drops entries taken under another generation so
 *  `limit` counts entries the caller can actually use. A filter has to look past
 *  the first `limit` keys - truncating first would let a handful of older entries
 *  consume the whole window and hide the current ones - but only as far as
 *  max(MAX_PENDING_READ, SCAN_FACTOR * limit): a log full of foreign entries
 *  returns fewer matches rather than paging through the whole prefix. */
export async function listPending(bucket, userKey, options = {}) {
  const limit = readLimit(options?.limit);
  const generation = options?.generation;
  const prefix = logPrefix(userKey);
  const scan =
    limit === Infinity
      ? Infinity
      : generation === undefined
        ? limit
        : Math.max(MAX_PENDING_READ, limit * SCAN_FACTOR);
  const objects = await listObjects(bucket, userKey, scan);
  const pending = [];
  for (let index = 0; index < objects.length && pending.length < limit; index += READ_CONCURRENCY) {
    const chunk = objects.slice(index, index + READ_CONCURRENCY);
    const read = await Promise.all(
      chunk.map(async (object) => {
        const name = object.key.slice(prefix.length);
        // A concurrent fold or reset may delete an entry between list and get.
        const entry = await readLogEntry(bucket, userKey, name);
        if (!entry) return null;
        if (generation !== undefined && (entry.generation ?? null) !== (generation ?? null))
          return null;
        return { name, entry };
      }),
    );
    pending.push(...read.filter(Boolean));
  }
  return pending.slice(0, limit);
}

/** Batch delete. Deletion is always after the partition commit, so repeating it
 *  after a crash must be harmless: deleting a missing key is not an error. */
export async function deleteLogEntries(bucket, userKey, names) {
  const prefix = logPrefix(userKey);
  const keys = [
    ...new Set(
      (names ?? [])
        .filter((name) => typeof name === 'string' && name.length > 0)
        .map((name) => (name.startsWith(prefix) ? name : prefix + name)),
    ),
  ];
  if (keys.length) await bucket.delete(keys);
}

/** Pure fold budget: the longest arrival-ordered prefix of `entries` that fits
 *  `limits.maxEntries` and `limits.maxBytes`, measured as the UTF-8 size of the
 *  entry as it would be re-serialized. The first entry always folds, so one
 *  oversized entry cannot stall the log forever (it is bounded by the Add
 *  payload cap instead). Both `{name, entry}` items and bare entries are
 *  accepted; `keep` preserves whatever shape was passed in. */
export function foldPlan(entries, limits = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const maxEntries = budget(limits.maxEntries ?? limits.count, list.length);
  const maxBytes = budget(limits.maxBytes ?? limits.bytes, Infinity);
  const fold = [];
  let bytes = 0;
  for (const item of list) {
    if (fold.length >= maxEntries) break;
    const size = entryBytes(item);
    if (fold.length > 0 && bytes + size > maxBytes) break;
    fold.push(item);
    bytes += size;
  }
  return { fold, keep: list.slice(fold.length) };
}

function receivedMs(value) {
  const ms =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : value instanceof Date
          ? value.getTime()
          : NaN;
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_RECEIVED_MS)
    throw new RangeError(`Invalid received_at: ${String(value)}`);
  return ms;
}

function requestHashSuffix(requestHash) {
  if (!REQUEST_HASH.test(requestHash ?? ''))
    throw new RangeError(`Invalid request_hash: ${String(requestHash)}`);
  return requestHash;
}

function readLimit(limit) {
  if (limit === undefined) return MAX_PENDING_READ;
  if (limit === Infinity) return Infinity;
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(`Invalid pending limit: ${String(limit)}`);
  return limit;
}

function budget(value, fallback) {
  if (value === undefined) return fallback;
  if (value === Infinity) return Infinity;
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(`Invalid fold budget: ${String(value)}`);
  return value;
}

function entryBytes(item) {
  return Buffer.byteLength(JSON.stringify(item?.entry ?? item), 'utf8');
}

function isPathSegment(userKey) {
  return (
    typeof userKey === 'string' &&
    userKey.length > 0 &&
    !/[\\/]/.test(userKey) &&
    userKey !== '.' &&
    userKey !== '..'
  );
}

function stripPrefix(userKey, name) {
  const prefix = logPrefix(userKey);
  if (typeof name !== 'string' || name.length === 0)
    throw new RangeError(`Invalid log entry name: ${String(name)}`);
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

// Pages through the log prefix and returns objects in arrival (name) order.
// The bucket lists keys in ascending order (COS and R2 both do), so once `limit`
// names are collected a later page can only hold later ones: the read path stops
// there, which keeps its cost bounded by MAX_PENDING_READ instead of by the log.
// The fold path passes Infinity and still follows the cursor to the last page.
async function listObjects(bucket, userKey, limit = Infinity) {
  const prefix = logPrefix(userKey);
  const objects = [];
  let cursor;
  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: LIST_PAGE });
    const matching = (page?.objects ?? []).filter(
      (object) =>
        typeof object?.key === 'string' &&
        object.key.startsWith(prefix) &&
        object.key.length > prefix.length,
    );
    objects.push(...matching);
    if (objects.length >= limit || !page?.truncated || !page.cursor) break;
    cursor = page.cursor;
  }
  objects.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return objects.slice(0, limit);
}

function logError(code, message, key) {
  const error = new Error(message);
  error.code = code;
  error.key = key;
  return error;
}
