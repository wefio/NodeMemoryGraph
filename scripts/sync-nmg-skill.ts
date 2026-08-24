import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const target = optionValue(args, "--target") ?? join(homedir(), ".agents", "skills", "nmg-memory");
  const check = args.includes("--check");
  const report = check ? inspectNmgSkill(target) : syncNmgSkill(target);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (check && !report.inSync) process.exitCode = 1;
}
