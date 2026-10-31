// Watch the deployed endpoint from a client's point of view, one line per attempt.
//
// Why this and not only the platform's `schedules` beat: a scheduled beat proves the platform
// invoked the function, which is the one thing a client cannot prove. A client poll proves what the
// benchmark actually experiences - reachability, status, latency and the revision that answered -
// and it can do it right now, without a deploy and without waiting a day to learn whether the cron
// expression was honoured.
//
// Usage:
//   node scripts/watch-endpoint.mjs --once
//   node scripts/watch-endpoint.mjs --interval 1800          # loop every 30 minutes
//   node scripts/watch-endpoint.mjs --interval 900 --beat     # also POST /beat (deployed 2026-10-31+)
//
// Each attempt appends one JSON line to onlion/.runtime/watch/heartbeat.jsonl (gitignored). Every
// attempt is written, including the failures, so a gap can be told apart from a failure: a missing
// line means the watcher was not running, a failed line means the endpoint did not answer.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = value("--url", process.env.NMG_WATCH_URL ?? "https://api.nmgmemory.dpdns.org");
const intervalSeconds = Number(value("--interval", "1800"));
const outPath = path.resolve(
  value("--out", path.join(process.cwd(), ".runtime", "watch", "heartbeat.jsonl")),
);
const beat = flag("--beat");
const timeoutMs = Number(value("--timeout", "20000"));
fs.mkdirSync(path.dirname(outPath), { recursive: true });

async function probe(target) {
  const started = Date.now();
  try {
    const response = await fetch(base + target, {
      method: target === "/beat" ? "POST" : "GET",
      ...(target === "/beat" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 120) };
    }
    return { target, ok: response.ok, status: response.status, ms: Date.now() - started, body };
  } catch (error) {
    return {
      target,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: String(error?.name ?? error) + (error?.message ? ": " + error.message : ""),
    };
  }
}

async function tick() {
  const health = await probe("/health");
  const record = {
    at: new Date().toISOString(),
    url: base,
    ok: health.ok,
    status: health.status,
    ms: health.ms,
    revision: health.body?.source_revision ?? null,
    storage: health.body?.storage ?? null,
    ...(health.error ? { error: health.error } : {}),
    ...(beat ? { beat: await probe("/beat") } : {}),
  };
  fs.appendFileSync(outPath, JSON.stringify(record) + "\n");
  process.stdout.write(
    record.at +
      "  " +
      (record.ok ? "ok  " : "FAIL") +
      "  " +
      String(record.status).padStart(3) +
      "  " +
      String(record.ms).padStart(6) +
      " ms  rev=" +
      (record.revision ?? "-") +
      (record.error ? "  " + record.error : "") +
      "\n",
  );
  if (beat && record.beat && record.beat.status !== 200)
    process.stdout.write("         /beat answered " + record.beat.status + "\n");
}

if (flag("--once")) {
  await tick();
} else {
  await tick();
  const timer = setInterval(tick, Math.max(60, intervalSeconds) * 1000);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.write(
    "watching " + base + " every " + intervalSeconds + " s; log: " + outPath + "\n",
  );
}
