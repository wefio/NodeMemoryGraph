/* eslint-disable no-console -- deliberate test/diagnostic output */
/**
 * Slice 1 of docs/design/add-append-log-and-fold-design.md, storage side:
 * the manifest's `pending` count, the lazy `nmg-shards-v4` bump, and log cleanup.
 *
 * The invariant worth protecting is negative: a user whose log is empty must
 * store exactly the bytes today's writer stores, so a deployment with the log
 * disabled (or drained) is indistinguishable on disk from the current one.
 * A second invariant is that the log prefix has exactly one definition. storage.mjs
 * takes it from append-log.mjs's logPrefix() (see the design's clearLog note), so
 * this test spells the frozen name out literally and requires both the entries it
 * seeds and the prefix that function returns to agree with it.
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
  newPart,
  pendingCount,
  resetUser,
  setPending,
  stageSearchPart,
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
// The frozen name from the design, spelled out rather than derived: clearLog()
// must delete what the accept path wrote even if append-log.mjs renames its
// prefix, so the test seeds with the literal and checks the function against it.
const frozenPrefix = (userKey) => `users/${userKey}/log/`;
const flat = () => ({ format: "nmg-shards-v2", parts: [], receipts: {} });

assert.equal(logPrefix(keyFor("prefix-contract")), frozenPrefix(keyFor("prefix-contract")));
assert.equal(logPrefix("abc123"), "users/abc123/log/");

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

// 2b. setPending is the in-place form the worker actually calls, and the reason it
// exists: Object.assign(manifest, withPending(manifest, 0)) keeps the old key, so a
// drain would never delete it and the manifest would stay v4 forever.
{
  const v4 = () => ({ format: STORAGE_FORMAT_V4, parts: [], receipts: {}, pending: 7 });
  const manifest = v4();
  assert.equal(setPending(manifest, 3), 3);
  assert.equal(manifest.pending, 3, "setPending must work in place");
  assert.equal(setPending(manifest, 0), 0);
  assert.ok(!("pending" in manifest), "zero must delete the key, not store 0");
  // Byte equality with the same manifest that never carried a pending key; the
  // format string is commitManifest's job, not setPending's.
  assert.equal(
    JSON.stringify(manifest),
    JSON.stringify({ format: STORAGE_FORMAT_V4, parts: [], receipts: {} }),
  );

  // The bug that shipped once: assigning a key-less copy cannot delete a key, so a
  // drain left `pending: 7` behind and the manifest stayed v4 forever.
  const trapped = v4();
  Object.assign(trapped, withPending(trapped, 0));
  assert.equal(trapped.pending, 7, "documents why callers must use setPending, not Object.assign");
  setPending(trapped, 0);
  assert.ok(!("pending" in trapped));

  // Both forms must agree on the stored bytes: if only one of them is ever changed,
  // the drift comes back through the other one.
  const copied = withPending(v4(), 0);
  const inPlace = v4();
  setPending(inPlace, 0);
  assert.equal(JSON.stringify(copied), JSON.stringify(inPlace));
  const two = v4();
  assert.equal(setPending(two, 2), 2, "setPending returns the stored count, not the manifest");
  assert.equal(JSON.stringify(two), JSON.stringify(withPending(v4(), 2)));

  for (const bad of [-1, 1.5, Number.NaN, "2", undefined])
    assert.throws(() => setPending(v4(), bad), TypeError, `setPending(${String(bad)})`);
  console.log("PASS: setPending writes in place, deletes the key at zero, and refuses non-counts.");
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
  const prefix = frozenPrefix(owner);
  const names = [entryName(1, "a"), entryName(2, "b")];
  for (const name of names) await bucket.put(prefix + name, JSON.stringify({ v: 1 }));
  await bucket.put(frozenPrefix(other) + names[0], JSON.stringify({ v: 1 }));
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
    frozenPrefix(other) + names[0],
  ])
    assert.ok(bucket.objects.has(neighbour), `${neighbour} must survive`);
  assert.equal(await clearLog(bucket, owner), 0, "a repeated clear removes nothing");

  // A key that could step outside its own tree must be refused before anything is
  // listed. String equality alone would not catch a later divergence in validation.
  const listsBefore = bucket.stats.lists;
  for (const key of ["a/b", "a\\b", "..", ".", ""])
    await assert.rejects(clearLog(bucket, key), RangeError, `clearLog(${JSON.stringify(key)})`);
  assert.equal(bucket.stats.lists, listsBefore, "a rejected key must not reach the bucket");
  assert.throws(() => logPrefix("a/b"), RangeError);
  console.log("PASS: clearLog deletes only this user's log entries, repeats as a no-op, and refuses escaping keys.");
}

// 6. clearLog pages through a log larger than one list response.
{
  const bucket = createMemoryBucket();
  const owner = keyFor("log-bulk");
  const prefix = frozenPrefix(owner);
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
  const prefix = frozenPrefix(userKey);
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
  const prefix = frozenPrefix(userKey);
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

{
  // A search retry re-stages the partition it just uploaded. Passing `reuse` makes
  // that free for identical content, and - the part that is easy to lose - it is how
  // the abandoned attempt's snapshot stays reachable for cleanup after a later
  // attempt commits. Without the argument the request still succeeds while uploading
  // a whole snapshot per retry that no cleanup can name, so the assertion is on both
  // effects of the same call.
  const bucket = createMemoryBucket();
  const userKey = keyFor("search-reuse");
  const part = newPart("search-reuse");
  const snapshot = Buffer.from("nmg-part-v2 snapshot bytes");
  const resultOf = { snapshot, previousImage: null };
  const reuse = new Map();

  const first = await stageSearchPart(bucket, userKey, part, resultOf, 0, true, reuse);
  assert.equal(first.mode, "full_snapshot");
  assert.equal(bucket.stats.puts, 1, "the first staging uploads once");
  assert.ok(
    [...reuse.values()].includes(first.stagedKey),
    "a staged search snapshot must be registered so an abandoned attempt can be collected",
  );

  const second = await stageSearchPart(bucket, userKey, part, resultOf, 0, true, reuse);
  assert.equal(second.stagedKey, first.stagedKey, "identical content reuses the upload");
  assert.equal(bucket.stats.puts, 1, "a retry with the same content must not upload again");

  // The behaviour a caller gets by forgetting the argument: correct on the wire,
  // duplicated on the bucket. Spelled out so the difference is visible in a diff.
  const forgetful = createMemoryBucket();
  const forgotten = newPart("search-reuse");
  await stageSearchPart(forgetful, userKey, forgotten, resultOf, 0, true);
  await stageSearchPart(forgetful, userKey, forgotten, resultOf, 0, true);
  assert.equal(forgetful.stats.puts, 2, "without reuse every attempt uploads another snapshot");

  console.log(
    "PASS: a search staging call forwards reuse — identical content uploads once and the key stays registered for cleanup.",
  );
}
