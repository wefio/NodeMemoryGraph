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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  liveMutationLock,
  mutationHazard,
  mutationLockPath,
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
