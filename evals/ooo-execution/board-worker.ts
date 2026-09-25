/**
 * Evidence driver: a *separate process* that takes a handoff off the shared NMG board, does the
 * work, and delivers the artifact through the board protocol (deliverTaskBoardEntry).
 *
 * It deliberately does not judge its own delivery: judging is a different agent's act.
 *
 * It reaches the board through the daemon that serves the round's store (`--daemon <store path>`),
 * as a client: the drivers do not open a database of their own, because a second writer is what the
 * run's coordinated transition exists to prevent.
 *
 * Usage:
 *   node --experimental-strip-types evals/ooo-execution/board-worker.ts \
 *     --daemon <round store path> --channel ooo-probe:<runId> \
 *     --out .nmg/board/worker-output.txt [--entry <id>]
 *     [--lease 1800] [--agent worker-ooo-<pid>] [--suites a.test.ts,b.test.ts]
 *
 * Refuses to run without a channel, an output path and a daemon that serves the store. Asserts that
 * it holds the claim, that the artifact file exists and is non-empty, that the digest recomputes,
 * and that the daemon recorded exactly the digest it reported.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { boardCall, roundDaemon } from "./round-client.ts";
import { workDigest } from "../../src/integration/work-identity.ts";

const DEFAULT_SUITES = [
  "tests/core/task-board-deliverable.test.ts",
  "evals/ooo-execution/patch-cycle.test.ts",
  "evals/ooo-execution/recovery.test.ts",
  "evals/ooo-execution/multiprocess.test.ts",
];

// node:util owns flag parsing; an unknown flag or a repeated one is an error rather
// than something this script silently ignores.
const { values } = parseArgs({
  options: {
    channel: { type: "string" },
    entry: { type: "string" },
    out: { type: "string" },
    daemon: { type: "string" },
    agent: { type: "string" },
    lease: { type: "string" },
    suites: { type: "string" },
  },
});

const channel = values.channel;
const out = values.out;
if (!channel) throw new Error("--channel is required: a taskId is the board's only boundary");
if (!out) throw new Error("--out is required: an artifact the deliverer can point at");
if (!values.daemon) {
  throw new Error("--daemon is required: the store path whose daemon serves this round's board");
}

const state = roundDaemon(resolve(values.daemon));
const agentId = values.agent ?? `worker-ooo-${process.pid}`;
const leaseSeconds = Number(values.lease ?? 1800);
const suites = (values.suites ?? DEFAULT_SUITES.join(",")).split(",").filter(Boolean);

{
  // 1. Find the ready handoff: open, actionable, and not already held by someone alive.
  const open = async () => {
    const read = await boardCall(state, { action: "read", taskId: channel, agentId, limit: 200 });
    if (read.action !== "read") throw new Error("the board did not answer a read with entries");
    return read.entries;
  };
  const entries = await open();
  const candidate = values.entry
    ? entries.find((entry) => entry.id === values.entry)
    : entries.filter((entry) => entry.kind === "handoff" && entry.status === "open").at(-1);
  if (!candidate) throw new Error(`no open handoff in ${channel} (daemon: ${state.port})`);
  if (candidate.status !== "open") {
    throw new Error(`entry ${candidate.id} is ${candidate.status}; nothing to claim`);
  }

  // 2. Claim it. The store refuses a pending serial entry, a finalised one, and a claim
  //    held by a live peer - so a throw here means the work is genuinely mine to do.
  const claimResult = await boardCall(state, {
    action: "claim",
    taskId: channel,
    entryId: candidate.id,
    agentId,
    leaseSeconds,
  });
  if (claimResult.action !== "claim") throw new Error("the board did not answer a claim");
  const claimed = claimResult.entry;
  if (claimed.claimedBy !== agentId) {
    throw new Error(`claim did not land: holder is ${claimed.claimedBy ?? "none"}`);
  }
  console.log(`[worker] claimed ${candidate.id} as ${agentId} until ${claimed.claimExpiresAt}`);

  // 3. Do the work: run the named suites serially (the load-sensitive flakes are absent
  //    at --test-concurrency=1, so one file at a time is the honest setting here).
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", "--test-concurrency=1", ...suites],
    { cwd: resolve("."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const body = [
    `# command: node --experimental-strip-types --test --test-concurrency=1 ${suites.join(" ")}`,
    `# exit: ${run.status}  signal: ${run.signal}  ms: ${Date.now() - started}`,
    `# suites: ${suites.length}`,
    "",
    run.stdout ?? "",
    run.stderr ?? "",
  ].join("\n");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body, "utf8");
  if (!existsSync(out) || statSync(out).size === 0) throw new Error(`artifact ${out} is empty`);

  // 4. The artifact's identity, recomputed from the bytes that were just written.
  const digest = workDigest(readFileSync(out));
  // Two reporter shapes exist in the wild: TAP (`# pass 27`) and node's spec reporter
  // (`ℹ pass 27`). Reading only one of them made this worker report 0/0 for a 27/27 run —
  // a self-report that contradicted its own artifact. Parse both, and refuse to deliver
  // a run whose counts cannot be read at all.
  const count = (label: string) => {
    const tap = new RegExp(`^# ${label} (\\d+)$`, "m").exec(body);
    const spec = new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(body);
    return Number(tap?.[1] ?? spec?.[1] ?? Number.NaN);
  };
  const tests = count("tests");
  const pass = count("pass");
  const fail = count("fail");
  if (![tests, pass, fail].every(Number.isFinite) || tests === 0) {
    try {
      await boardCall(state, {
        action: "release",
        taskId: channel,
        entryId: candidate.id,
        agentId,
      });
    } catch {
      // Releasing is courtesy; the lease expiring is the guarantee.
    }
    throw new Error(
      `the run reported no counts (tests=${tests}); refusing to deliver an unparseable run`,
    );
  }
  const failures = [...body.matchAll(/^(?:not ok \d+ - |✖ )(.+)$/gm)]
    .map((m) => m[1]!.trim())
    .slice(0, 8);
  const summary =
    `suites=${suites.length} tests=${tests} pass=${pass} fail=${fail} exit=${run.status} ` +
    `ms=${Date.now() - started}` +
    (failures.length ? ` failures=[${failures.join("; ")}]` : "");

  // 5. Deliver. Only the live claim holder can do this; the store re-checks under CAS.
  const deliverResult = await boardCall(state, {
    action: "deliver",
    taskId: channel,
    entryId: candidate.id,
    agentId,
    digest,
    ref: out,
    summary,
  });
  if (deliverResult.action !== "deliver") throw new Error("the board did not answer a delivery");
  const delivered = deliverResult.entry;
  if (delivered.deliverableDigest !== digest) {
    throw new Error(`the daemon recorded ${delivered.deliverableDigest}, I computed ${digest}`);
  }
  console.log(
    JSON.stringify({
      entryId: delivered.id,
      agentId,
      workerPid: process.pid,
      digest,
      artifact: out,
      artifactBytes: statSync(out).size,
      summary,
      verdict: delivered.verdict ?? null,
    }),
  );
}
