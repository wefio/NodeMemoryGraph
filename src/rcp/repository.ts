import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { ObservedFile, ObservedRepository, RepositoryContractIr } from "./types.ts";

const SKIP_DIRECTORIES = new Set([".git", ".nmg", "node_modules"]);
const SKIP_PATH_PREFIXES = [".rcp/receipts"];
/** Soft cost signal only; it never blocks a declared wide scope. */
const OBSERVATION_SOFT_BYTES = 256 * 1024 * 1024;

export interface RepositoryProvider {
  readonly descriptor: {
    id: string;
    version: string;
    capabilities: string[];
    operations: string[];
    authority: Array<"plan" | "apply" | "continuous">;
  };
  observe(request: { root: string; contract: RepositoryContractIr }): Promise<ObservedRepository>;
}

export class LocalRepositoryProvider implements RepositoryProvider {
  readonly descriptor = {
    id: "local-repository",
    version: "1",
    capabilities: ["git-observation", "worktree-content-digest"],
    operations: ["observe"],
    authority: ["plan", "apply", "continuous"] as Array<"plan" | "apply" | "continuous">,
  };

  async observe(request: {
    root: string;
    contract: RepositoryContractIr;
  }): Promise<ObservedRepository> {
    return observeRepository(request.root, request.contract);
  }
}

export function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function globMatches(pattern: string, path: string): boolean {
  const normalizedPattern = normalizeRepositoryPath(pattern);
  const normalizedPath = normalizeRepositoryPath(path);
  return globRegex(normalizedPattern).test(normalizedPath);
}

export function isPathAllowed(path: string, scope: RepositoryContractIr["scope"]): boolean {
  return (
    scope.include.some((pattern) => globMatches(pattern, path)) &&
    !scope.exclude.some((pattern) => globMatches(pattern, path))
  );
}

/** Can any file under the relative directory match any include pattern?
 * Conservative prefix reasoning: a directory is pruned only when no include
 * glob could reach a file inside it. Leading literal segments before the first
 * glob segment anchor reachability; a glob in the first segment (for example
 * a leading double-star segment or a top-level `*.md`) can match anywhere
 * and disables pruning. Exclude patterns
 * only narrow per-file matches and never broaden reachability, so they are
 * ignored here. Over-approximation (descending where a single `*` segment
 * could not actually reach) is safe; under-approximation is not.
 */
export function scopeDirectoryReachable(directory: string, include: readonly string[]): boolean {
  const dir = normalizeRepositoryPath(directory);
  if (!dir) return true; // the repository root is always traversed
  return include.some((pattern) => includePatternReaches(pattern, dir));
}

function includePatternReaches(pattern: string, dir: string): boolean {
  const normalized = normalizeRepositoryPath(pattern);
  if (!normalized) return false;
  const segments = normalized.split("/");
  if (hasGlob(segments[0]!)) return true; // may match anywhere
  const literals: string[] = [];
  for (const segment of segments) {
    if (hasGlob(segment)) break;
    literals.push(segment);
  }
  const prefix = literals.join("/");
  if (literals.length === segments.length) {
    // No glob anywhere: the pattern is a literal file path. A bare root-level
    // file (one segment) matches nothing inside a subdirectory.
    if (literals.length === 1) return false;
    const parent = literals.slice(0, -1).join("/");
    return dir === parent || parent.startsWith(`${dir}/`);
  }
  // A glob follows the literal prefix: reachable directories lie at-or-under
  // the prefix (at-or-under over-approximation is safe for a single `*`).
  return dir === prefix || dir.startsWith(`${prefix}/`) || prefix.startsWith(`${dir}/`);
}

function hasGlob(segment: string): boolean {
  return segment.includes("*") || segment.includes("?");
}

export function observeRepository(
  root: string,
  contract: RepositoryContractIr,
  options?: { softBytes?: number },
): ObservedRepository {
  const resolvedRoot = resolve(root);
  const softBytes = options?.softBytes ?? OBSERVATION_SOFT_BYTES;
  const diagnostics: string[] = [];
  const files: ObservedFile[] = [];
  const stats = { bytes: 0 };
  collectFiles(resolvedRoot, resolvedRoot, contract, files, diagnostics, stats);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const observedGit = observeGitWorktree(resolvedRoot);
  const git = {
    ...observedGit,
    dirtyFiles: observedGit.dirtyFiles.filter((path) => !isSkippedRepositoryPath(path)),
  };
  if (!git.available && git.error) diagnostics.push(git.error);
  if (stats.bytes > softBytes) {
    diagnostics.push(
      `declared scope reaches ${files.length} file(s) totalling ` +
        `${Math.round(stats.bytes / (1024 * 1024))} MiB of content to read; ` +
        "a catch-all or wide include can make observation expensive",
    );
  }
  const observedRevision = digestObservation(contract, files);
  return {
    root: normalizeRepositoryPath(resolvedRoot),
    observedRevision,
    git,
    files,
    diagnostics,
    observedBytes: stats.bytes,
  };
}

export function changedPaths(before: ObservedRepository, after: ObservedRepository): string[] {
  const oldFiles = new Map(before.files.map((file) => [file.path, file.digest]));
  const newFiles = new Map(after.files.map((file) => [file.path, file.digest]));
  const all = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  return [...all]
    .filter((path) => oldFiles.get(path) !== newFiles.get(path))
    .sort((left, right) => left.localeCompare(right));
}

export function digestRepositoryPaths(root: string, scopes: string[]): string {
  const hash = createHash("sha256");
  const resolvedRoot = resolve(root);
  for (const scope of [...scopes].sort()) {
    updateExplicitPathDigest(hash, resolvedRoot, normalizeRepositoryPath(scope));
  }
  return hash.digest("hex");
}

function collectFiles(
  root: string,
  directory: string,
  contract: RepositoryContractIr,
  output: ObservedFile[],
  diagnostics: string[],
  stats: { bytes: number },
): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const local = normalizeRepositoryPath(relative(root, absolute));
    if (isSkippedRepositoryPath(local)) {
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      // Prune only directories no include pattern can reach; per-file scope
      // filtering below is unchanged. Receipt and skip rules still apply first.
      if (!scopeDirectoryReachable(local, contract.scope.include)) continue;
      collectFiles(root, absolute, contract, output, diagnostics, stats);
      continue;
    }
    if (!isPathAllowed(local, contract.scope)) continue;
    try {
      if (stat.isSymbolicLink()) {
        output.push({ path: local, kind: "symlink", digest: digestBytes(readlinkSync(absolute)) });
      } else if (stat.isFile()) {
        output.push({ path: local, kind: "file", digest: digestBytes(readFileSync(absolute)) });
        stats.bytes += stat.size;
      }
    } catch (cause) {
      diagnostics.push(`${local}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}

function isSkippedRepositoryPath(path: string): boolean {
  return SKIP_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function observeGitWorktree(root: string): ObservedRepository["git"] {
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  const branch = run(["branch", "--show-current"]);
  const commit = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const unbornHead =
    commit.status !== 0 &&
    /ambiguous argument ['"]?HEAD|unknown revision|Needed a single revision/i.test(
      `${commit.stderr ?? ""} ${commit.stdout ?? ""}`,
    );
  if (branch.status !== 0 || status.status !== 0 || (commit.status !== 0 && !unbornHead)) {
    const failed = [branch, status, commit].find(
      (result) => result.status !== 0 && (result !== commit || !unbornHead),
    )!;
    const code = (failed.error as NodeJS.ErrnoException | undefined)?.code;
    const detail =
      failed.error?.message ?? failed.stderr?.trim() ?? `git exited with ${failed.status}`;
    return {
      available: false,
      dirtyFiles: [],
      error: `git observation failed${code ? ` (${code})` : ""}: ${detail.replaceAll(/\s+/g, " ")}`,
    };
  }
  const entries = status.stdout.split("\0").filter(Boolean);
  const dirtyFiles: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const statusCode = entry.slice(0, 2);
    dirtyFiles.push(normalizeRepositoryPath(entry.slice(3)));
    if (statusCode.includes("R") || statusCode.includes("C")) index += 1;
  }
  return {
    available: true,
    branch: branch.stdout.trim() || undefined,
    commit: unbornHead ? undefined : commit.stdout.trim() || undefined,
    dirtyFiles: dirtyFiles.sort((left, right) => left.localeCompare(right)),
  };
}

function updateExplicitPathDigest(
  hash: ReturnType<typeof createHash>,
  root: string,
  scope: string,
): void {
  const path = resolve(root, scope);
  const local = relative(root, path);
  if (local.startsWith("..")) {
    hash.update(`external:${scope}\0`);
    return;
  }
  if (!existsSync(path)) {
    hash.update(`missing:${scope}\0`);
    return;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    hash.update(`link:${scope}:${readlinkSync(path)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`directory:${scope}\0`);
    for (const entry of readdirSync(path, { withFileTypes: true })
      .filter((entry) => !SKIP_DIRECTORIES.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      updateExplicitPathDigest(hash, root, join(scope, entry.name));
    }
    return;
  }
  hash.update(`file:${scope}\0`);
  hash.update(readFileSync(path));
  hash.update("\0");
}

function digestObservation(contract: RepositoryContractIr, files: ObservedFile[]): string {
  const hash = createHash("sha256");
  hash.update(contract.contractDigest);
  for (const file of files) hash.update(`\0${file.kind}:${file.path}:${file.digest}`);
  return `sha256:${hash.digest("hex")}`;
}

function digestBytes(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function globRegex(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += escapeRegex(character);
  }
  return new RegExp(`${expression}$`);
}

function escapeRegex(value: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(value) ? `\\${value}` : value;
}
