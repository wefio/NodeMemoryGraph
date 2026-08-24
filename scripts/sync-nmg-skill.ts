import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = resolve(import.meta.dirname, "../skills/nmg-memory");

export interface SkillSyncReport {
  source: string;
  target: string;
  inSync: boolean;
  missing: string[];
  changed: string[];
  extra: string[];
  synchronized: boolean;
}

export function inspectNmgSkill(target: string): SkillSyncReport {
  const resolvedTarget = safeTarget(target);
  const sourceFiles = inventory(sourceRoot);
  const targetFiles = existsSync(resolvedTarget) ? inventory(resolvedTarget) : new Map<string, Buffer>();
  const missing: string[] = [];
  const changed: string[] = [];
  const extra: string[] = [];

  for (const [path, content] of sourceFiles) {
    const installed = targetFiles.get(path);
    if (!installed) missing.push(path);
    else if (!installed.equals(content)) changed.push(path);
  }
  for (const path of targetFiles.keys()) {
    if (!sourceFiles.has(path)) extra.push(path);
  }

  return {
    source: sourceRoot,
    target: resolvedTarget,
    inSync: missing.length === 0 && changed.length === 0 && extra.length === 0,
    missing,
    changed,
    extra,
    synchronized: false,
  };
}

export function syncNmgSkill(target: string): SkillSyncReport {
  const resolvedTarget = safeTarget(target);
  const parent = dirname(resolvedTarget);
  mkdirSync(parent, { recursive: true });
  const releaseLock = acquireSyncLock(parent);
  try {
    recoverInterruptedSync(resolvedTarget);
    return synchronizeUnderLock(resolvedTarget);
  } finally {
    releaseLock();
  }
}

function synchronizeUnderLock(resolvedTarget: string): SkillSyncReport {
  const parent = dirname(resolvedTarget);
  const suffix = `${process.pid}-${Date.now()}`;
  const staging = join(parent, `.nmg-memory.sync-${suffix}`);
  const backup = join(parent, `.nmg-memory.backup-${suffix}`);

  cpSync(sourceRoot, staging, { recursive: true, force: true });
  let movedExisting = false;
  try {
    if (existsSync(resolvedTarget)) {
      renameSync(resolvedTarget, backup);
      movedExisting = true;
    }
    renameSync(staging, resolvedTarget);
    if (movedExisting) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (movedExisting && !existsSync(resolvedTarget) && existsSync(backup)) {
      renameSync(backup, resolvedTarget);
    }
    throw error;
  }

  return { ...inspectNmgSkill(resolvedTarget), synchronized: true };
}

export function recoverInterruptedSync(target: string): void {
  const resolvedTarget = safeTarget(target);
  const parent = dirname(resolvedTarget);
  if (!existsSync(parent)) return;

  const entries = readdirSync(parent);
  const backups = entries.filter((entry) => entry.startsWith(".nmg-memory.backup-"));
  const staging = entries.filter((entry) => entry.startsWith(".nmg-memory.sync-"));

  if (!existsSync(resolvedTarget) && backups.length > 0) {
    const newestBackup = backups.reduce((newest, entry) =>
      statSync(join(parent, entry)).mtimeMs > statSync(join(parent, newest)).mtimeMs ? entry : newest,
    );
    renameSync(join(parent, newestBackup), resolvedTarget);
    backups.splice(backups.indexOf(newestBackup), 1);
  }

  for (const entry of [...backups, ...staging]) {
    rmSync(join(parent, entry), { recursive: true, force: true });
  }
}

function acquireSyncLock(parent: string): () => void {
  const lockPath = join(parent, ".nmg-memory.sync.lock");
  const lockValue = JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    token: `${process.pid}-${Date.now()}-${Math.random()}`,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try {
        writeFileSync(descriptor, lockValue);
      } finally {
        closeSync(descriptor);
      }
      return () => removeLockIfUnchanged(lockPath, lockValue);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const observedLock = readLock(lockPath);
      const owner = lockOwner(observedLock);
      if (owner !== undefined && processIsAlive(owner)) {
        throw new Error(`NMG Skill sync already running in process ${owner}`);
      }
      removeLockIfUnchanged(lockPath, observedLock);
    }
  }
  throw new Error(`unable to acquire NMG Skill sync lock: ${lockPath}`);
}

function readLock(lockPath: string): string {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return "";
  }
}

function lockOwner(lockValue: string): number | undefined {
  try {
    const value = JSON.parse(lockValue) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
      ? value.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function removeLockIfUnchanged(lockPath: string, expected: string): void {
  if (readLock(lockPath) === expected) rmSync(lockPath, { force: true });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function safeTarget(target: string): string {
  const resolved = resolve(target);
  if (basename(resolved) !== "nmg-memory") {
    throw new Error(`refusing to replace non-nmg-memory target: ${resolved}`);
  }
  if (resolved === sourceRoot) throw new Error("source and target must differ");
  return resolved;
}

function inventory(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.set(relative(root, absolute).replaceAll("\\", "/"), readFileSync(absolute));
      else throw new Error(`unsupported skill entry: ${absolute}`);
    }
  };
  visit(root);
  return files;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function validateArgs(args: string[]): void {
  const allowed = new Set(["--check", "--target"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    if (!allowed.has(argument)) throw new Error(`unknown option: ${argument}`);
    if (argument === "--target") index += 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  validateArgs(args);
  const target = optionValue(args, "--target") ?? join(homedir(), ".agents", "skills", "nmg-memory");
  const check = args.includes("--check");
  const report = check ? inspectNmgSkill(target) : syncNmgSkill(target);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (check && !report.inSync) process.exitCode = 1;
}
