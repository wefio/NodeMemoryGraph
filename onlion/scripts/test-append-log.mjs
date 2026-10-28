/* eslint-disable no-console -- deliberate test/diagnostic output */
// Verifies the frozen append-log seam (docs/design/add-append-log-and-fold-design.md
// "Frozen interfaces (slice 1)") against an in-memory bucket that copies the COS
// contract: forbid-overwrite is a falsy PUT, delete of a missing key is a no-op,
// and list pages by cursor.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOG_ENTRY_VERSION,
  MAX_PENDING_READ,
  logPrefix,
  logEntryName,
  putLogEntry,
  readLogEntry,
  findLogEntry,
  listPending,
  deleteLogEntries,
  foldPlan,
  logEntryLanded,
} from '../backend/append-log.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const USER = 'userkey0123456789abcdef';

function memoryBucket({ pageSize = 1000 } = {}) {
  const records = new Map();
  const stats = { puts: 0, deletes: 0, lists: 0, gets: 0 };
  let sequence = 0;
  const bodyOf = (record) => record.body;
  const view = (key, record) => ({
    key,
    size: Buffer.byteLength(bodyOf(record), 'utf8'),
    etag: record.etag,
    async json() {
      return JSON.parse(bodyOf(record));
    },
    async arrayBuffer() {
      return new TextEncoder().encode(bodyOf(record)).buffer;
    },
  });
  return {
    records,
    stats,
    async get(key) {
      stats.gets += 1;
      const record = records.get(key);
      return record ? view(key, record) : null;
    },
    async head(key) {
      const record = records.get(key);
      return record ? { key, size: Buffer.byteLength(bodyOf(record), 'utf8'), etag: record.etag } : null;
    },
    async put(key, body, options = {}) {
      if (options.onlyIf?.etagDoesNotMatch === '*' && records.has(key)) return null;
      stats.puts += 1;
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      const record = { body: text, etag: (++sequence).toString(16).padStart(8, '0') };
      records.set(key, record);
      return { key, size: Buffer.byteLength(text, 'utf8'), etag: record.etag };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        stats.deletes += 1;
        records.delete(key);
      }
    },
    async list({ prefix = '', limit = pageSize, cursor } = {}) {
      stats.lists += 1;
      const matching = [...records.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = matching.slice(start, start + Math.min(limit, pageSize));
      const next = start + page.length;
      return {
        objects: page.map((key) => ({ key, size: Buffer.byteLength(bodyOf(records.get(key)), 'utf8') })),
        truncated: next < matching.length,
        cursor: next < matching.length ? String(next) : null,
      };
    },
  };
}

const entry = (receivedAt, requestHash, marker, messages = [{ role: 'user', content: marker }]) => ({
  v: LOG_ENTRY_VERSION,
  generation: 'gen-1',
  user_id: 'user-a',
  session_id: 'session-1',
  request_id: `request-${marker}`,
  request_hash: requestHash,
  fingerprint: 'f'.repeat(64),
  received_at: receivedAt,
  messages,
});

// --- frozen surface -------------------------------------------------------
assert.equal(LOG_ENTRY_VERSION, 1);
assert.equal(MAX_PENDING_READ, 8);
const moduleSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../backend/append-log.mjs'),
  'utf8',
);
const imports = [...moduleSource.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"];?/gm)].map(
  (match) => match[1],
);
assert.deepEqual(imports, ['node:buffer'], 'append-log must not import worker.mjs, storage.mjs or SQLite');

// --- naming --------------------------------------------------------------
assert.equal(logPrefix(USER), `users/${USER}/log/`);
assert.throws(() => logPrefix(''), RangeError);
assert.throws(() => logPrefix('a/b'), RangeError);
assert.throws(() => logPrefix('..'), RangeError);

assert.equal(logEntryName(1700000000000, HASH_A), `1700000000000-${HASH_A}.json`);
assert.equal(logEntryName(42, HASH_A), `0000000000042-${HASH_A}.json`);
assert.ok(logEntryName(999, HASH_A) < logEntryName(1000, HASH_B), '13-digit padding sorts as arrival order');
assert.equal(logEntryName(new Date(1700000000000), HASH_A), logEntryName(1700000000000, HASH_A));
assert.equal(logEntryName('2023-11-14T22:13:20.000Z', HASH_A), logEntryName(1700000000000, HASH_A));
assert.throws(() => logEntryName(1.5, HASH_A), RangeError);
assert.throws(() => logEntryName(-1, HASH_A), RangeError);
assert.throws(() => logEntryName(10 ** 13, HASH_A), RangeError);
assert.throws(() => logEntryName(1700000000000, 'not-a-hash'), RangeError);
assert.throws(() => logEntryName(1700000000000, `${'A'.repeat(64)}`), RangeError);

// --- put / read / find ---------------------------------------------------
{
  const bucket = memoryBucket();
  const first = entry(1700000000000, HASH_A, 'first');
  assert.deepEqual(await putLogEntry(bucket, USER, first), { name: `1700000000000-${HASH_A}.json`, created: true });
  assert.equal(bucket.records.size, 1);
  assert.deepEqual(await readLogEntry(bucket, USER, `1700000000000-${HASH_A}.json`), first);
  assert.deepEqual(await findLogEntry(bucket, USER, HASH_A), {
    name: `1700000000000-${HASH_A}.json`,
    entry: first,
  });
  assert.equal(await findLogEntry(bucket, USER, HASH_B), null);
  assert.equal(await readLogEntry(bucket, USER, `1800000000000-${HASH_A}.json`), null);

  // The name is the idempotency key: the second writer cannot replace the body.
  const replay = await putLogEntry(bucket, USER, first);
  assert.deepEqual(replay, { name: `1700000000000-${HASH_A}.json`, created: false });
  const impostor = await putLogEntry(bucket, USER, { ...first, messages: [{ role: 'user', content: 'lost' }] });
  assert.equal(impostor.created, false);
  assert.deepEqual(await readLogEntry(bucket, USER, impostor.name), first);
  assert.equal(bucket.stats.puts, 1, 'a replay must not cost a write');
  assert.equal(bucket.stats.deletes, 0);

  // The oldest entry wins when a retry recomputed received_at for the same request.
  const retried = entry(1700000009999, HASH_A, 'first');
  assert.deepEqual(await putLogEntry(bucket, USER, retried), { name: `1700000009999-${HASH_A}.json`, created: true });
  assert.equal((await findLogEntry(bucket, USER, HASH_A)).name, `1700000000000-${HASH_A}.json`);

  // After a reset the old echo must not be replayed to a client whose data was
  // wiped: the generation filter skips the older entry and finds the current one.
  const generations = memoryBucket();
  await putLogEntry(generations, USER, { ...entry(1700000000000, HASH_A, 'old'), generation: 'g1' });
  await putLogEntry(generations, USER, { ...entry(1700000600000, HASH_A, 'new'), generation: 'g2' });
  assert.equal((await findLogEntry(generations, USER, HASH_A)).entry.messages[0].content, 'old');
  assert.equal(
    (await findLogEntry(generations, USER, HASH_A, { generation: 'g2' })).entry.messages[0].content,
    'new',
  );
  assert.equal(await findLogEntry(generations, USER, HASH_A, { generation: 'gone' }), null);

  // A match that vanishes between the list and the read is skipped, not reported as
  // a miss: the replay lookup must keep looking at the next candidate.
  const vanishing = memoryBucket();
  await putLogEntry(vanishing, USER, entry(1700000000000, HASH_A, 'first'));
  await putLogEntry(vanishing, USER, entry(1700000000001, HASH_A, 'second'));
  const vanishingKey = `${logPrefix(USER)}1700000000000-${HASH_A}.json`;
  const racingLookup = {
    ...vanishing,
    async get(key) {
      if (key === vanishingKey) {
        vanishing.records.delete(key);
        return null;
      }
      return vanishing.get(key);
    },
  };
  assert.equal(
    (await findLogEntry(racingLookup, USER, HASH_A)).entry.messages[0].content,
    'second',
  );

  // The replay lookup validates the whole name too: a key that only looks like an entry
  // (`foo-<hash>.json`, no 13-digit prefix) is reported as a naming problem, not later as
  // a JSON parse error.
  const strayLookup = memoryBucket();
  await putLogEntry(strayLookup, USER, entry(1700000000000, HASH_B, 'kept'));
  await strayLookup.put(`${logPrefix(USER)}foo-${HASH_A}.json`, '{}');
  await assert.rejects(
    () => findLogEntry(strayLookup, USER, HASH_A),
    (error) => error.code === 'log_entry_name',
    'a lookalike name must be reported as corruption, not as a parse error',
  );

  await assert.rejects(putLogEntry(bucket, USER, { ...first, v: 2 }), RangeError);
  const wrongVersion = memoryBucket();
  await wrongVersion.put(`${logPrefix(USER)}1700000000000-${HASH_A}.json`, JSON.stringify({ ...first, v: 99 }));
  await assert.rejects(readLogEntry(wrongVersion, USER, `1700000000000-${HASH_A}.json`), /Unsupported log entry version/);
  const noHash = memoryBucket();
  await noHash.put(`${logPrefix(USER)}1700000000000-${HASH_A}.json`, JSON.stringify({ ...first, request_hash: null }));
  await assert.rejects(readLogEntry(noHash, USER, `1700000000000-${HASH_A}.json`), /request_hash/);
}

// --- listPending ---------------------------------------------------------
{
  const bucket = memoryBucket();
  const hashes = ['1', '2', '3', '4', '5'].map((digit) => digit.repeat(64));
  // Written out of arrival order: the listing must still be name-ascending.
  for (const index of [2, 0, 4, 1, 3])
    await putLogEntry(bucket, USER, entry(1700000000000 + index, hashes[index], `m${index}`));
  await bucket.put('users/other/log/1700000000000-' + HASH_B + '.json', 'not json', {});

  const all = await listPending(bucket, USER, { limit: Infinity });
  assert.deepEqual(
    all.map((item) => item.entry.messages[0].content),
    ['m0', 'm1', 'm2', 'm3', 'm4'],
  );
  assert.deepEqual(
    all.map((item) => item.name),
    [...all.map((item) => item.name)].sort(),
  );
  assert.equal((await listPending(bucket, USER, { limit: 2 })).length, 2);
  assert.equal((await listPending(bucket, USER)).length, 5, 'default limit still returns everything under the cap');
  assert.equal((await listPending(bucket, USER, { limit: 1 }))[0].entry.messages[0].content, 'm0');
  await assert.rejects(listPending(bucket, USER, { limit: 0 }), RangeError);

  // Paging by cursor: five entries read across three list pages.
  const paged = memoryBucket({ pageSize: 2 });
  for (const index of [0, 1, 2, 3, 4])
    await putLogEntry(paged, USER, entry(1700000000000 + index, hashes[index], `m${index}`));
  assert.deepEqual(
    (await listPending(paged, USER, { limit: Infinity })).map((item) => item.entry.messages[0].content),
    ['m0', 'm1', 'm2', 'm3', 'm4'],
  );
  assert.ok(paged.stats.lists >= 3, 'the cursor must be followed to the last page');

  // The read path must not pay for the whole log: with one key per page, a
  // two-entry read stops after two pages, and the fold path still sees all five.
  const slow = memoryBucket({ pageSize: 1 });
  for (const index of [0, 1, 2, 3, 4])
    await putLogEntry(slow, USER, entry(1700000000000 + index, hashes[index], `m${index}`));
  slow.stats.lists = 0;
  assert.equal((await listPending(slow, USER, { limit: 2 })).length, 2);
  assert.equal(slow.stats.lists, 2, 'a bounded read must stop listing once it has enough');
  slow.stats.lists = 0;
  assert.equal((await listPending(slow, USER, { limit: Infinity })).length, 5);
  assert.equal(slow.stats.lists, 5, 'the fold path follows the cursor to the last page');

  // A generation filter must not be starved by older entries: the current ones sit
  // behind the foreign ones, and a key-truncated read would never reach them.
  const mixed = memoryBucket();
  const serial = (index) => String(index).padStart(64, '0');
  for (const index of [0, 1, 2])
    await putLogEntry(mixed, USER, {
      ...entry(1700000000000 + index, serial(index), `old${index}`),
      generation: 'g1',
    });
  for (const index of [3, 4])
    await putLogEntry(mixed, USER, {
      ...entry(1700000000000 + index, serial(index), `new${index}`),
      generation: 'g2',
    });
  assert.deepEqual(
    (await listPending(mixed, USER, { limit: 2, generation: 'g2' })).map(
      (item) => item.entry.messages[0].content,
    ),
    ['new3', 'new4'],
  );
  assert.equal((await listPending(mixed, USER, { limit: 2, generation: 'g1' })).length, 2);
  assert.deepEqual(await listPending(mixed, USER, { limit: 2, generation: 'gone' }), []);

  // The scan behind a filter is bounded: a log stuffed with foreign entries returns
  // fewer matches instead of reading the whole prefix (I6), so a search cannot be
  // made to pay for a log it will never use.
  const buried = memoryBucket();
  for (let index = 0; index < 40; index += 1)
    await putLogEntry(buried, USER, {
      ...entry(1700000000000 + index, serial(index), `old${index}`),
      generation: 'g1',
    });
  await putLogEntry(buried, USER, {
    ...entry(1700000000500, HASH_A, 'current'),
    generation: 'g2',
  });
  buried.stats.gets = 0;
  const buriedRead = await listPending(buried, USER, { limit: 2, generation: 'g2' });
  assert.deepEqual(buriedRead, [], 'a bounded scan may return fewer matches than the limit');
  assert.ok(
    buried.stats.gets <= 8,
    `a filtered read must not read the whole prefix (read ${buried.stats.gets} entries)`,
  );
  // The documented bound, in code rather than prose: search asks for at most
  // MAX_PENDING_READ, so a filter scans at most max(MAX_PENDING_READ, 4 * limit) keys.
  // Beyond that the current generation stays out of the window until folds retire the
  // leftovers - which is why the counter has to include them (reset hand-off).
  buried.stats.gets = 0;
  assert.deepEqual(await listPending(buried, USER, { limit: 8, generation: 'g2' }), []);
  assert.equal(buried.stats.gets, 32, 'a filtered read scans at most 32 keys for limit 8');

  // An entry the caller is finished with (its receipt is already written, the object
  // is not deleted yet) must be skipped before its body is read: that saves one GET
  // here and one embedding call per ghost on the search path.
  const ghosts = memoryBucket();
  const receipts = new Set([0, 1, 2, 3].map((index) => serial(index)));
  for (let index = 0; index < 4; index += 1)
    await putLogEntry(ghosts, USER, {
      ...entry(1700000000000 + index, serial(index), `ghost${index}`),
      generation: 'g',
    });
  for (const index of [4, 5])
    await putLogEntry(ghosts, USER, {
      ...entry(1700000000000 + index, serial(index), `live${index}`),
      generation: 'g',
    });
  ghosts.stats.gets = 0;
  const live = await listPending(ghosts, USER, {
    limit: 2,
    skipRequestHash: (hash) => receipts.has(hash),
  });
  assert.deepEqual(
    live.map((item) => item.entry.messages[0].content),
    ['live4', 'live5'],
  );
  assert.equal(ghosts.stats.gets, 2, 'a skipped entry must not cost a body read');
  // Without the filter the ghosts still show up: the fold batch needs to see them to
  // delete them, and the reconcile count needs the log's own truth.
  assert.equal((await listPending(ghosts, USER, { limit: Infinity })).length, 6);
  await assert.rejects(() => listPending(ghosts, USER, { skipRequestHash: 'nope' }), TypeError);
  // A name in the log prefix that is not a log entry is corruption, not a reason to
  // hide the entry: with a predicate the hash comes from the name, so the failure has
  // to be loud instead of turning into a silent skip.
  const stray = memoryBucket();
  await putLogEntry(stray, USER, entry(1700000000000, serial(0), 'kept'));
  await stray.put(`${logPrefix(USER)}not-a-log-entry.json`, '{}');
  await assert.rejects(
    () => listPending(stray, USER, { limit: 2, skipRequestHash: () => false }),
    (error) => error.code === 'log_entry_name',
    'an unparseable name must fail loudly when a predicate needs the hash',
  );
  // The fold batch and the reconcile read pass no predicate; they must report the same
  // corpus problem with the same code instead of a raw JSON SyntaxError.
  await assert.rejects(
    () => listPending(stray, USER, { limit: Infinity }),
    (error) => error.code === 'log_entry_name',
    'an unparseable name must fail loudly for callers without a predicate too',
  );
  // A name that only looks like an entry (`foo-<hash>.json`) must not slip through the
  // shape check and turn into a JSON parse error further down.
  const lookalike = memoryBucket();
  await putLogEntry(lookalike, USER, entry(1700000000000, serial(0), 'kept'));
  await lookalike.put(`${logPrefix(USER)}foo-${HASH_A}.json`, '{}');
  await assert.rejects(
    () => listPending(lookalike, USER, { limit: 2, skipRequestHash: () => false }),
    (error) => error.code === 'log_entry_name',
    'a lookalike name must be reported as corruption',
  );
  console.log(
    'PASS: a receipt the caller already wrote skips the entry before its body is read, and is still visible to the fold path and to the reconcile count.',
  );

  // A fold or reset can delete an entry between the list and the read.
  const racing = {
    ...bucket,
    async get() {
      return null;
    },
  };
  assert.deepEqual(await listPending(racing, USER, { limit: Infinity }), []);
  assert.deepEqual(await listPending(bucket, 'nobody', { limit: Infinity }), []);
}

// --- deleteLogEntries ----------------------------------------------------
{
  const bucket = memoryBucket();
  const names = [
    `1700000000000-${HASH_A}.json`,
    `1700000000001-${HASH_A}.json`,
    `1700000000002-${HASH_A}.json`,
  ];
  for (const [index, name] of names.entries())
    await putLogEntry(bucket, USER, entry(1700000000000 + index, HASH_A, `m${index}`));
  assert.equal(bucket.records.size, 3);

  await deleteLogEntries(bucket, USER, [names[0], `${logPrefix(USER)}${names[1]}`, names[0], '', null]);
  assert.deepEqual([...bucket.records.keys()], [`${logPrefix(USER)}${names[2]}`]);
  await deleteLogEntries(bucket, USER, [names[0], names[1]]); // idempotent: already gone
  await deleteLogEntries(bucket, USER, []);
  assert.deepEqual([...bucket.records.keys()], [`${logPrefix(USER)}${names[2]}`]);
}

// --- foldPlan ------------------------------------------------------------
{
  const small = entry(1700000000000, HASH_A, 'x', [{ role: 'user', content: 'y'.repeat(100) }]);
  const big = entry(1700000000001, HASH_A, 'y', [{ role: 'user', content: 'z'.repeat(100) }]);
  const items = [small, big, entry(1700000000002, HASH_A, 'w')];

  assert.deepEqual(foldPlan([]), { fold: [], keep: [] });
  assert.deepEqual(foldPlan(undefined), { fold: [], keep: [] });
  const byCount = foldPlan(items, { maxEntries: 2 });
  assert.deepEqual(byCount.fold, [small, big]);
  assert.deepEqual(byCount.keep, [items[2]]);
  assert.deepEqual(foldPlan(items, { maxEntries: 0 }), { fold: [], keep: items });
  assert.deepEqual(foldPlan(items, { maxEntries: Infinity }).fold.length, 3);

  const size = Buffer.byteLength(JSON.stringify(small), 'utf8');
  assert.deepEqual(foldPlan(items, { maxBytes: size }).fold, [small]);
  assert.deepEqual(foldPlan(items, { maxBytes: size * 2 }).fold, [small, big]);
  assert.deepEqual(foldPlan(items, { maxEntries: 3, maxBytes: size * 2 }).fold, [small, big]);

  // One oversized entry still folds: progress beats the byte budget, otherwise it
  // would be retried by every later fold and never absorbed.
  assert.deepEqual(foldPlan(items, { maxBytes: 1 }).fold, [small]);
  assert.deepEqual(foldPlan(items, { maxBytes: 0 }).fold, [small]);

  // {name, entry} items are measured by their entry and preserved as passed.
  const named = items.map((item, index) => ({ name: `n${index}`, entry: item }));
  assert.deepEqual(foldPlan(named, { maxEntries: 1 }).fold, [named[0]]);
  assert.deepEqual(foldPlan(named, { maxBytes: size }).keep, named.slice(1));

  assert.throws(() => foldPlan(items, { maxEntries: -1 }), RangeError);
  assert.throws(() => foldPlan(items, { maxBytes: 1.5 }), RangeError);
  assert.throws(() => foldPlan(items, { maxEntries: '2' }), RangeError);
}

// --- accept / fold / read lifecycle --------------------------------------
{
  const bucket = memoryBucket();
  const arrivals = [0, 1, 2, 3, 4, 5].map((index) =>
    entry(1700000000000 + index, String(index).repeat(64), `m${index}`),
  );
  for (const item of arrivals) await putLogEntry(bucket, USER, item);

  const pending = await listPending(bucket, USER, { limit: Infinity });
  assert.equal(pending.length, 6);
  const { fold, keep } = foldPlan(pending, { maxEntries: 4 });
  assert.deepEqual(
    fold.map((item) => item.entry.messages[0].content),
    ['m0', 'm1', 'm2', 'm3'],
  );
  await deleteLogEntries(bucket, USER, fold.map((item) => item.name));
  assert.deepEqual(
    (await listPending(bucket, USER, { limit: Infinity })).map((item) => item.name),
    keep.map((item) => item.name),
  );

  // A crash after the delete retries cleanly: nothing is duplicated or lost.
  await deleteLogEntries(bucket, USER, fold.map((item) => item.name));
  assert.equal((await listPending(bucket, USER, { limit: Infinity })).length, 2);
  assert.equal(await findLogEntry(bucket, USER, String(0).repeat(64)), null);
  assert.ok(await findLogEntry(bucket, USER, String(5).repeat(64)));
}

console.log(
  'PASS: append-log names are padded, sortable idempotency keys; forbid-overwrite replays without a write; pending listing is cursor-paged and arrival-ordered; deletes are idempotent; foldPlan is count- and byte-bounded and always makes progress.',
);

// The landed check has three answers and the caller must not collapse them: "no"
// releases a reserved slot, "unknown" must leave the counter alone.
{
  const entry = { v: 1, received_at: 1700000000000, request_hash: HASH_A };
  const bucketWith = (behaviour) => ({
    head:
      behaviour === 'object'
        ? async () => ({ size: 10, etag: 'x' })
        : behaviour === 'null'
          ? async () => null
          : async () => {
              throw new Error('head unavailable');
            },
  });
  assert.equal(await logEntryLanded(bucketWith('object'), 'k'.repeat(24), entry), true);
  assert.equal(await logEntryLanded(bucketWith('null'), 'k'.repeat(24), entry), false);
  assert.equal(
    await logEntryLanded(bucketWith('throw'), 'k'.repeat(24), entry),
    null,
    'an unreadable answer is unknown, never false',
  );
  console.log(
    'PASS: the landed check answers yes / no / unknown, and unknown is never collapsed to no.',
  );
}

// A generation filter must be applied while reading, not after truncating keys: with
// stale entries first, a post-truncation filter returns nothing and the read path
// silently stops seeing the entries accepted after a reset.
{
  const bucket = memoryBucket();
  const stale = [];
  for (let i = 0; i < 3; i += 1) {
    const entry = {
      v: 1,
      generation: 'old',
      user_id: 'u',
      session_id: 's',
      request_id: `stale-${i}`,
      request_hash: createHash('sha256').update(`stale-${i}`).digest('hex'),
      fingerprint: 'f',
      received_at: 1700000000000 + i,
      messages: [],
    };
    await putLogEntry(bucket, 'user-key', entry);
    stale.push(entry);
  }
  for (let i = 0; i < 2; i += 1) {
    await putLogEntry(bucket, 'user-key', {
      v: 1,
      generation: 'new',
      user_id: 'u',
      session_id: 's',
      request_id: `fresh-${i}`,
      request_hash: createHash('sha256').update(`fresh-${i}`).digest('hex'),
      fingerprint: 'f',
      received_at: 1700000001000 + i,
      messages: [],
    });
  }
  const fresh = await listPending(bucket, 'user-key', { limit: 2, generation: 'new' });
  assert.equal(fresh.length, 2, 'the window must be filled with current-generation entries');
  assert.ok(fresh.every(({ entry }) => entry.generation === 'new'));
  const staleOnly = await listPending(bucket, 'user-key', { limit: 8, generation: 'old' });
  assert.equal(staleOnly.length, 3);
  console.log(
    'PASS: a generation filter fills the window from current entries even when every older key sorts first.',
  );
}
