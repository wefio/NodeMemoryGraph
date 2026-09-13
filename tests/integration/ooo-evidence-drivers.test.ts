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
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPOSITORY = resolve(import.meta.dirname, "..", "..");
const DRIVER = (name: string) => join(REPOSITORY, "evals", "ooo-execution", name);

interface Run {
  status: number | null;
  out: string;
}

function runDriver(name: string, args: readonly string[], cwd = REPOSITORY): Run {
  // A child that inherits NODE_TEST_CONTEXT believes it is inside this test run and refuses to
  // start its own: "node:test run() is being called recursively". The drivers are processes, not
  // suites, so the marker must not reach them.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", DRIVER(name), ...args],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env },
  );
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const scratchDirectory = () => mkdtempSync(join(tmpdir(), "nmg-evidence-drivers-"));

const digestOf = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

test("every evidence driver starts and refuses a missing flag by name", () => {
  // A driver that cannot even load fails here too, which is the failure this file exists for: the
  // probe's stale import meant the script the record cited could not run at all.
  const cases: Array<{ driver: string; args: string[]; expected: RegExp }> = [
    { driver: "board-worker.ts", args: [], expected: /--channel is required/u },
    { driver: "board-worker.ts", args: ["--channel", "c"], expected: /--out is required/u },
    { driver: "board-judge.ts", args: ["--channel", "c"], expected: /--entry is required/u },
    { driver: "board-deliver.ts", args: ["--channel", "c"], expected: /--entry is required/u },
    {
      driver: "probe-check-duration.ts",
      args: ["--check-ms", "0"],
      expected: /--out <dir> is required/u,
    },
  ];
  for (const { driver, args, expected } of cases) {
    const result = runDriver(driver, args);
    assert.notEqual(result.status, 0, `${driver} ${args.join(" ")} must refuse`);
    assert.match(result.out, expected, `${driver} ${args.join(" ")}`);
  }
});

test("the board drivers run the protocol end to end on a scratch store", async () => {
  const directory = scratchDirectory();
  const store = join(directory, "scratch.sqlite");
  const channel = "evidence-driver-smoke";
  const { NmgStoreBase } = await import("../../src/core/store/base.ts");
  const board = new NmgStoreBase(store);
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  // Directed, so the channel's single outstanding serial slot cannot block the second entry.
  const entry = board.putTaskBoardEntry({
    taskId: channel,
    agentId: "smoke-setup",
    kind: "handoff",
    to: "smoke-holder",
    content: JSON.stringify({ id: "S", revision: "1", attempt: 1, input: "smoke" }),
    expiresAt,
  });
  const claimed = board.claimTaskBoardEntry({
    taskId: channel,
    entryId: entry.id,
    agentId: "smoke-holder",
    leaseSeconds: 600,
  });
  board.close();
  assert.equal(claimed.claimedBy, "smoke-holder");

  const artifact = join(directory, "artifact.txt");
  writeFileSync(artifact, "the bytes the digest is computed from\n", "utf8");
  const delivered = runDriver("board-deliver.ts", [
    "--store",
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
  const lied = runDriver("board-deliver.ts", [
    "--store",
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

  const selfJudge = runDriver("board-judge.ts", [
    "--store",
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

  const judged = runDriver("board-judge.ts", [
    "--store",
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

  const setup = runDriver("board-worker.ts", [
    "--store",
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

  const { NmgStoreBase } = await import("../../src/core/store/base.ts");
  const board = new NmgStoreBase(store);
  board.putTaskBoardEntry({
    taskId: channel,
    agentId: "smoke-setup",
    kind: "handoff",
    content: JSON.stringify({ id: "W", revision: "1", attempt: 1, input: "run the smoke suite" }),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  board.close();

  const delivered = runDriver("board-worker.ts", [
    "--store",
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
});

test("the duration probe runs a grid and records what it measured", () => {
  const directory = scratchDirectory();
  const result = runDriver("probe-check-duration.ts", [
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
