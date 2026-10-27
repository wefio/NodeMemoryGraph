/* eslint-disable no-console -- deliberate diagnostic output */
/**
 * End-to-end check of the EdgeOne build against the real COS bucket, in-process
 * (no wrangler, no Miniflare): the built function's `worker` export is driven
 * with a COS-backed `MEMORY` binding, so the whole storage surface - manifest
 * CAS, partition writes, receipts, search deltas, reset - runs for real.
 *
 * Usage: node scripts/test-edgeone-worker.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCosBucket } from "../backend/cos-bucket.mjs";
import { keyFor } from "../backend/storage.mjs";
import { worker } from "../dist/edgeone/cloud-functions/[[default]].js";

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

const fileEnv = { ...loadEnvFile(path.resolve(import.meta.dirname, "../.env.cos.local")), ...process.env };
const bucket = createCosBucket({
  bucket: fileEnv.NMG_COS_BUCKET,
  region: fileEnv.NMG_COS_REGION,
  secretId: fileEnv.NMG_COS_SECRET_ID,
  secretKey: fileEnv.NMG_COS_SECRET_KEY,
  endpoint: fileEnv.NMG_COS_ENDPOINT || undefined,
});
// Counts COS round trips per request: the 120 s handler budget is spent on
// storage latency, so the operation profile has to be visible.
const counts = { get: 0, head: 0, put: 0, delete: 0, list: 0 };
const counted = Object.fromEntries(
  Object.entries(bucket).map(([name, fn]) => [
    name,
    (...args) => {
      counts[name]++;
      return fn(...args);
    },
  ]),
);
const env = {
  // Deliberately no NMG_EMBED_*: this probe validates the storage surface, and
  // inheriting a provider from the shell would turn every /add into an embedding
  // failure that has nothing to do with COS.
  NMG_COS_BUCKET: fileEnv.NMG_COS_BUCKET,
  NMG_COS_REGION: fileEnv.NMG_COS_REGION,
  NMG_COS_SECRET_ID: fileEnv.NMG_COS_SECRET_ID,
  NMG_COS_SECRET_KEY: fileEnv.NMG_COS_SECRET_KEY,
  MEMORY: counted,
  NMG_API_KEY: "test-key",
  NMG_OWNER_EMAIL: "owner@example.test",
  NMG_SELFTEST_TOKEN: "self-test-key",
  NMG_SELFTEST_EXPIRES_AT: String(Date.now() + 3_600_000),
};

const results = [];
let failed = 0;
const timings = [];

function check(name, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failed++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

async function call(route, body, { key = "test-key", headers = {} } = {}) {
  const started = performance.now();
  const before = { ...counts };
  const response = await worker.fetch(
    new Request(`http://localhost${route}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  );
  const raw = await response.text();
  const elapsed = Math.round(performance.now() - started);
  timings.push({ route, status: response.status, ms: elapsed, ops: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v - before[k]])) });
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }
  return { status: response.status, body: parsed, raw };
}

async function cleanup(userId) {
  const prefix = `users/${keyFor(userId)}`;
  const listed = await bucket.list({ prefix, limit: 1000 });
  if (!listed.objects.length) return 0;
  await bucket.delete(listed.objects.map((object) => object.key));
  return listed.objects.length;
}

const userId = `edgeone-probe-${randomUUID()}`;
const sessionId = "probe-session";

try {
  const health = await call("/health");
  check("/health is 200", health.status === 200, health.raw?.slice(0, 200));
  check("/health reports storage", health.body?.storage !== undefined || health.body?.status !== undefined, JSON.stringify(health.body)?.slice(0, 200));

  const unauthorised = await call("/search", { user_id: userId, query: "x" }, { key: "wrong" });
  check("/search with a bad key is 401", unauthorised.status === 401, String(unauthorised.status));

  const empty = await call("/add", { user_id: userId, messages: [] });
  check("/add with no messages fails fast with 400", empty.status === 400, String(empty.status));

  const first = await call("/add", {
    user_id: userId,
    session_id: sessionId,
    request_id: "probe-1",
    messages: [{ role: "user", content: "The launch codename is blue harbour.", timestamp: 1_704_067_200_000 }],
  });
  check("/add commits to COS", first.status === 200, first.raw?.slice(0, 300));

  const replay = await call("/add", {
    user_id: userId,
    session_id: sessionId,
    request_id: "probe-1",
    messages: [{ role: "user", content: "The launch codename is blue harbour.", timestamp: 1_704_067_200_000 }],
  });
  check("/add replay is idempotent", replay.status === 200 && replay.raw === first.raw, `${replay.status} ${replay.raw?.slice(0, 200)}`);

  const search = await call("/search", { user_id: userId, query: "launch codename", top_k: 5 });
  const hits = search.body?.data ?? [];
  check("/search reads what /add wrote", search.status === 200 && hits.length > 0, `${search.status} ${search.raw?.slice(0, 300)}`);

  const second = await call("/add", {
    user_id: userId,
    session_id: sessionId,
    request_id: "probe-2",
    messages: [{ role: "user", content: "The launch window moved to Thursday.", timestamp: 1_704_067_260_000 }],
  });
  check("second /add in the same session", second.status === 200, second.raw?.slice(0, 300));

  // Two writers on the same manifest: the CAS must serialize them, and the
  // worker's bounded retry (4 attempts) must absorb the conflict.
  const concurrent = await Promise.all([
    call("/add", {
      user_id: userId,
      session_id: sessionId,
      request_id: "probe-c1",
      messages: [{ role: "user", content: "Concurrent write alpha.", timestamp: 1_704_067_320_000 }],
    }),
    call("/add", {
      user_id: userId,
      session_id: sessionId,
      request_id: "probe-c2",
      messages: [{ role: "user", content: "Concurrent write beta.", timestamp: 1_704_067_330_000 }],
    }),
  ]);
  check(
    "concurrent /add both settle without losing data",
    concurrent.every((result) => result.status === 200),
    concurrent.map((result) => result.status).join(","),
  );
  const afterConcurrent = await call("/search", { user_id: userId, query: "concurrent write", top_k: 10 });
  const concurrentHits = afterConcurrent.body?.data ?? [];
  check("both concurrent writes are retrievable", concurrentHits.length >= 2, `${concurrentHits.length} hits`);

  const capacity = await call("/capacity?user_id=" + encodeURIComponent(userId));
  check("/capacity reads the manifest", capacity.status === 200 && capacity.body?.sqlite_bytes?.used > 0, `${capacity.status} ${capacity.raw?.slice(0, 200)}`);

  const reset = await call("/reset", { user_id: userId, confirm_user_id: userId, reset_id: "probe-reset" });
  check("/reset commits the barrier manifest", reset.status === 200, reset.raw?.slice(0, 300));
  const afterReset = await call("/search", { user_id: userId, query: "launch codename", top_k: 5 });
  const resetHits = afterReset.body?.data ?? [];
  check("/reset empties the user view", afterReset.status === 200 && resetHits.length === 0, `${afterReset.status} ${resetHits.length} hits`);

  const removed = await cleanup(userId);
  check("probe objects cleaned up", removed > 0, `${removed} objects`);
} catch (error) {
  failed++;
  results.push(`FAIL  harness threw — ${error.name}: ${error.message}\n${error.stack?.split("\n").slice(0, 4).join("\n")}`);
} finally {
  console.log(results.join("\n"));
  console.log("\nrequest timings (ms):");
  for (const timing of timings)
    console.log(`  ${String(timing.status)} ${timing.route.padEnd(18)} ${String(timing.ms).padStart(5)} ms  ${Object.entries(timing.ops).map(([k, v]) => k + "=" + v).join(" ")}`);
  const slowest = timings.reduce((worst, timing) => Math.max(worst, timing.ms), 0);
  console.log(`  slowest ${slowest} ms`);
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
