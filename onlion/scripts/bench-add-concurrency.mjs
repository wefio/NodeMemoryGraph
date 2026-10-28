/**
 * Does the log accept path actually beat the synchronous one under a burst?
 *
 * The stopping rules for the append-log write path put one number behind the default:
 * a 16-way concurrent Add burst must show a lower p95 with `NMG_ADD_MODE=log` than with
 * `sync`. This produces both numbers from the same client against the same endpoint.
 *
 * Three things it deliberately does differently from a naive burst loop:
 *
 *  - **one user per run, not per round.** A fresh user per round peaks at `concurrency`
 *    pending entries, which is below `FOLD_TRIGGER`, so a burst benchmark would never
 *    fold at all - it would measure accept and call it the write path. One user lets
 *    pending accumulate across rounds, which is what makes folding happen, and it also
 *    stops every round from paying the first-Add cold path again.
 *  - **folds are derived, not read.** There is no `folded_total` anywhere in the service
 *    (`/capacity` reports `pending_entries` only), so each round samples pending before
 *    and after and derives how many folds must have run, marking the value `derived`.
 *  - **the fold cost is isolated.** `--mode fold` warms pending to one below the trigger
 *    and then times a single Add, which is the request that must pay both the accept and
 *    a fold. Mixed into a burst, that request cannot be identified after the fact.
 *
 *   node onlion/scripts/bench-add-concurrency.mjs \
 *     --endpoint https://api.nmgmemory.dpdns.org --key "$KEY" \
 *     --concurrency 16 --messages 8 --rounds 3 --warmup 1 \
 *     --owner owner@example.test
 *
 * Failed *connections* are reported apart from server failures: on a bad minute this
 * host cannot establish TLS, and folding both into one number would let the percentiles
 * describe the client while looking like an answer about the service.
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
    // The parsed body is kept for the capacity reads and dropped before serialisation:
    // a page of records per request would dominate the JSON and say nothing about timing.
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
    max: Math.round(times.at(-1) ?? 0),
    statuses: Object.fromEntries([...byStatus].sort()),
    failures: failures.length,
    clientErrors: results.filter((result) => result.status === 0).length,
    serverErrors: results.filter((result) => result.status >= 500).length,
    codes: [...new Set(failures.map((result) => result.code ?? `http_${result.status}`))],
  };
}

/** How many folds must have run: pending grew by the accepts that succeeded and shrank
 *  by what each fold absorbed. Derived, because the service exposes no fold counter.
 *
 *  Only meaningful with the log accept path: in `sync` mode an accepted Add never becomes
 *  a pending entry, so the same arithmetic would invent folds that cannot exist. The
 *  declared mode decides, and a mismatch between the declaration and what pending does is
 *  reported rather than smoothed over. */
function deriveFolds(addMode, before, accepted, after) {
  if (addMode !== "log" || before === null || after === null) return null;
  const absorbed = before + accepted - after;
  if (absorbed < 0) return 0;
  return Math.round(absorbed / FOLD_BATCH);
}

async function main() {
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
    return;
  }
  const concurrency = Number(values.concurrency);
  const messages = Number(values.messages);
  const rounds = Number(values.rounds);
  const warmup = Number(values.warmup);
  const timeout = Number(values.timeout);
  if (values.mode !== "burst" && values.mode !== "fold") {
    process.stderr.write(`unknown --mode: ${values.mode} (burst | fold)\n`);
    process.exitCode = 2;
    return;
  }

  // Three attempts: one stall is how an ordinary host behaves on a bad minute, but a
  // benchmark against a dead endpoint must not report zeros.
  let reachable = false;
  for (let attempt = 0; attempt < 3 && !reachable; attempt += 1) {
    try {
      const health = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(20_000) });
      reachable = health.ok;
      if (!reachable) process.stderr.write(`health answered ${health.status}\n`);
    } catch (error) {
      process.stderr.write(`health attempt ${attempt + 1} failed: ${error.message}\n`);
    }
  }
  if (!reachable) {
    process.stderr.write(`endpoint unreachable: ${endpoint}\n`);
    process.exitCode = 2;
    return;
  }

  const stamp = Date.now().toString(36);
  const user = `bench-${stamp}`;
  const summary = {
    label: values.label,
    mode: values.mode,
    endpoint,
    user,
    concurrency,
    messages,
    rounds,
    warmup,
    rounds: [],
  };

  // Warm the cold path, then empty the log so the measured rounds start from zero: a
  // warmup Add leaves one pending entry, and the first round would otherwise start at 1.
  if (warmup > 0) {
    await add(endpoint, values.key, user, `${stamp}-warmup`, messages, timeout);
    summary.drain = await drain(endpoint, values.key, user, values.owner, timeout);
    if (!summary.drain.drained)
      process.stderr.write(`drain skipped or failed: ${JSON.stringify(summary.drain)}\n`);
  }

  if (values.mode === "fold") {
    // One below the trigger, untimed, so the single timed Add is the request that pays
    // a fold. Its cost is an upper bound on what folding adds to one Add.
    for (let index = 0; index < FOLD_TRIGGER - 1; index += 1)
      await add(endpoint, values.key, user, `${stamp}-pre-${index}`, messages, timeout);
    const before = await pendingOf(endpoint, values.key, user, timeout);
    const timed = await add(endpoint, values.key, user, `${stamp}-boundary`, messages, timeout);
    const after = await pendingOf(endpoint, values.key, user, timeout);
    summary.boundary = {
      ...summarise("fold boundary", [timed]),
      sample: timing(timed),
      pendingBefore: before,
      pendingAfter: after,
      foldsDerived: deriveFolds(values["add-mode"], before, timed.status === 200 ? 1 : 0, after),
    };
    if (!values.json)
      process.stdout.write(
        `fold boundary: ${summary.boundary.status} in ${summary.boundary.max}ms | ` +
          `pending ${before} -> ${after} | folds derived=${summary.boundary.foldsDerived}\n`,
      );
  } else {
    for (let round = 0; round < rounds; round += 1) {
      const before = await pendingOf(endpoint, values.key, user, timeout);
      const tasks = Array.from(
        { length: concurrency },
        (_unused, slot) => () =>
          add(endpoint, values.key, user, `${stamp}-${round}-${slot}`, messages, timeout),
      );
      const results = await burst(tasks, concurrency);
      const after = await pendingOf(endpoint, values.key, user, timeout);
      const roundSummary = summarise(`round ${round + 1}`, results);
      roundSummary.pendingBefore = before;
      roundSummary.pendingAfter = after;
      roundSummary.accepted = results.filter((result) => result.status === 200).length;
      roundSummary.foldsDerived = deriveFolds(
        values["add-mode"],
        before,
        roundSummary.accepted,
        after,
      );
      if (values["add-mode"] === "sync" && (before !== 0 || after !== 0))
        roundSummary.modeMismatch = `declared sync but pending moved ${before}->${after}; the deployment may be running the log path`;
      summary.rounds.push(roundSummary);
      if (!values.json)
        process.stdout.write(
          `${roundSummary.label}: n=${roundSummary.count} p50=${roundSummary.p50}ms ` +
            `p95=${roundSummary.p95}ms max=${roundSummary.max}ms ` +
            `failures=${roundSummary.failures} (client=${roundSummary.clientErrors} ` +
            `server=${roundSummary.serverErrors}) pending ${before}->${after} ` +
            `folds~${roundSummary.foldsDerived} statuses=${JSON.stringify(roundSummary.statuses)}\n`,
        );
    }
    const pooledTimes = summary.rounds
      .flatMap((round) => [round.p50, round.p95])
      .sort((left, right) => left - right);
    const measured = summary.rounds.reduce((sum, round) => sum + round.count, 0);
    const clientErrors = summary.rounds.reduce((sum, round) => sum + round.clientErrors, 0);
    summary.addMode = values["add-mode"];
    summary.pooled = {
      p50: Math.round(percentile(pooledTimes, 0.5)),
      p95: Math.round(percentile(pooledTimes, 1)),
      failures: summary.rounds.reduce((sum, round) => sum + round.failures, 0),
      foldsDerived: summary.rounds.reduce((sum, round) => sum + (round.foldsDerived ?? 0), 0),
    };
    summary.headline =
      `${summary.label}: mode=burst concurrency=${concurrency} messages=${messages} ` +
      `rounds=${rounds} | p50 ${summary.pooled.p50}ms | p95 ${summary.pooled.p95}ms | ` +
      `failures ${summary.pooled.failures} (client ${clientErrors}) ` +
      (values["add-mode"] === "log"
        ? `| folds derived=${summary.pooled.foldsDerived} (derived, not reported by the service)`
        : `| add mode=${values["add-mode"]} (log inactive, pending must stay 0)`);
    // Refuse to present a measurement that is mostly this host failing to connect.
    if (clientErrors * 2 >= measured)
      summary.warning =
        "more than half the requests never established a connection; these percentiles " +
        "measure this host, not the endpoint - run the burst from a stable vantage point";
  }

  if (values.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    if (summary.headline) process.stdout.write(`${summary.headline}\n`);
    if (summary.warning) process.stdout.write(`WARNING: ${summary.warning}\n`);
  }
}

await main();
