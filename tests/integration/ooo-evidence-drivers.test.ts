/**
 * Smoke tests for the OoO evidence drivers in evals/ooo-execution/.
 *
 * They exist because those files are *not* tests: tsc and eslint skip evals/, and nothing in CI ran
 * them, so one of them quietly rotted — probe-check-duration.ts still imported round-log.ts from the
 * directory that file had left. Moving them into the repository made them reviewable but not safe;
 * this file is what makes an edit that breaks them fail a gate.
 *
 * Each driver is invoked the way a reviewer would invoke it, against a scratch store, and the
 * assertions are on observable outcomes (exit status, refused-by-name message, the JSON the driver
 * prints) rather than on the driver's internals.
 *
 * The board is served for the drivers rather than opened by them: a driver is a client of the daemon
 * that owns the round's store, and the two cases below are what hold that boundary - one behavioural
 * (no daemon, no run) and one structural (no driver imports the store).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { serveRoundStore, type RoundHost } from "../../evals/ooo-execution/round-host.ts";
import { boardCall, runCall } from "../../evals/ooo-execution/round-client.ts";

const REPOSITORY = resolve(import.meta.dirname, "..", "..");
const DRIVER = (name: string) => join(REPOSITORY, "evals", "ooo-execution", name);

interface Run {
  status: number | null;
  out: string;
}

/**
 * One driver run, spawned rather than run inline.
 *
 * `spawn`, not `spawnSync`: the test process *hosts* the daemon these drivers call, so a synchronous
 * spawn would block the event loop that has to answer them - the driver would sit in a fetch until
 * its headers timed out. The refusal cases do not need the host, but the same helper serves both.
 */
function runDriver(name: string, args: readonly string[], cwd = REPOSITORY): Promise<Run> {
  // A child that inherits NODE_TEST_CONTEXT believes it is inside this test run and refuses to
  // start its own: "node:test run() is being called recursively". The drivers are processes, not
  // suites, so the marker must not reach them.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", DRIVER(name), ...args], {
      cwd,
      env,
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("close", (status) => resolve({ status, out }));
  });
}

const scratchDirectory = () => mkdtempSync(join(tmpdir(), "nmg-evidence-drivers-"));

const digestOf = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** One board operation as a client of the round's host: the test does not open the store either. */
async function board(host: RoundHost, params: Parameters<typeof boardCall>[1]) {
  const result = await boardCall(host.state(), params);
  if (result.action !== params.action) {
    throw new Error(`the host answered ${result.action} to a ${params.action}`);
  }
  return result;
}

/** One run transition, likewise from outside: registering and freezing are the runner's acts. */
async function run(host: RoundHost, params: Parameters<typeof runCall>[1]) {
  const result = await runCall(host.state(), params);
  if (result.action !== params.action) {
    throw new Error(`the host answered ${result.action} to a ${params.action}`);
  }
  return result;
}

test("a managed round's lifecycle from a driver process lands in the run's own log", async () => {
  const directory = scratchDirectory();
  const storePath = join(directory, "round.sqlite");
  const channel = "evidence-managed";
  const runId = "run-evidence";
  const suite = join(directory, "managed-suite.test.ts");
  writeFileSync(
    suite,
    'import test from "node:test";\n\ntest("a managed round has work to deliver", () => {});\n',
    "utf8",
  );
  const out = join(directory, "managed-output.txt");
  const host = await serveRoundStore(storePath);
  try {
    // The round's record first: a run, its frozen plan, and the entry it carries adopted in the same
    // transition that creates the entry - the runner's acts, all of them over the wire.
    await run(host, {
      action: "register",
      runId,
      planDigest: "sha256:evidence-plan",
      policy: "ordered",
      revision: "1",
      retention: "evidence",
    });
    await run(host, {
      action: "freeze",
      runId,
      tasks: [
        {
          taskId: "T1",
          revision: "1",
          input: "run the managed suite",
          dependencies: [],
          effect: "artifact",
        },
      ],
    });
    const put = await boardCall(host.state(), {
      action: "put",
      taskId: channel,
      agentId: "round-host",
      kind: "handoff",
      content: JSON.stringify({ id: "T1", revision: "1", attempt: 1, input: "managed" }),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      adopt: { runId, taskId: "T1" },
    });
    if (put.action !== "put") throw new Error("expected a put result");
    assert.equal(put.bound?.recorded, true, "the entry was adopted by the put that created it");
    const entryId = put.entry.id;

    // A separate process does the work and delivers; another separate process judges it.
    const worked = await runDriver("board-worker.ts", [
      "--daemon",
      storePath,
      "--channel",
      channel,
      "--out",
      out,
      "--suites",
      suite,
      "--agent",
      "worker-managed",
      "--entry",
      entryId,
    ]);
    assert.equal(worked.status, 0, worked.out);
    const judged = await runDriver("board-judge.ts", [
      "--daemon",
      storePath,
      "--channel",
      channel,
      "--entry",
      entryId,
      "--agent",
      "judge-managed",
      "--verdict",
      "accepted",
      "--reason",
      "digest re-verified from the bytes",
    ]);
    assert.equal(judged.status, 0, judged.out);
    const managedVerdict = JSON.parse(judged.out.trim().split("\n").at(-1)!) as {
      verdict: string;
      deliveryVerified: boolean;
    };
    assert.deepEqual(
      { verdict: managedVerdict.verdict, verified: managedVerdict.deliveryVerified },
      { verdict: "accepted", verified: true },
    );

    // Every one of those acts is in the run's log, written by the daemon in the transaction that
    // moved the board - which is the whole point of adopting the entry rather than creating it.
    const status = await run(host, { action: "status", runId });
    if (status.action !== "status") throw new Error("expected a status result");
    const kinds = status.status.facts.map((fact) => fact.kind);
    assert.deepEqual(kinds, ["entry-bound", "board-claim", "board-deliver", "board-judge"]);
    assert.deepEqual(status.status.bindings, [
      {
        taskId: "T1",
        attempt: 1,
        entryId,
        sequence: status.status.bindings[0]!.sequence,
        // Delivery and judgement record the artifact and the verdict; only `resolve` moves the
        // entry's status, so an accepted entry is still open - the state the run's log exists to keep.
        entry: { taskId: channel, status: "open", claimedBy: "worker-managed", ackedBy: [] },
      },
    ]);
  } finally {
    await host.close();
  }
});

test("a driver refuses without a daemon, and no driver opens a database of its own", async () => {
  const directory = scratchDirectory();
  // Behavioural: the store exists, nothing serves it, and the driver says so by name instead of
  // opening the file. This is the shape that would otherwise rot back in silently.
  const store = join(directory, "scratch.sqlite");
  const refused = await runDriver("board-deliver.ts", [
    "--daemon",
    store,
    "--channel",
    "c",
    "--entry",
    "e",
    "--agent",
    "a",
    "--digest",
    "0".repeat(64),
  ]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.out, /no daemon is serving/u);

  // Structural: the whole boundary is that these three files reach the board through the daemon, so
  // a re-added store import has to fail here rather than only under a real round.
  const drivers = readdirSync(join(REPOSITORY, "evals", "ooo-execution")).filter((name) =>
    /^board-(worker|deliver|judge)\.ts$/u.test(name),
  );
  assert.equal(drivers.length, 3, "the three board drivers are expected to exist");
  for (const driver of drivers) {
    const source = readFileSync(join(REPOSITORY, "evals", "ooo-execution", driver), "utf8");
    assert.doesNotMatch(
      source,
      /core\/store|NmgStoreBase/u,
      `${driver} must reach the board through the daemon, not through the store`,
    );
    assert.match(source, /round-client\.ts/u, `${driver} must use the round client`);
  }
});

test("every evidence driver starts and refuses a missing flag by name", async () => {
  // A driver that cannot even load fails here too, which is the failure this file exists for: the
  // probe's stale import meant the script the record cited could not run at all.
  const cases: Array<{ driver: string; args: string[]; expected: RegExp }> = [
    { driver: "board-worker.ts", args: [], expected: /--channel is required/u },
    { driver: "board-worker.ts", args: ["--channel", "c"], expected: /--out is required/u },
    {
      driver: "board-worker.ts",
      args: ["--channel", "c", "--out", "o", "--daemon", "s"],
      expected: /no daemon is serving/u,
    },
    { driver: "board-judge.ts", args: ["--channel", "c"], expected: /--entry is required/u },
    { driver: "board-deliver.ts", args: ["--channel", "c"], expected: /--entry is required/u },
    {
      driver: "probe-check-duration.ts",
      args: ["--check-ms", "0"],
      expected: /--out <dir> is required/u,
    },
  ];
  for (const { driver, args, expected } of cases) {
    const result = await runDriver(driver, args);
    assert.notEqual(result.status, 0, `${driver} ${args.join(" ")} must refuse`);
    assert.match(result.out, expected, `${driver} ${args.join(" ")}`);
  }
});

test("the board drivers run the protocol end to end through the daemon that serves the store", async () => {
  const directory = scratchDirectory();
  const store = join(directory, "scratch.sqlite");
  const channel = "evidence-driver-smoke";
  const host = await serveRoundStore(store);
  try {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    // Directed, so the channel's single outstanding serial slot cannot block the second entry.
    const put = await board(host, {
      action: "put",
      taskId: channel,
      agentId: "smoke-setup",
      kind: "handoff",
      to: "smoke-holder",
      content: JSON.stringify({ id: "S", revision: "1", attempt: 1, input: "smoke" }),
      expiresAt,
    });
    if (put.action !== "put") throw new Error("expected a put result");
    const entry = put.entry;
    const claimed = await board(host, {
      action: "claim",
      taskId: channel,
      entryId: entry.id,
      agentId: "smoke-holder",
      leaseSeconds: 600,
    });
    assert.equal(claimed.action === "claim" && claimed.entry.claimedBy, "smoke-holder");

    const artifact = join(directory, "artifact.txt");
    writeFileSync(artifact, "the bytes the digest is computed from\n", "utf8");
    const delivered = await runDriver("board-deliver.ts", [
      "--daemon",
      store,
      "--channel",
      channel,
      "--entry",
      entry.id,
      "--agent",
      "smoke-holder",
      "--ref",
      artifact,
      "--summary",
      "smoke delivery",
    ]);
    assert.equal(delivered.status, 0, delivered.out);
    const delivery = JSON.parse(delivered.out.trim().split("\n").at(-1)!) as {
      deliverableDigest: string;
      digestRecomputedFromRef: boolean;
    };
    assert.equal(
      delivery.digestRecomputedFromRef,
      true,
      "the digest comes from the bytes, not the caller",
    );
    assert.match(delivery.deliverableDigest, /^[0-9a-f]{64}$/u);

    // A digest the caller claims but the bytes deny must be refused.
    const lied = await runDriver("board-deliver.ts", [
      "--daemon",
      store,
      "--channel",
      channel,
      "--entry",
      entry.id,
      "--agent",
      "smoke-holder",
      "--ref",
      artifact,
      "--digest",
      "0".repeat(64),
    ]);
    assert.notEqual(lied.status, 0);
    assert.match(lied.out, /does not match the bytes/u);

    const selfJudge = await runDriver("board-judge.ts", [
      "--daemon",
      store,
      "--channel",
      channel,
      "--entry",
      entry.id,
      "--agent",
      "smoke-holder",
      "--verdict",
      "accepted",
      "--reason",
      "self",
    ]);
    assert.notEqual(selfJudge.status, 0);
    assert.match(selfJudge.out, /refusing to judge my own deliverable/u);

    const judged = await runDriver("board-judge.ts", [
      "--daemon",
      store,
      "--channel",
      channel,
      "--entry",
      entry.id,
      "--agent",
      "smoke-reviewer",
      "--verdict",
      "accepted",
      "--reason",
      "digest re-verified from the bytes",
    ]);
    assert.equal(judged.status, 0, judged.out);
    const verdict = JSON.parse(judged.out.trim().split("\n").at(-1)!) as {
      verdict: string;
      judgedBy: string;
      deliveryVerified: boolean;
    };
    assert.deepEqual(
      { verdict: verdict.verdict, judgedBy: verdict.judgedBy, verified: verdict.deliveryVerified },
      { verdict: "accepted", judgedBy: "smoke-reviewer", verified: true },
    );
  } finally {
    await host.close();
  }
});

test("the worker claims, runs the named suite and delivers its digest", async () => {
  const directory = scratchDirectory();
  const store = join(directory, "scratch.sqlite");
  const channel = "evidence-worker-smoke";
  // A suite of our own, so the smoke test does not depend on a real suite staying small.
  const suite = join(directory, "smoke-suite.test.ts");
  writeFileSync(
    suite,
    'import test from "node:test";\n\ntest("the worker reports the counts it read", () => {});\n',
    "utf8",
  );
  const out = join(directory, "worker-output.txt");
  const host = await serveRoundStore(store);
  try {
    const setup = await runDriver("board-worker.ts", [
      "--daemon",
      store,
      "--channel",
      channel,
      "--out",
      out,
      "--suites",
      suite,
    ]);
    // No handoff is published yet, so this run proves the driver loaded and refused honestly.
    assert.notEqual(setup.status, 0);
    assert.match(setup.out, /no open handoff/u);
    assert.equal(existsSync(out), false, "a refused run must not leave an artifact behind");

    await board(host, {
      action: "put",
      taskId: channel,
      agentId: "smoke-setup",
      kind: "handoff",
      content: JSON.stringify({ id: "W", revision: "1", attempt: 1, input: "run the smoke suite" }),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const delivered = await runDriver("board-worker.ts", [
      "--daemon",
      store,
      "--channel",
      channel,
      "--out",
      out,
      "--suites",
      suite,
    ]);
    assert.equal(delivered.status, 0, delivered.out);
    const report = JSON.parse(delivered.out.trim().split("\n").at(-1)!) as {
      summary: string;
      digest: string;
      artifactBytes: number;
      verdict: string | null;
    };
    assert.match(report.summary, /tests=1 pass=1 fail=0/u);
    assert.equal(report.verdict, null, "the worker must not judge its own delivery");
    assert.equal(report.artifactBytes, readFileSync(out).byteLength);
    assert.equal(report.digest, digestOf(out));
  } finally {
    await host.close();
  }
});

test("the duration probe runs a grid and records what it measured", async () => {
  const directory = scratchDirectory();
  const result = await runDriver("probe-check-duration.ts", [
    "--out",
    directory,
    "--check-ms",
    "0",
    "--worker-ms",
    "0",
  ]);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /check ms \| worker ms \| ooo wall ms/u);
  assert.match(result.out, /verdicts identical across the grid: true/u);
  const recorded = JSON.parse(readFileSync(join(directory, "check-duration.json"), "utf8")) as {
    points: Array<{ checkMs: number; hiddenShare: number }>;
  };
  assert.ok(recorded.points.length > 0, "the probe records the points it measured");
  assert.ok(
    recorded.points.every((point) => Number.isFinite(point.hiddenShare)),
    "every recorded share is a number rather than a silent zero",
  );
});
