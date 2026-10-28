/* eslint-disable no-console -- deliberate diagnostic output */
/**
 * Verifies a deployed EdgeOne endpoint over the network (the plan's acceptance
 * gate): reachability from where it runs, auth, one real Add/Search round trip,
 * idempotent replay, capacity, and the reset barrier.
 *
 * Usage:
 *   NMG_ENDPOINT=https://xxxx.edgeone.app NMG_API_KEY=... node scripts/smoke-edgeone.mjs
 */
const endpoint = (process.env.NMG_ENDPOINT ?? process.argv[2] ?? "").replace(/\/$/, "");
const apiKey = process.env.NMG_API_KEY ?? process.argv[3] ?? "";
if (!endpoint || !apiKey) {
  console.error("Usage: NMG_ENDPOINT=https://host NMG_API_KEY=... node scripts/smoke-edgeone.mjs");
  process.exit(2);
}

const userId = `smoke-${Date.now().toString(36)}`;
const results = [];
let failed = 0;

function check(name, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failed++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

async function call(route, body, key = apiKey) {
  const started = performance.now();
  const response = await fetch(`${endpoint}${route}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  const ms = Math.round(performance.now() - started);
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }
  return { status: response.status, body: parsed, raw, ms };
}

const routes = {
  add: ["/api/add", "/add"],
  search: ["/api/search", "/search"],
  health: ["/api/health", "/health"],
};

/** Picks the path shape the deployment actually answers. */
async function firstSupported(kind) {
  for (const route of routes[kind]) {
    const result = await call(route, kind === "health" ? undefined : { user_id: userId, query: "probe", top_k: 1 });
    if (result.status !== 404) return { route, result };
  }
  return { route: routes[kind][0], result: { status: 404, raw: "no route answered" } };
}

try {
  const health = await firstSupported("health");
  check(`${health.route} is reachable (${health.result.ms} ms)`, health.result.status === 200, `${health.result.status} ${health.result.raw?.slice(0, 200)}`);

  // Health is deliberately unauthenticated: the evaluation harness probes it with
  // no credential and expects 200, so the credential check must use a data route.
  const searchRoute = (await firstSupported("search")).route;
  const denied = await call(searchRoute, { user_id: userId, query: "probe", top_k: 1 }, "wrong-key");
  check("a wrong API key is rejected", denied.status === 401, String(denied.status));

  const add = await firstSupported("add");
  const addRoute = add.route;
  const first = await call(addRoute, {
    user_id: userId,
    session_id: "smoke",
    request_id: "smoke-1",
    messages: [{ role: "user", content: "The smoke test passphrase is copper kettle." }],
  });
  check(`POST ${addRoute} commits (${first.ms} ms)`, first.status === 200, `${first.status} ${first.raw?.slice(0, 300)}`);

  // A replay must be byte-identical. The same request_id with different content is
  // a conflict (409), which is the correct answer, not a failed idempotent retry —
  // so no volatile field may appear in this body.
  const replay = await call(addRoute, {
    user_id: userId,
    session_id: "smoke",
    request_id: "smoke-1",
    messages: [{ role: "user", content: "The smoke test passphrase is copper kettle." }],
  });
  check("replaying the same request_id is idempotent", replay.status === 200, `${replay.status}`);
  const search = await call(searchRoute, { user_id: userId, query: "smoke passphrase", top_k: 5 });
  const hits = search.body?.data ?? [];
  check(`POST ${searchRoute} retrieves the memory (${search.ms} ms)`, search.status === 200 && hits.length > 0, `${search.status} hits=${hits.length}`);
  check("retrieval mode is reported", typeof search.body?.retrieval_mode === "string", JSON.stringify(search.body?.retrieval_mode));

  const capacity = await call(`/api/capacity?user_id=${encodeURIComponent(userId)}`);
  check("/api/capacity answers", capacity.status === 200 && capacity.body?.sqlite_bytes?.used > 0, `${capacity.status} ${capacity.raw?.slice(0, 200)}`);

  const reset = await call("/api/reset", { user_id: userId, confirm_user_id: userId, reset_id: "smoke-reset" });
  check("/api/reset commits the barrier", reset.status === 200, `${reset.status} ${reset.raw?.slice(0, 200)}`);
  const afterReset = await call(searchRoute, { user_id: userId, query: "smoke passphrase", top_k: 5 });
  check("reset empties the user view", afterReset.status === 200 && (afterReset.body?.data ?? []).length === 0, JSON.stringify(afterReset.body?.data?.length));
} catch (error) {
  failed++;
  results.push(`FAIL  request threw — ${error.name}: ${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ""}`);
} finally {
  console.log(`endpoint ${endpoint}  user ${userId}`);
  console.log(results.join("\n"));
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
