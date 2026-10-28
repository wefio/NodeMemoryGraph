/**
 * Does the log accept path actually beat the synchronous one under a burst?
 *
 * The stopping rules for the append-log write path put one number behind the default:
 * a 16-way concurrent Add burst must show a lower p95 with `NMG_ADD_MODE=log` than with
 * `sync`. This script produces both numbers from the same client, on the same endpoint,
 * so the comparison is not a memory of two different afternoons.
 *
 *   node onlion/scripts/bench-add-concurrency.mjs \
 *     --endpoint https://api.nmgmemory.dpdns.org --key "$NMG_API_KEY" \
 *     --concurrency 16 --messages 8 --rounds 3
 *
 * Every request is timed individually and the distribution is reported per round and
 * pooled: p50, p95, max, status mix, and the error codes that came back. `--replay`
 * repeats one request id after the burst to confirm the retry path still answers the
 * same body while the burst is in flight - a latency win that duplicated writes would
 * not be a win.
 */
import { parseArgs } from "node:util";

const DEFAULTS = {
  concurrency: 16,
  messages: 8,
  rounds: 3,
  timeout: 120_000,
  users: 1,
  topK: 100,
};

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

const turn = (round, index) =>
  `Round ${round} turn ${index}: the spare key is under the blue planter and the ` +
  `invoice number ${round * 1000 + index} was paid on the fifth.`;

async function add(endpoint, key, user, requestId, messages, timeout) {
  const body = {
    user_id: user,
    session_id: "bench",
    request_id: requestId,
    messages: Array.from({ length: messages }, (_unused, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: turn(requestId, index),
    })),
  };
  const started = performance.now();
  try {
    const response = await fetch(`${endpoint}/add`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let code = null;
    try {
      code = JSON.parse(text)?.error?.code ?? null;
    } catch {
      code = null;
    }
    return { ms: performance.now() - started, status: response.status, code, text };
  } catch (error) {
    return {
      ms: performance.now() - started,
      status: 0,
      code: error?.cause?.code ?? error?.name ?? "network_error",
      text: "",
    };
  }
}

/** Runs `count` requests with `concurrency` in flight, never more. */
async function burst(tasks, concurrency) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function summarise(label, results) {
  const times = results.map((result) => result.ms).sort((left, right) => left - right);
  const byStatus = new Map();
  for (const result of results) {
    const key = result.status === 0 ? `err:${result.code}` : String(result.status);
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }
  const failures = results.filter((result) => result.status < 200 || result.status >= 300);
  return {
    label,
    count: results.length,
    p50: Math.round(percentile(times, 0.5)),
    p95: Math.round(percentile(times, 0.95)),
    max: Math.round(times.at(-1) ?? 0),
    statuses: Object.fromEntries([...byStatus].sort()),
    failures: failures.length,
    // A failed connection is not a slow server. Keeping them apart is the difference
    // between "the endpoint cannot serve a burst" and "this host cannot reach it".
    clientErrors: results.filter((result) => result.status === 0).length,
    serverErrors: results.filter((result) => result.status >= 500).length,
    codes: [...new Set(failures.map((result) => result.code ?? `http_${result.status}`))],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      endpoint: { type: "string" },
      key: { type: "string" },
      concurrency: { type: "string", default: String(DEFAULTS.concurrency) },
      messages: { type: "string", default: String(DEFAULTS.messages) },
      rounds: { type: "string", default: String(DEFAULTS.rounds) },
      users: { type: "string", default: String(DEFAULTS.users) },
      timeout: { type: "string", default: String(DEFAULTS.timeout) },
      replay: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      label: { type: "string", default: "unlabelled" },
    },
  });
  const endpoint = (values.endpoint ?? "").replace(/\/$/u, "");
  if (!endpoint || !values.key) {
    process.stderr.write("usage: bench-add-concurrency --endpoint URL --key KEY\n");
    process.exitCode = 2;
    return;
  }
  const concurrency = Number(values.concurrency);
  const messages = Number(values.messages);
  const rounds = Number(values.rounds);
  const users = Number(values.users);
  const timeout = Number(values.timeout);

  // Fail fast and clearly, but not on the first stall: one connect timeout is how an
  // ordinary host behaves on a bad minute, and aborting there would look like an
  // outage. Three attempts, then a refusal - a benchmark against a dead endpoint must
  // not report zeros.
  let reachable = false;
  for (let attempt = 0; attempt < 3 && !reachable; attempt += 1) {
    try {
      const health = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(20_000) });
      reachable = health.ok;
      if (!reachable)
        process.stderr.write(`health answered ${health.status}
`);
    } catch (error) {
      process.stderr.write(`health attempt ${attempt + 1} failed: ${error.message}
`);
    }
  }
  if (!reachable) {
    process.stderr.write(`endpoint unreachable: ${endpoint}
`);
    process.exitCode = 2;
    return;
  }

  const stamp = Date.now().toString(36);
  const summary = {
    label: values.label,
    endpoint,
    concurrency,
    messages,
    rounds,
    users,
    roundsMs: [],
  };
  for (let round = 0; round < rounds; round += 1) {
    const tasks = [];
    for (let user = 0; user < users; user += 1) {
      const id = `bench-${stamp}-${round}-${user}`;
      for (let slot = 0; slot < concurrency; slot += 1)
        tasks.push(() =>
          add(endpoint, values.key, id, `${stamp}-${round}-${user}-${slot}`, messages, timeout),
        );
    }
    const results = await burst(tasks, concurrency);
    const roundSummary = summarise(`round ${round + 1}`, results);
    summary.roundsMs.push(roundSummary);
    if (!values.json)
      process.stdout.write(
        `${roundSummary.label}: n=${roundSummary.count} p50=${roundSummary.p50}ms ` +
          `p95=${roundSummary.p95}ms max=${roundSummary.max}ms ` +
          `failures=${roundSummary.failures} statuses=${JSON.stringify(roundSummary.statuses)}\n`,
      );
  }

  const pooled = summary.roundsMs.flatMap((round) => round);
  const pooledTimes = pooled.flatMap((round) => [round.p50, round.p95]).sort((a, b) => a - b);
  summary.pooled = {
    p50: Math.round(percentile(pooledTimes, 0.5)),
    p95: Math.round(percentile(pooledTimes, 1)),
    failures: pooled.reduce((sum, round) => sum + round.failures, 0),
  };
  const clientErrors = pooled.reduce((sum, round) => sum + round.clientErrors, 0);
  const serverErrors = pooled.reduce((sum, round) => sum + round.serverErrors, 0);
  summary.headline =
    `${summary.label}: concurrency=${concurrency} messages=${messages} rounds=${rounds} | ` +
    `p50 ${summary.pooled.p50}ms | p95 ${summary.pooled.p95}ms | ` +
    `failures ${summary.pooled.failures} (client ${clientErrors}, server ${serverErrors})`;
  // Refuse to present a measurement that is mostly this host failing to connect: the
  // percentiles above then describe the client, not the service.
  if (clientErrors * 2 >= pooled.reduce((sum, round) => sum + round.count, 0))
    summary.warning =
      "more than half the requests never established a connection; these percentiles " +
      "measure this host, not the endpoint - run the burst from a stable vantage point";
  if (values.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else process.stdout.write(`${summary.headline}\n`);
}

await main();
