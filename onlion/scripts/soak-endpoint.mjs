/* Endpoint soak: the same shape the evaluation uses, from your network.
 *
 * The failures worth reproducing are connection-level ones - `PARTICIPANT_ENDPOINT_UNAVAILABLE`
 * and `ADD_CONNECTION_FAILED` - where the platform log looks normal because the request either
 * never arrived or the client gave up before it answered. Those cannot be seen from a single
 * request, and they cannot be seen from a machine behind a proxy, so this runs the harness's own
 * order from wherever you point it: preflight, a concurrent Add phase, then a concurrent Search
 * phase.
 *
 *   node onlion/scripts/soak-endpoint.mjs --endpoint https://... --key <key> [--concurrency 16]
 *
 * Nothing is written to a shared user: every run gets its own user id, so it cannot disturb a
 * scored run's data. Exit code is 1 when anything failed, so it can gate a run.
 */
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map((pair) => {
      const [name, ...rest] = pair.trim().split(/[= ]/);
      return [name, rest.join(" ")];
    }),
);
const endpoint = (args.endpoint ?? process.env.NMG_ENDPOINT ?? "").replace(/\/+$/, "");
const key = args.key ?? process.env.NMG_API_KEY ?? "";
const concurrency = Number(args.concurrency ?? 16);
const adds = Number(args.adds ?? 32);
const queries = Number(args.queries ?? 16);
if (!endpoint || !key) {
  console.error("usage: node soak-endpoint.mjs --endpoint <url> --key <key> [--concurrency 16]");
  process.exit(2);
}

const user = `soak-${Date.now().toString(36)}`;
const post = async (path, body) => {
  const started = Date.now();
  try {
    const response = await fetch(endpoint + path, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
    return { status: response.status, ms: Date.now() - started, body: await response.json().catch(() => null) };
  } catch (error) {
    // No status at all is the interesting outcome: it is the connection-level failure.
    return { status: 0, ms: Date.now() - started, error: error?.cause?.code ?? error?.name ?? "unknown" };
  }
};
const summarise = (label, results) => {
  const byStatus = {};
  for (const result of results) byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
  const times = results.map((result) => result.ms).sort((a, b) => a - b);
  const errors = [...new Set(results.filter((result) => result.error).map((result) => result.error))];
  console.log(
    `${label}: n=${results.length} statuses=${JSON.stringify(byStatus)} ` +
      `p50=${times[Math.floor(times.length / 2)]}ms max=${times.at(-1)}ms` +
      (errors.length ? ` connection_errors=${errors.join(",")}` : ""),
  );
  return results.every((result) => result.status === 200);
};

// 1. Preflight, twice: the evaluation's first call is a health probe, and a cold instance is
//    where it is most likely to be slow.
for (const attempt of [1, 2]) {
  const started = Date.now();
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(60_000) });
    console.log(`health ${attempt}: ${response.status} ${Date.now() - started}ms`);
  } catch (error) {
    console.log(`health ${attempt}: FAILED ${error?.cause?.code ?? error?.name}`);
  }
}

const burst = async (makeRequest, count) => {
  const queue = [...Array(count).keys()];
  const results = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const index = queue.shift();
        results.push(await makeRequest(index));
      }
    }),
  );
  return results;
};

// 2. Add phase.
const addResults = await burst(
  (index) =>
    post("/add", {
      user_id: user,
      session_id: "soak",
      request_id: `add-${index}`,
      messages: [{ role: "user", content: `soak note ${index} about tide ${7000 + index}` }],
    }),
  adds,
);
const addOk = summarise("add", addResults);

// 3. Search phase, top_k 100 like the harness.
const searchResults = await burst(
  (index) =>
    post("/search", {
      user_id: user,
      query: `what did we record about the tide and the pier in note ${index}`,
      top_k: 100,
    }),
  queries,
);
const searchOk = summarise("search", searchResults);

if (!addOk || !searchOk) {
  console.error("FAILED: at least one request did not answer 200");
  process.exit(1);
}
console.log(`PASS: ${adds} adds and ${queries} searches at concurrency ${concurrency}`);
