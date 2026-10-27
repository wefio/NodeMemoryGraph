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
const results = [];
let failed = 0;

function check(name, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failed++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const put = (key, body, options) => bucket.put(key, body, options);
const readJson = async (key) => (await bucket.get(key)).json();

/** 1. plain round trip, including the option surface storage.mjs uses. */
async function scenarioRoundTrip() {
  const key = `${run}/manifest.json`;
  const body = JSON.stringify({ format: "nmg-shards-v2", parts: [] });
  const written = await put(key, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { format: "nmg-part-v2" },
  });
  check("put returns an etag", typeof written?.etag === "string" && written.etag.length > 0, JSON.stringify(written));
  const manifest = await bucket.get(key);
  check("get returns size", manifest?.size > 0, String(manifest?.size));
  check("get returns etag", manifest?.etag === written?.etag, `${manifest?.etag} != ${written?.etag}`);
  check("get().json() parses", (await manifest.json()).format === "nmg-shards-v2");
  check("head matches get", (await bucket.head(key))?.etag === written?.etag);
  check("missing get returns null", (await bucket.get(`${run}/absent.json`)) === null);
  check("missing head returns null", (await bucket.head(`${run}/absent.json`)) === null);
}

/**
 * 2 + 3. `etagDoesNotMatch:'*'` is the first-create barrier and `etagMatches`
 * must refuse a stale expectation. Both act on one key, so they share a scenario.
 */
async function scenarioConditionalWrites() {
  const key = `${run}/fresh.json`;
  const first = await put(key, JSON.stringify("one"), { onlyIf: { etagDoesNotMatch: "*" } });
  check("create-once succeeds on empty key", !!first);
  const second = await put(key, JSON.stringify("two"), { onlyIf: { etagDoesNotMatch: "*" } });
  check("create-once returns falsy when key exists", second === null, JSON.stringify(second));
  check("create-once did not overwrite", (await readJson(key)) === "one");

  const accepted = await put(key, JSON.stringify("three"), { onlyIf: { etagMatches: first.etag } });
  check("etagMatches accepts the current etag", !!accepted);
  const replayed = await put(key, JSON.stringify("four"), { onlyIf: { etagMatches: first.etag } });
  check("etagMatches rejects a stale etag", replayed === null, JSON.stringify(replayed));
  check("rejected write did not land", (await readJson(key)) === "three");
}

/** 4. concurrent writers on one expected etag: exactly one must win. */
async function scenarioConcurrentWriters() {
  const key = `${run}/contested.json`;
  const base = await put(key, JSON.stringify("seed"), { onlyIf: { etagDoesNotMatch: "*" } });
  const attempts = 8;
  const outcomes = await Promise.all(
    Array.from({ length: attempts }, (_, index) =>
      put(key, JSON.stringify(`writer-${index}`), { onlyIf: { etagMatches: base.etag } })
        .then((value) => ({ index, wins: !!value }))
        .catch((error) => ({ index, error: error.code ?? error.message })),
    ),
  );
  const winners = outcomes.filter((outcome) => outcome.wins);
  const errors = outcomes.filter((outcome) => outcome.error);
  check(`${attempts} concurrent conditional puts -> exactly 1 winner`, winners.length === 1, JSON.stringify(outcomes));
  check("no concurrent put threw", errors.length === 0, JSON.stringify(errors));
  const landed = await readJson(key);
  check(
    "the winning body is what landed",
    winners.length === 1 && landed === `writer-${winners[0].index}`,
    `landed=${landed} winner=${winners[0]?.index}`,
  );
}

/** 5. a crashed writer's claim must not wedge the user forever. */
async function scenarioStaleClaimTakeover() {
  const key = `${run}/wedged.json`;
  const base = await put(key, JSON.stringify("before"), { onlyIf: { etagDoesNotMatch: "*" } });
  const claimKey = `claims/${createHash("sha1").update(`${key}\0${base.etag}`).digest("hex")}.json`;
  await bucket.put(claimKey, JSON.stringify({ owner: "crashed-writer" }), {
    httpMetadata: { contentType: "application/json" },
  }, { forbidOverwrite: true }).catch(() => {});
  const takeover = await impatient.put(key, JSON.stringify("after"), { onlyIf: { etagMatches: base.etag } });
  check("stale claim is taken over instead of blocking", !!takeover, JSON.stringify(takeover));
  check("takeover body landed", (await readJson(key)) === "after");
}

/** 6. binary round trip at partition scale. */
async function scenarioBinaryRoundTrip() {
  const blob = new Uint8Array(2 * 1024 * 1024);
  for (let index = 0; index < blob.length; index += 4096) blob[index] = index % 251;
  const key = `${run}/parts/part.sqlite`;
  await put(key, blob, { httpMetadata: { contentType: "application/vnd.sqlite3" } });
  const readBack = new Uint8Array(await (await bucket.get(key)).arrayBuffer());
  check("2 MiB binary round trip is byte-identical", Buffer.compare(Buffer.from(blob), Buffer.from(readBack)) === 0);
}

/** 7. list with pagination (reclaimAll depends on cursor/truncated). */
async function scenarioListPagination() {
  const prefix = `${run}/page/`;
  for (const name of ["a", "b", "c"]) await put(`${prefix}${name}.json`, `{"n":"${name}"}`);
  const page1 = await bucket.list({ prefix, limit: 2 });
  check("list honours the prefix", page1.objects.every((object) => object.key.startsWith(prefix)), JSON.stringify(page1.objects));
  check("list returns sizes", page1.objects.every((object) => object.size > 0), JSON.stringify(page1.objects));
  check("list reports truncation with a cursor", page1.truncated === true && typeof page1.cursor === "string", JSON.stringify(page1));
  const page2 = await bucket.list({ prefix, limit: 2, cursor: page1.cursor });
  const seen = new Set([...page1.objects, ...page2.objects].map((object) => object.key));
  check("paging visits every object exactly once", seen.size === 3, JSON.stringify([...seen]));
}

/** 8. batch delete (storage.mjs deletes arrays of retired shards). */
async function scenarioBatchDelete() {
  const prefix = `${run}/page/`;
  await bucket.delete([`${prefix}a.json`, `${prefix}b.json`, `${prefix}c.json`]);
  const remaining = await bucket.list({ prefix, limit: 10 });
  check("batch delete removes every key", remaining.objects.length === 0, JSON.stringify(remaining.objects));
}

/** 9. no claims left behind on the happy path, and cleanup leaves nothing. */
async function scenarioHygieneAndCleanup() {
  const claims = await bucket.list({ prefix: "claims/", limit: 1000 });
  check("happy-path claims are released", claims.objects.length <= 1, `${claims.objects.length} claim objects in bucket`);
  const owned = await bucket.list({ prefix: run, limit: 1000 });
  if (owned.objects.length) await bucket.delete(owned.objects.map((object) => object.key));
  const after = await bucket.list({ prefix: run, limit: 1000 });
  check("cleanup removed the run prefix", after.objects.length === 0, JSON.stringify(after.objects.slice(0, 5)));
}

const SCENARIOS = [
  scenarioRoundTrip,
  scenarioConditionalWrites,
  scenarioConcurrentWriters,
  scenarioStaleClaimTakeover,
  scenarioBinaryRoundTrip,
  scenarioListPagination,
  scenarioBatchDelete,
  scenarioHygieneAndCleanup,
];

async function main() {
  console.log(`bucket=${env.NMG_COS_BUCKET} region=${env.NMG_COS_REGION} run=${run}`);
  for (const scenario of SCENARIOS) await scenario();
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
