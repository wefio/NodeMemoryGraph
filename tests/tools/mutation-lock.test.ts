/**
 * The lock a mutation sweep leaves behind, and who refuses to read the tree because of it
 * (post-mortem 0003).
 *
 * The failure class escaped twice in one session: first as checks read *while* a sweep held a mutant, then
 * as a sweep that was **killed** between its substitution and its restore - leaving a live mutant in the
 * tree that the next sweep's own baseline run then failed on. A stale lock is therefore not harmless and
 * is not taken over silently.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  liveMutationLock,
  mutationHazard,
  mutationLockPath,
  readMutationLock,
  staleMutationLock,
  type MutationLock,
} from "../../tools/mutation-lock.ts";

/** A pid that is certainly gone: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.ok(child.pid);
  return child.pid;
}

function withLock(lock: MutationLock, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "nmg-mutation-lock-"));
  mkdirSync(join(root, ".temp"), { recursive: true });
  writeFileSync(mutationLockPath(root), `${JSON.stringify(lock, null, 2)}\n`);
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const lockOf = (pid: number, live: boolean): MutationLock => ({
  pid,
  startedAt: new Date().toISOString(),
  target: "evals/ooo-execution/plan-driver.ts",
  live,
});

test("a running sweep is reported as live, and a killed one as stale", () => {
  withLock(lockOf(process.pid, true), (root) => {
    assert.ok(liveMutationLock(root), "this process owns the lock and is alive");
    assert.equal(staleMutationLock(root), null);
    assert.match(mutationHazard(root), /holds the tree/);
  });
  withLock(lockOf(deadPid(), true), (root) => {
    assert.equal(liveMutationLock(root), null, "a dead owner is not a running sweep");
    assert.ok(staleMutationLock(root), "but its lock is not harmless");
    // The hazard names the file to inspect instead of inviting a silent takeover.
    assert.match(mutationHazard(root), /died holding evals\/ooo-execution\/plan-driver\.ts/);
    assert.match(mutationHazard(root), /git diff/);
  });
  withLock(lockOf(deadPid(), false), (root) => {
    // `live: false` means it was between mutants; the lock is still not a licence to read the tree.
    assert.ok(staleMutationLock(root));
  });
});

test("no lock file means no hazard", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-mutation-lock-quiet-"));
  try {
    assert.equal(mutationHazard(root), "");
    assert.equal(staleMutationLock(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale lock refuses a new sweep instead of being taken over", () => {
  // The refusal is the guardrail: a killed sweep may have left its mutant in the target, and a new sweep
  // that silently took the lock over would measure the plan against that mutant (which is what happened).
  withLock(lockOf(deadPid(), true), (root) => {
    const script = fileURLToPath(new URL("../../tools/mutation-teeth.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", script, "--targets", "src/core/store/clock.ts"],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, MUTATION_LOCK_ROOT: root } },
    );
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /refusing to start a mutation sweep/);
    assert.match(result.stderr, /died holding/);
  });
});

test("a running sweep reports its mutant as live, not only its target", async () => {
  // The lock's `live` field is what a reader uses to tell "between targets" from "a mutant is on disk",
  // and it is written by the harness, not by this module - so a missing write leaves a field that lies.
  // This runs a real (cheap) sweep and watches the lock while it works.
  const root = mkdtempSync(join(tmpdir(), "nmg-mutation-lock-live-"));
  const script = fileURLToPath(new URL("../../tools/mutation-teeth.ts", import.meta.url));
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const errPath = join(root, "child.err");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      script,
      "--targets",
      "src/core/store/clock.ts",
      "--json",
      join(root, "result.json"),
    ],
    {
      cwd: repo,
      env: { ...process.env, MUTATION_LOCK_ROOT: root },
      stdio: ["ignore", "ignore", openSync(errPath, "a")],
      windowsHide: true,
    },
  );
  try {
    let live = false;
    let target = "";
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const lock = readMutationLock(root);
      if (lock?.live) {
        live = true;
        target = lock.target;
      }
      if (live) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      live,
      true,
      `a substituted mutant is reported as live while the suite runs; child stderr:\n${readFileSync(errPath, "utf8")}`,
    );
    assert.equal(target, "src/core/store/clock.ts");
    // Let it finish rather than killing it: a sweep killed between substitution and restore leaves its mutant
    // in the tree under test, which is the hazard this whole file is about - and this test would be the one
    // causing it. Waiting also buys the assertion that the run cleaned up after itself.
    child.stdin?.end();
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8")) as {
      targets: { restoredByteIdentically: boolean; mutants: { caught: boolean }[] }[];
    };
    assert.equal(result.targets[0]?.restoredByteIdentically, true);
    assert.equal(
      result.targets[0]?.mutants.every((mutant) => mutant.caught),
      true,
    );
    assert.equal(mutationHazard(root), "", "the finished sweep leaves no hazard behind");
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
