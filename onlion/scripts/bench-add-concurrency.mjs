/**
 * Does the log accept path actually beat the synchronous one under a burst?
 *
 * The stopping rules for the append-log write path put one number behind the default:
 * a 16-way concurrent Add burst must show a lower p95 with the log accept path than with
 * `sync`. This produces both numbers from the same client against the same endpoint.
 *
 * Three things it deliberately does differently from a naive burst loop:
 *
 *  - **one user per run, not per round.** A fresh user per round peaks at `concurrency`
 *    pending entries, below `FOLD_TRIGGER`, so a burst benchmark would never fold at all
 *    and would measure accept while calling it the write path.
 *  - **folds are derived, not read.** The service exposes no fold counter, so each round
 *    samples `pending_entries` before and after and derives how many folds must have run.
 *  - **the fold cost is isolated.** `--mode fold` warms pending to one below the trigger
 *    and then times a single Add, which is the request that must pay both.
 *
 * A percentile needs enough samples to exist: with fewer than twenty the 0.95 quantile is
 * the maximum, so per-round lines are labelled `p95(=max)` and only the pooled figure -
 * `concurrency x rounds` - is quoted as a p95.
 *
 * Rounds are grouped by `crossedTrigger` (`pendingBefore + accepted >= FOLD_TRIGGER`):
 * a round that crosses contains the request that had to fold. It is `null` when the
 * counter could not be read, and `null` is excluded from the clean group rather than
 * counted as clean.
 *
 * Failed *connections* are reported apart from server failures, and a run where most
 * requests never connected says so instead of publishing percentiles about this host.
 *
 *   node onlion/scripts/bench-add-concurrency.mjs \
 *     --endpoint https://api.nmgmemory.dpdns.org --key "$KEY" \
 *     --concurrency 16 --messages 8 --rounds 3 --warmup 1 \
 *     --owner owner@example.test --add-mode log
 */
import { parseArgs } from "node:util";

const FOLD_BATCH = 8;
const FOLD_TRIGGER = 24;

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

const turn = (tag, index) =>
  `Burst ${tag} turn ${index}: the spare key is under the blue planter and the ` +
  `invoice number ${tag}-${index} was paid on the fifth.`;

function addBody(user, requestId, messages) {
  return {
    user_id: user,
    session_id: "bench",
    request_id: requestId,
    messages: Array.from({ length: messages }, (_unused, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: turn(requestId, index),
    })),
  };
}

async function request(url, options) {
  const started = performance.now();
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    // The parsed body is kept for the capacity reads and dropped before serialisation: a
    // page of records per request would dominate the JSON and say nothing about timing.
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      ms: performance.now() - started,
      status: response.status,
      code: body?.error?.code ?? null,
      body,
    };
  } catch (error) {
    return {
      ms: performance.now() - started,
      status: 0,
      code: error?.cause?.code ?? error?.name ?? "network_error",
      body: null,
    };
  }
}

const add = (endpoint, key, user, requestId, messages, timeout) =>
  request(`${endpoint}/add`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(addBody(user, requestId, messages)),
    signal: AbortSignal.timeout(timeout),
  });

/** Waiting entries for one user, or null when the endpoint cannot say. */
async function pendingOf(endpoint, key, user, timeout) {
  const result = await request(`${endpoint}/capacity?user_id=${encodeURIComponent(user)}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeout),
  });
  if (result.status !== 200) return null;
  return result.body?.pending_entries ?? null;
}

/** Drains the log so a measurement can start from zero. Best effort: without an owner
 *  credential this is a 401, and the run continues with whatever pending it found. */
async function drain(endpoint, key, user, owner, timeout) {
  if (!owner) return { drained: false, reason: "no --owner, skipped" };
  const result = await request(`${endpoint}/admin/fold?user_id=${encodeURIComponent(user)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "oai-authenticated-user-email": owner,
      origin: endpoint,
    },
    signal: AbortSignal.timeout(timeout),
  });
  return { drained: result.status === 200, status: result.status, code: result.code };
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

/** Timing fields only: the parsed body exists for the capacity reads, not for the report. */
const timing = ({ ms, status, code }) => ({ ms: Math.round(ms), status, code });

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
    // Below 20 samples the 0.95 quantile lands on the last sample, so calling it a p95
    // would invite a decision on a maximum.
    p95IsMax: times.length < 20,
    max: Math.round(times.at(-1) ?? 0),
    statuses: Object.fromEntries([...byStatus].sort()),
    failures: failures.length,
    clientErrors: results.filter((result) => result.status === 0).length,
    serverErrors: results.filter((result) => result.status >= 500).length,
    codes: [...new Set(failures.map((result) => result.code ?? `http_${result.status}`))],
  };
}

const stats = (times) => ({
  n: times.length,
  p50: Math.round(percentile(times, 0.5)),
  p95: Math.round(percentile(times, 0.95)),
  p95IsMax: times.length < 20,
});

/** How many folds must have run: pending grew by the accepts that succeeded and shrank by
 *  what each fold absorbed. Derived, because the service exposes no fold counter.
 *
 *  Only meaningful with the log accept path: in `sync` mode an accepted Add never becomes a
 *  pending entry, so the same arithmetic would invent folds that cannot exist. */
function deriveFolds(addMode, before, accepted, after) {
  if (addMode !== "log") return 0;
  if (before === null || after === null) return null;
  const absorbed = before + accepted - after;
  if (absorbed < 0) return 0;
  return Math.round(absorbed / FOLD_BATCH);
}

function parseOptions() {
  const { values } = parseArgs({
    options: {
      endpoint: { type: "string" },
      key: { type: "string" },
      concurrency: { type: "string", default: "16" },
      messages: { type: "string", default: "8" },
      rounds: { type: "string", default: "3" },
      warmup: { type: "string", default: "1" },
      timeout: { type: "string", default: "120000" },
      mode: { type: "string", default: "burst" },
      "add-mode": { type: "string", default: "sync" },
      owner: { type: "string" },
      json: { type: "boolean", default: false },
      label: { type: "string", default: "unlabelled" },
    },
  });
  const endpoint = (values.endpoint ?? "").replace(/\/$/u, "");
  if (!endpoint || !values.key) {
    process.stderr.write("usage: bench-add-concurrency --endpoint URL --key KEY\n");
    process.exitCode = 2;
    return null;
  }
  if (values.mode !== "burst" && values.mode !== "fold") {
    process.stderr.write(`unknown --mode: ${values.mode} (burst | fold)\n`);
    process.exitCode = 2;
    return null;
  }
  return {
    endpoint,
    key: values.key,
    concurrency: Number(values.concurrency),
    messages: Number(values.messages),
    rounds: Number(values.rounds),
    warmup: Number(values.warmup),
    timeout: Number(values.timeout),
    mode: values.mode,
    addMode: values["add-mode"],
    owner: values.owner,
    json: values.json,
    label: values.label,
  };
}

/** Three attempts: one stall is how an ordinary host behaves on a bad minute, but a
 *  benchmark against a dead endpoint must not report zeros. */
async function waitForEndpoint(endpoint) {
  let server = null;
  for (let attempt = 0; attempt < 3 && server === null; attempt += 1) {
    try {
      const health = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(20_000) });
      if (health.ok) server = await health.json();
      else process.stderr.write(`health answered ${health.status}\n`);
    } catch (error) {
      process.stderr.write(`health attempt ${attempt + 1} failed: ${error.message}\n`);
    }
  }
  return server;
}

async function runFoldMode(config, summary) {
  // One below the trigger, untimed, so the single timed Add is the request that pays a
  // fold. Its cost is an upper bound on what folding adds to one Add.
  for (let index = 0; index < FOLD_TRIGGER - 1; index += 1)
    await add(config.endpoint, config.key, summary.user, `${summary.stamp}-pre-${index}`, config.messages, config.timeout);
  const before = await pendingOf(config.endpoint, config.key, summary.user, config.timeout);
  const timed = await add(config.endpoint, config.key, summary.user, `${summary.stamp}-boundary`, config.messages, config.timeout);
  const after = await pendingOf(config.endpoint, config.key, summary.user, config.timeout);
  summary.boundary = {
    ...summarise("fold boundary", [timed]),
    sample: timing(timed),
    pendingBefore: before,
    pendingAfter: after,
    foldsDerived: deriveFolds(summary.server.add_mode ?? config.addMode, before, timed.status === 200 ? 1 : 0, after),
  };
  // One sample: there is no percentile to report, only that measurement, and it is an
  // upper bound on what folding adds to one Add.
  if (!config.json)
    process.stdout.write(
      `fold boundary (single sample, upper bound): status ${summary.boundary.sample.status} ` +
        `in ${summary.boundary.sample.ms}ms | pending ${before} -> ${after} | ` +
        `folds derived=${summary.boundary.foldsDerived}\n`,
    );
}

async function runBurstMode(config, summary) {
  for (let round = 0; round < config.rounds; round += 1) {
    // Drain before each round when a credential allows it: otherwise only the first round
    // sits below the fold trigger, the clean group collapses to one round (n=16, a maximum
    // rather than a p95), and the gate has nothing to quote.
    if (config.owner) await drain(config.endpoint, config.key, summary.user, config.owner, config.timeout);
    const before = await pendingOf(config.endpoint, config.key, summary.user, config.timeout);
    const tasks = Array.from(
      { length: config.concurrency },
      (_unused, slot) => () =>
        add(config.endpoint, config.key, summary.user, `${summary.stamp}-${round}-${slot}`, config.messages, config.timeout),
    );
    const results = await burst(tasks, config.concurrency);
    const after = await pendingOf(config.endpoint, config.key, summary.user, config.timeout);
    const roundSummary = summarise(`round ${round + 1}`, results);
    roundSummary.samples = results.map(timing);
    roundSummary.pendingBefore = before;
    roundSummary.pendingAfter = after;
    roundSummary.accepted = results.filter((result) => result.status === 200).length;
    roundSummary.crossedTrigger =
      before === null ? null : before + roundSummary.accepted >= FOLD_TRIGGER;
    roundSummary.foldsDerived = deriveFolds(
      summary.server.add_mode ?? config.addMode,
      before,
      roundSummary.accepted,
      after,
    );
    if (summary.server.add_mode === "sync" && (before !== 0 || after !== 0))
      roundSummary.modeMismatch =
        `declared sync but pending moved ${before}->${after}; the deployment may be running the log path`;
    summary.rounds.push(roundSummary);
    if (!config.json)
      process.stdout.write(
        `${roundSummary.label}: n=${roundSummary.count} p50=${roundSummary.p50}ms ` +
          `${roundSummary.p95IsMax ? "p95(=max)" : "p95"}=${roundSummary.p95}ms ` +
          `max=${roundSummary.max}ms failures=${roundSummary.failures} ` +
          `(client=${roundSummary.clientErrors} server=${roundSummary.serverErrors}) ` +
          `pending ${before}->${after} folds~${roundSummary.foldsDerived} ` +
          `crossed=${roundSummary.crossedTrigger} statuses=${JSON.stringify(roundSummary.statuses)}\n`,
      );
  }
  summariseBurst(summary, config);
}

function summariseBurst(summary, config) {
  const pooledTimes = summary.rounds
    .flatMap((round) => round.samples.map((sample) => sample.ms))
    .sort((left, right) => left - right);
  // "clean" = rounds that provably never crossed the fold trigger. A round whose pending
  // counter could not be read is not clean, it is unknown.
  const cleanTimes = summary.rounds
    .filter((round) => round.crossedTrigger === false)
    .flatMap((round) => round.samples.map((sample) => sample.ms))
    .sort((left, right) => left - right);
  const measured = summary.rounds.reduce((sum, round) => sum + round.count, 0);
  const clientErrors = summary.rounds.reduce((sum, round) => sum + round.clientErrors, 0);
  summary.addMode = config.addMode;
  summary.pooled = {
    all: stats(pooledTimes),
    clean: cleanTimes.length === 0 ? null : stats(cleanTimes),
    failures: summary.rounds.reduce((sum, round) => sum + round.failures, 0),
    foldsDerived: summary.rounds.reduce((sum, round) => sum + (round.foldsDerived ?? 0), 0),
  };
  summary.headline =
    `${summary.label}: mode=burst concurrency=${config.concurrency} messages=${config.messages} ` +
    `rounds=${config.rounds} n=${summary.pooled.all.n} | p50 ${summary.pooled.all.p50}ms | ` +
    `${summary.pooled.all.p95IsMax ? "p95(=max)" : "p95"} ${summary.pooled.all.p95}ms | ` +
    `failures ${summary.pooled.failures} (client ${clientErrors}) ` +
    (summary.pooled.clean
      ? `| clean n=${summary.pooled.clean.n} ` +
        `${summary.pooled.clean.p95IsMax ? "p95(=max)" : "p95"} ${summary.pooled.clean.p95}ms`
      : "| no round avoided the fold trigger") +
    (config.addMode === "log"
      ? ` | folds derived=${summary.pooled.foldsDerived} (derived, not reported by the service)`
      : ` | add mode=${config.addMode} (log inactive, pending must stay 0)`);
  // Refuse to present a measurement that is mostly this host failing to connect.
  if (clientErrors * 2 >= measured)
    summary.warning =
      "more than half the requests never established a connection; these percentiles " +
      "measure this host, not the endpoint - run the burst from a stable vantage point";
}

function report(summary, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (summary.headline) process.stdout.write(`${summary.headline}\n`);
  if (summary.warning) process.stdout.write(`WARNING: ${summary.warning}\n`);
}

async function main() {
  const config = parseOptions();
  if (!config) return;
  const server = await waitForEndpoint(config.endpoint);
  if (!server) {
    process.stderr.write(`endpoint unreachable: ${config.endpoint}\n`);
    process.exitCode = 2;
    return;
  }
  // The deployment decides which path is being measured, not the flag: declaring `log`
  // against a `sync` deployment would otherwise produce "folds 0" and read like a
  // legitimate log measurement with nothing folded - the exact symptom of a forgotten
  // environment variable. Refuse to run, with the same exit code as an unreachable
  // endpoint: both mean the setup is wrong, not the service.
  const serverMode = server.limits?.add_mode ?? null;
  if (serverMode !== null && serverMode !== config.addMode) {
    process.stderr.write(
      `deployment runs add_mode=${serverMode} but this run declares ${config.addMode}: ` +
        "set NMG_ADD_MODE on the project and redeploy, or pass the matching --add-mode\n",
    );
    process.exitCode = 2;
    return;
  }

  const stamp = Date.now().toString(36);
  const summary = {
    label: config.label,
    mode: config.mode,
    endpoint: config.endpoint,
    user: `bench-${stamp}`,
    stamp,
    concurrency: config.concurrency,
    messages: config.messages,
    roundCount: config.rounds,
    warmup: config.warmup,
    server: {
      add_mode: serverMode,
      source_revision: server.source_revision ?? null,
      upstream_commit: server.upstream_commit ?? null,
    },
    rounds: [],
  };

  // Warm the cold path, then empty the log so the measured rounds start from zero: a
  // warmup Add leaves one pending entry, and the first round would otherwise start at 1.
  if (config.warmup > 0) {
    await add(config.endpoint, config.key, summary.user, `${stamp}-warmup`, config.messages, config.timeout);
    summary.drain = await drain(config.endpoint, config.key, summary.user, config.owner, config.timeout);
    if (!summary.drain.drained)
      process.stderr.write(`drain skipped or failed: ${JSON.stringify(summary.drain)}\n`);
  }

  if (config.mode === "fold") await runFoldMode(config, summary);
  else await runBurstMode(config, summary);
  report(summary, config.json);
}

await main();
