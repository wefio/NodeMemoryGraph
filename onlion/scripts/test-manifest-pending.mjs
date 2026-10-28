/* eslint-disable no-console -- deliberate test/diagnostic output */
/**
 * Slice 1 of docs/design/add-append-log-and-fold-design.md, storage side:
 * the manifest's `pending` count, the lazy `nmg-shards-v4` bump, and log cleanup.
 *
 * The invariant worth protecting is negative: a user whose log is empty must
 * store exactly the bytes today's writer stores, so a deployment with the log
 * disabled (or drained) is indistinguishable on disk from the current one.
 * A second invariant is that the log prefix has one owner — this test seeds and
 * inspects entries through append-log.mjs's logPrefix, so clearLog() cannot
 * drift to a prefix the accept path does not write.
 *
 * No build, no Miniflare, no COS credentials: a bucket with the same five
 * operations (get/head/put/delete/list) plus the conditional-write contract is
 * enough. Usage: node scripts/test-manifest-pending.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { logPrefix } from "../backend/append-log.mjs";
import {
  STORAGE_FORMAT_V4,
  clearLog,
  commitManifest,
  keyFor,
  loadManifest,
  manifestFormat,
  pendingCount,
  resetUser,
  withPending,
} from "../backend/storage.mjs";

/**
 * In-memory bucket. `onlyIf.etagMatches` compares tags, `onlyIf.etagDoesNotMatch:'*'`
 * is first-create-only, and `list` pages with a stable key cursor so deleting
 * while paging behaves like COS/R2 (an index cursor would silently skip keys).
 */
function createMemoryBucket() {
  const objects = new Map(); // key -> { body, etag }
  const stats = { puts: 0, deletes: 0, lists: 0 };
  const etagOf = (body) => createHash("md5").update(body).digest("hex");
  return {
    objects,
    stats,
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      const buffer = Buffer.from(object.body, "utf8");
      return {
        key,
        size: buffer.length,
        etag: object.etag,
        arrayBuffer: async () =>
          buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        json: async () => JSON.parse(object.body),
      };
    },
    async head(key) {
      const object = objects.get(key);
      return object
        ? { key, size: Buffer.byteLength(object.body), etag: object.etag }
        : null;
    },
    async put(key, body, options = {}) {
      const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
      const onlyIf = options.onlyIf;
      if (onlyIf?.etagMatches && objects.get(key)?.etag !== onlyIf.etagMatches) return null;
      if (onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const etag = etagOf(text);
      objects.set(key, { body: text, etag });
      stats.puts++;
      return { key, etag, size: Buffer.byteLength(text) };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) if (objects.delete(key)) stats.deletes++;
    },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      stats.lists++;
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const rest = cursor ? keys.filter((key) => key > cursor) : keys;
      const page = rest.slice(0, limit);
      const truncated = rest.length > page.length;
      return {
        objects: page.map((key) => ({ key, size: Buffer.byteLength(objects.get(key).body) })),
        truncated,
        cursor: truncated ? page.at(-1) : null,
      };
    },
  };
}

const bodyOf = (bucket, key) => bucket.objects.get(key)?.body;
const keysUnder = (bucket, prefix) => [...bucket.objects.keys()].filter((key) => key.startsWith(prefix));
const entryName = (sequence, hashChar) => `${String(sequence).padStart(13, "0")}-${hashChar.repeat(64)}.json`;
const flat = () => ({ format: "nmg-shards-v2", parts: [], receipts: {} });

// 1. Format selection: pending decides v4, otherwise the existing v2/v3 rule.
{
  assert.equal(manifestFormat(flat()), "nmg-shards-v2");
  assert.equal(
    manifestFormat({ ...flat(), parts: [{ scope: "s", key: "k", bytes: 1, delta: { pages: {} } }] }),
    "nmg-shards-v3",
  );
  assert.equal(manifestFormat(withPending(flat(), 2)), STORAGE_FORMAT_V4);
  assert.equal(manifestFormat({ ...flat(), pending: 0 }), "nmg-shards-v2");
  // Pending dominates: a reader that cannot see the log must refuse the manifest.
  assert.equal(
    manifestFormat(withPending({ format: "nmg-shards-v3", parts: [{ delta: {} }], receipts: {} }, 1)),
    STORAGE_FORMAT_V4,
  );
  console.log("PASS: manifestFormat is v2/v3 without pending and v4 as soon as one entry is pending.");
}

// 2. pendingCount / withPending: pure, non-mutating, and zero means "no key".
{
  assert.equal(pendingCount(undefined), 0);
  assert.equal(pendingCount(flat()), 0);
  assert.equal(pendingCount({ ...flat(), pending: 0 }), 0);
  assert.equal(pendingCount({ ...flat(), pending: 7 }), 7);
  // loadManifest() rejects these as corruption; the counter itself stays total.
  assert.equal(pendingCount({ ...flat(), pending: -1 }), 0);
  assert.equal(pendingCount({ ...flat(), pending: "3" }), 0);

  const base = flat();
  const counted = withPending(base, 4);
  assert.equal(counted.pending, 4);
  assert.equal(base.pending, undefined, "withPending must not mutate its input");
  assert.equal(JSON.stringify(withPending(counted, 0)), JSON.stringify(base));
  assert.equal(JSON.stringify(withPending(withPending(base, 3), 0)), JSON.stringify(base));

  for (const bad of [-1, 1.5, Number.NaN, "2", undefined])
    assert.throws(() => withPending(base, bad), TypeError, `withPending(${String(bad)})`);
  console.log("PASS: withPending copies, drops the key at zero, and rejects non-counts.");
}

// 3. commitManifest: lazy bytes, v4 while pending, CAS still enforces one writer.
{
  const bucket = createMemoryBucket();
  const userKey = keyFor("pending-user");
  const manifestKey = `users/${userKey}/manifest.json`;
  const manifest = flat();

  assert.ok(await commitManifest(bucket, userKey, null, manifest));
  const withoutLog = bodyOf(bucket, manifestKey);
  assert.equal(withoutLog, JSON.stringify(flat()), "no pending entry must leave today's bytes");

  const current = await bucket.head(manifestKey);
  assert.ok(await commitManifest(bucket, userKey, current, withPending(manifest, 3)));
  const withLog = JSON.parse(bodyOf(bucket, manifestKey));
  assert.equal(withLog.format, STORAGE_FORMAT_V4);
  assert.equal(withLog.pending, 3);

  // A stale etag is still refused: the pending count rides the same CAS.
  assert.equal(await commitManifest(bucket, userKey, current, withPending(manifest, 1)), null);
  assert.equal(JSON.parse(bodyOf(bucket, manifestKey)).pending, 3);

  // A caller that passes `pending: 0` explicitly must not change the bytes.
  const stale = await bucket.head(manifestKey);
  assert.ok(await commitManifest(bucket, userKey, stale, { ...withLog, pending: 0 }));
  assert.equal(JSON.parse(bodyOf(bucket, manifestKey)).format, "nmg-shards-v2");
  assert.ok(!bodyOf(bucket, manifestKey).includes('"pending"'));

  // Folding the log drains it: the manifest returns to the exact v2 bytes.
  const drained = await bucket.head(manifestKey);
  assert.ok(await commitManifest(bucket, userKey, drained, withPending(JSON.parse(bodyOf(bucket, manifestKey)), 0)));
  assert.equal(bodyOf(bucket, manifestKey), withoutLog, "a drained log restores the v2 bytes");
  console.log("PASS: v4 only while pending is non-zero; a drained log round-trips to the v2 bytes.");
}

// 4. loadManifest accepts v4 and rejects anything a newer deployment wrote.
{
  const bucket = createMemoryBucket();
  const userKey = keyFor("load-user");
  const manifestKey = `users/${userKey}/manifest.json`;

  // Written by the real writer and read back: the pair cannot disagree.
  assert.ok(await commitManifest(bucket, userKey, null, withPending({ ...flat(), generation: "g" }, 2)));
  const loaded = await loadManifest(bucket, userKey, "load-user");
  assert.equal(loaded.manifest.format, STORAGE_FORMAT_V4);
  assert.equal(pendingCount(loaded.manifest), 2);
  assert.equal(loaded.manifest.generation, "g");

  await bucket.put(manifestKey, JSON.stringify(flat()));
  assert.equal((await loadManifest(bucket, userKey, "load-user")).manifest.format, "nmg-shards-v2");
  await bucket.put(manifestKey, JSON.stringify({ ...flat(), format: "nmg-shards-v3" }));
  assert.equal((await loadManifest(bucket, userKey, "load-user")).manifest.format, "nmg-shards-v3");
  // A v4 manifest written by a newer deployment loads even without a local writer.
  await bucket.put(manifestKey, JSON.stringify({ format: STORAGE_FORMAT_V4, parts: [], receipts: {}, pending: 1 }));
  assert.equal(pendingCount((await loadManifest(bucket, userKey, "load-user")).manifest), 1);

  const rejects = async (manifest, code) => {
    await bucket.put(manifestKey, JSON.stringify(manifest));
    await assert.rejects(loadManifest(bucket, userKey, "load-user"), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, 503);
      return true;
    });
  };
  // Rolling back to a build that does not know v4 must fail loudly, not serve a
  // partition set that is missing pending data.
  await rejects({ format: "nmg-shards-v5", parts: [], receipts: {} }, "storage_corrupt");
  await rejects({ format: STORAGE_FORMAT_V4, parts: [], receipts: {}, pending: -1 }, "storage_corrupt");
  await rejects({ format: STORAGE_FORMAT_V4, parts: [], receipts: {}, pending: 1.5 }, "storage_corrupt");
  // A missing manifest still resolves through the legacy image head.
  assert.deepEqual((await loadManifest(createMemoryBucket(), keyFor("absent"), "absent")).manifest, {
    format: "nmg-shards-v2",
    parts: [],
    receipts: {},
  });
  console.log("PASS: v4 loads, unknown formats and invalid pending counts fail as storage_corrupt.");
}

// 5. clearLog: prefix-scoped, paged, idempotent, and blind to neighbouring keys.
{
  const bucket = createMemoryBucket();
  const owner = keyFor("log-owner");
  const other = keyFor("log-other");
  const prefix = logPrefix(owner);
  const names = [entryName(1, "a"), entryName(2, "b")];
  for (const name of names) await bucket.put(prefix + name, JSON.stringify({ v: 1 }));
  await bucket.put(logPrefix(other) + names[0], JSON.stringify({ v: 1 }));
  for (const neighbour of [
    `users/${owner}/manifest.json`,
    `users/${owner}/login.json`,
    `users/${owner}/logx/keep.json`,
    `users/${owner}/parts/keep.sqlite`,
  ])
    await bucket.put(neighbour, "keep");

  assert.deepEqual(keysUnder(bucket, prefix).sort(), names.map((name) => prefix + name).sort());
  assert.equal(await clearLog(bucket, owner), names.length);
  assert.deepEqual(keysUnder(bucket, prefix), []);
  for (const neighbour of [
    `users/${owner}/manifest.json`,
    `users/${owner}/login.json`,
    `users/${owner}/logx/keep.json`,
    `users/${owner}/parts/keep.sqlite`,
    logPrefix(other) + names[0],
  ])
    assert.ok(bucket.objects.has(neighbour), `${neighbour} must survive`);
  assert.equal(await clearLog(bucket, owner), 0, "a repeated clear removes nothing");
  console.log("PASS: clearLog deletes only this user's log entries and repeats as a no-op.");
}

// 6. clearLog pages through a log larger than one list response.
{
  const bucket = createMemoryBucket();
  const owner = keyFor("log-bulk");
  const prefix = logPrefix(owner);
  const total = 1205;
  for (let sequence = 1; sequence <= total; sequence++)
    bucket.objects.set(prefix + entryName(sequence, "c"), { body: "{}", etag: "e" });

  assert.equal(await clearLog(bucket, owner), total);
  assert.deepEqual(keysUnder(bucket, prefix), []);
  assert.equal(bucket.stats.lists, 2, "1205 entries need two list pages");
  console.log("PASS: clearLog pages with a stable cursor and removes every page.");
}

// 7. resetUser clears the log after the generation barrier is committed.
{
  const bucket = createMemoryBucket();
  const userId = "reset-user";
  const userKey = keyFor(userId);
  const prefix = logPrefix(userKey);
  await commitManifest(bucket, userKey, null, withPending(flat(), 2));
  const names = [entryName(1, "d"), entryName(2, "e")];
  for (const name of names) await bucket.put(prefix + name, JSON.stringify({ v: 1, generation: "g1" }));
  const before = (await loadManifest(bucket, userKey, userId)).manifest;

  const reset = await resetUser(bucket, userId, "reset-1");
  assert.equal(reset.success, true);
  assert.equal(reset.cleanup_complete, true);
  assert.deepEqual(keysUnder(bucket, prefix), [], "the log prefix is emptied by reset");

  const after = (await loadManifest(bucket, userKey, userId)).manifest;
  assert.notEqual(after.generation, before.generation);
  assert.equal(pendingCount(after), 0);
  assert.equal(after.format, "nmg-shards-v2", "a reset manifest is v2, not v4");
  assert.ok(!bodyOf(bucket, `users/${userKey}/manifest.json`).includes('"pending"'));

  const replay = await resetUser(bucket, userId, "reset-1");
  assert.equal(replay.success, true);
  assert.equal(replay.cleanup_complete, true);
  console.log("PASS: reset empties the log, writes a v2 manifest, and replays idempotently.");
}

// 8. A reset whose log cleanup fails still succeeds; the same reset_id retries it.
{
  const bucket = createMemoryBucket();
  const userId = "reset-log-failure";
  const userKey = keyFor(userId);
  const prefix = logPrefix(userKey);
  for (const name of [entryName(3, "f"), entryName(4, "0")])
    await bucket.put(prefix + name, JSON.stringify({ v: 1, generation: "g1" }));
  const unavailable = { ...bucket, delete: async () => Promise.reject(new Error("COS unavailable")) };

  const reset = await resetUser(unavailable, userId, "reset-2");
  assert.equal(reset.success, true, "the manifest commit is the barrier; cleanup is retryable");
  assert.equal(reset.cleanup_complete, false);
  assert.equal(keysUnder(bucket, prefix).length, 2, "failed cleanup leaves the entries for the retry");

  const retried = await resetUser(bucket, userId, "reset-2");
  assert.equal(retried.success, true);
  assert.equal(retried.cleanup_complete, true);
  assert.deepEqual(keysUnder(bucket, prefix), []);
  console.log("PASS: a failed log cleanup reports incomplete and the same reset_id finishes it.");
}

console.log(
  "PASS: manifest pending/lazy-v4/clearLog verified without a build — " +
    "empty log keeps today's bytes, pending log is v4, reset drains the log.",
);
