/**
 * The lock a mutation sweep holds while it holds a live mutant (post-mortem 0003).
 *
 * `mutation:teeth` substitutes a named wrong version into a target file, runs the suites that are meant
 * to catch it, and restores the file byte-identically. Between those two writes the target file on disk
 * **is** the mutant, so any check that reads the tree reports on the mutant rather than on the change -
 * and a check that *passes* in that window is evidence about a tree that never existed.
 *
 * The rule used to live only inside the harness's process ("do not edit or stage a file a mutation run is
 * rewriting"), which is why a reader could not see it: a check only *reads*, so the rule never fired.
 * This file is what the tree says instead, and both the harness and the readers of the tree use it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type MutationLock = {
  pid: number;
  startedAt: string;
  /** The file the sweep is working on; empty while it is still selecting. */
  target: string;
  /** True while a mutant is substituted into `target`: the tree is not readable for checks. */
  live: boolean;
};

/** Where the lock lives. Inside the gitignored scratch directory, so it is never staged. `MUTATION_LOCK_ROOT`
 *  lets a test point the lock somewhere other than the repository it is exercising. */
export function mutationLockPath(root: string = lockRoot()): string {
  return resolve(root, ".temp", "mutation-lock.json");
}

function lockRoot(): string {
  return process.env.MUTATION_LOCK_ROOT ?? process.cwd();
}

export function readMutationLock(root: string = process.cwd()): MutationLock | null {
  const path = mutationLockPath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MutationLock;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    // A half-written lock is not a reason to refuse: the sweep writes it before it substitutes anything.
    return null;
  }
}

export function writeMutationLock(lock: MutationLock, root: string = process.cwd()): void {
  const path = mutationLockPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
}

/** Removes the lock only if this process owns it, so a stale-lock takeover cannot delete the live one. */
export function clearMutationLock(pid: number, root: string = process.cwd()): void {
  const lock = readMutationLock(root);
  if (lock && lock.pid !== pid) return;
  rmSync(mutationLockPath(root), { force: true });
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The lock **if a sweep is really still running**, i.e. its owner process is alive. */
export function liveMutationLock(root: string = lockRoot()): MutationLock | null {
  const lock = readMutationLock(root);
  if (!lock) return null;
  if (lock.pid === process.pid || running(lock.pid)) return lock;
  return null;
}

/** A lock whose owner is gone: a sweep that was killed. It is **not** harmless - it died between the
 *  substitution and the restore, so the target file may still be the mutant, and a check that reads the
 *  tree would report on that mutant (this is how the same failure class escaped a second time on
 *  2026-09-18). Never take it over silently: the reader has to look at the file first. */
export function staleMutationLock(root: string = lockRoot()): MutationLock | null {
  const lock = readMutationLock(root);
  if (!lock) return null;
  if (lock.pid === process.pid || running(lock.pid)) return null;
  return lock;
}

export function describeMutationLock(lock: MutationLock): string {
  return (
    `a mutation sweep holds the tree (pid ${lock.pid}, target ${lock.target || "selecting"}, ` +
    `mutant live: ${lock.live}, since ${lock.startedAt})`
  );
}

/** Why a reader must not treat the tree as readable, or an empty string when it may. */
export function mutationHazard(root: string = lockRoot()): string {
  const sweeping = liveMutationLock(root);
  if (sweeping) return describeMutationLock(sweeping);
  const killed = staleMutationLock(root);
  if (killed)
    return (
      `a previous mutation sweep died holding ${killed.target || "its target"} (pid ${killed.pid}, ` +
      `since ${killed.startedAt}), so the file may still be its mutant - \`git diff\` it and remove ` +
      `${mutationLockPath(root)} before trusting any check`
    );
  return "";
}
