/* eslint-disable no-console -- deliberate diagnostic output */
/**
 * Proves the COS adapter against the real bucket before anything is deployed:
 * the five storage operations, the conditional-write contract that
 * commitManifest() depends on, and concurrent-writer serialization.
 *
 * Credentials come from onlion/.env.cos.local (gitignored) or the environment.
 * Usage: node scripts/test-cos-bucket.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createCosBucket } from "../backend/cos-bucket.mjs";

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^"|"$/g, "")];
      }),
  );
}

const env = { ...loadEnvFile(path.resolve(import.meta.dirname, "../.env.cos.local")), ...process.env };
const bucket = createCosBucket({
  bucket: env.NMG_COS_BUCKET,
  region: env.NMG_COS_REGION,
  secretId: env.NMG_COS_SECRET_ID,
  secretKey: env.NMG_COS_SECRET_KEY,
  endpoint: env.NMG_COS_ENDPOINT || undefined,
});
// Same bucket, but every existing claim counts as stale: exercises takeover.
const impatient = createCosBucket({
  bucket: env.NMG_COS_BUCKET,
  region: env.NMG_COS_REGION,
  secretId: env.NMG_COS_SECRET_ID,
  secretKey: env.NMG_COS_SECRET_KEY,
  endpoint: env.NMG_COS_ENDPOINT || undefined,
  staleClaimMs: 0,
});

const run = `tests/cos-bucket/${randomUUID()}`;
const created = [];
const results = [];
let failed = 0;

function check(name, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failed++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

async function put(key, body, options) {
  created.push(key);
  return bucket.put(key, body, options);
}

async function main() {
  console.log(`bucket=${env.NMG_COS_BUCKET} region=${env.NMG_COS_REGION} run=${run}`);

  // 1. plain round trip, including the option surface storage.mjs uses
  const plain = `${run}/manifest.json`;
  const written = await put(plain, JSON.stringify({ format: "nmg-shards-v2", parts: [] }), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { format: "nmg-part-v2" },
  });
  check("put returns an etag", typeof written?.etag === "string" && written.etag.length > 0, JSON.stringify(written));
  const manifest = await bucket.get(plain);
  check("get returns size", manifest?.size > 0, String(manifest?.size));
  check("get returns etag", manifest?.etag === written?.etag, `${manifest?.etag} != ${written?.etag}`);
  check("get().json() parses", (await manifest.json()).format === "nmg-shards-v2");
  check("head matches get", (await bucket.head(plain))?.etag === written?.etag);
  check("missing get returns null", (await bucket.get(`${run}/absent.json`)) === null);
  check("missing head returns null", (await bucket.head(`${run}/absent.json`)) === null);

  // 2. etagDoesNotMatch:'*' — first-create barrier
  const fresh = `${run}/fresh.json`;
  const first = await put(fresh, JSON.stringify("one"), { onlyIf: { etagDoesNotMatch: "*" } });
  check("create-once succeeds on empty key", !!first);
  const second = await put(fresh, JSON.stringify("two"), { onlyIf: { etagDoesNotMatch: "*" } });
  check("create-once returns falsy when key exists", second === null, JSON.stringify(second));
  check("create-once did not overwrite", (await (await bucket.get(fresh)).json()) === "one");

  // 3. etagMatches — stale expectation must not overwrite
  const stale = await put(fresh, JSON.stringify("three"), { onlyIf: { etagMatches: first.etag } });
  check("etagMatches accepts the current etag", !!stale);
  const replayed = await put(fresh, JSON.stringify("four"), { onlyIf: { etagMatches: first.etag } });
  check("etagMatches rejects a stale etag", replayed === null, JSON.stringify(replayed));
  check("rejected write did not land", (await (await bucket.get(fresh)).json()) === "three");

  // 4. concurrent writers on one expected etag: exactly one must win
  const contested = `${run}/contested.json`;
  const base = await put(contested, JSON.stringify("seed"), { onlyIf: { etagDoesNotMatch: "*" } });
  const attempts = 8;
  const outcomes = await Promise.all(
    Array.from({ length: attempts }, (_, index) =>
      put(contested, JSON.stringify(`writer-${index}`), { onlyIf: { etagMatches: base.etag } })
        .then((value) => ({ index, wins: !!value }))
        .catch((error) => ({ index, error: error.code ?? error.message })),
    ),
  );
  const winners = outcomes.filter((outcome) => outcome.wins);
  const errors = outcomes.filter((outcome) => outcome.error);
  check(`${attempts} concurrent conditional puts -> exactly 1 winner`, winners.length === 1, JSON.stringify(outcomes));
  check("no concurrent put threw", errors.length === 0, JSON.stringify(errors));
  const landed = await (await bucket.get(contested)).json();
  check(
    "the winning body is what landed",
    winners.length === 1 && landed === `writer-${winners[0].index}`,
    `landed=${landed} winner=${winners[0]?.index}`,
  );

  // 5. stale claim takeover: a crashed writer must not wedge the user forever
  const wedged = `${run}/wedged.json`;
  const wedgeBase = await put(wedged, JSON.stringify("before"), { onlyIf: { etagDoesNotMatch: "*" } });
  const orphanClaimKey = `claims/${createHash("sha1").update(`${wedged}\0${wedgeBase.etag}`).digest("hex")}.json`;
  created.push(orphanClaimKey);
  await bucket.put(orphanClaimKey, JSON.stringify({ owner: "crashed-writer" }), { httpMetadata: { contentType: "application/json" } }, { forbidOverwrite: true }).catch(() => {});
  const takeover = await impatient.put(wedged, JSON.stringify("after"), { onlyIf: { etagMatches: wedgeBase.etag } });
  check("stale claim is taken over instead of blocking", !!takeover, JSON.stringify(takeover));
  check("takeover body landed", (await (await bucket.get(wedged)).json()) === "after");

  // 6. binary round trip at partition scale
  const blob = new Uint8Array(2 * 1024 * 1024);
  for (let index = 0; index < blob.length; index += 4096) blob[index] = index % 251;
  const blobKey = `${run}/parts/part.sqlite`;
  await put(blobKey, blob, { httpMetadata: { contentType: "application/vnd.sqlite3" } });
  const readBack = new Uint8Array(await (await bucket.get(blobKey)).arrayBuffer());
  check("2 MiB binary round trip is byte-identical", Buffer.compare(Buffer.from(blob), Buffer.from(readBack)) === 0);

  // 7. list with pagination (reclaimAll depends on cursor/truncated)
  const pagePrefix = `${run}/page/`;
  for (const name of ["a", "b", "c"]) await put(`${pagePrefix}${name}.json`, `{"n":"${name}"}`);
  const page1 = await bucket.list({ prefix: pagePrefix, limit: 2 });
  check("list honours the prefix", page1.objects.every((object) => object.key.startsWith(pagePrefix)), JSON.stringify(page1.objects));
  check("list returns sizes", page1.objects.every((object) => object.size > 0), JSON.stringify(page1.objects));
  check("list reports truncation with a cursor", page1.truncated === true && typeof page1.cursor === "string", JSON.stringify(page1));
  const page2 = await bucket.list({ prefix: pagePrefix, limit: 2, cursor: page1.cursor });
  const seen = new Set([...page1.objects, ...page2.objects].map((object) => object.key));
  check("paging visits every object exactly once", seen.size === 3, JSON.stringify([...seen]));

  // 8. batch delete (storage.mjs deletes arrays of retired shards)
  await bucket.delete([`${pagePrefix}a.json`, `${pagePrefix}b.json`, `${pagePrefix}c.json`]);
  const remaining = await bucket.list({ prefix: pagePrefix, limit: 10 });
  check("batch delete removes every key", remaining.objects.length === 0, JSON.stringify(remaining.objects));

  // 9. no claims left behind on the happy path
  const claims = await bucket.list({ prefix: "claims/", limit: 1000 });
  check("happy-path claims are released", claims.objects.length <= 1, `${claims.objects.length} claim objects in bucket`);

  await bucket.delete([...created, plain, fresh, contested, wedged, blobKey]);
  const after = await bucket.list({ prefix: run, limit: 1000 });
  check("cleanup removed the run prefix", after.objects.length === 0, JSON.stringify(after.objects.slice(0, 5)));
}

try {
  await main();
} catch (error) {
  failed++;
  results.push(`FAIL  harness threw — ${error.name}: ${error.message}`);
} finally {
  console.log(results.join("\n"));
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
