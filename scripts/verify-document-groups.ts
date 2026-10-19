import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Scope and the disposable exception are owned by docs/README.md#ci-contract.
const suffixes = [".md", ".zh-CN.md", ".terms.yaml"] as const;
const scratch =
  "docs/experiments/execution/archive/ooo-arms-2026-09-19/speculation-earm/run2-2026-09-19T05-40-04-311Z/CLEANABLE-scratch-2026-09-19";
const scratchCleanup = "may be deleted once a record quotes its numbers";

export interface DocumentGroupReport {
  groups: number;
  disposable: number;
  errors: string[];
}

function groupStem(path: string): string | undefined {
  // Match the language suffix before the generic Markdown suffix.
  for (const suffix of [".zh-CN.md", ".terms.yaml", ".md"]) {
    if (path.endsWith(suffix)) return path.slice(0, -suffix.length);
  }
  return undefined;
}

function collectArtifacts(root: string, directory: string, files: Set<string>): void {
  const path = join(root, directory);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) collectArtifacts(root, file, files);
    else if (groupStem(file) !== undefined) files.add(file);
  }
}

function isRegularFile(root: string, path: string): boolean {
  return lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true;
}

function isDisposable(root: string, stem: string, members: Set<string>): boolean {
  const source = `${stem}.md`;
  return (
    stem === scratch &&
    members.size === 1 &&
    members.has(source) &&
    isRegularFile(root, source) &&
    readFileSync(join(root, source), "utf8").includes(scratchCleanup)
  );
}

/**
 * Check file completeness, not translation quality, YAML semantics or review freshness.
 * Discovery includes orphan counterparts and terms files, without a rollout whitelist.
 */
export function verifyDocumentGroups(rootDirectory = process.cwd()): DocumentGroupReport {
  const root = resolve(rootDirectory);
  const files = new Set(["README.md", "README.zh-CN.md", "README.terms.yaml"]);
  for (const directory of ["docs", "skills"]) collectArtifacts(root, directory, files);
  const groups = new Map<string, Set<string>>();
  for (const file of [...files].sort()) {
    const stem = groupStem(file);
    if (stem === undefined) continue;
    const members = groups.get(stem) ?? new Set<string>();
    members.add(file);
    groups.set(stem, members);
  }
  const report: DocumentGroupReport = { groups: 0, disposable: 0, errors: [] };
  for (const [stem, members] of groups) {
    if (isDisposable(root, stem, members)) {
      report.disposable += 1;
      continue;
    }
    report.groups += 1;
    for (const suffix of suffixes) {
      const path = stem + suffix;
      if (!isRegularFile(root, path)) report.errors.push(`${stem}: missing regular file ${path}`);
    }
  }
  return report;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const report = verifyDocumentGroups();
  for (const error of report.errors) console.error(`error: ${error}`);
  console.log(
    `document groups: ${report.groups} groups, ${report.errors.length} errors, ${report.disposable} disposable (root README, docs/, skills/)`,
  );
  if (report.errors.length > 0) process.exitCode = 1;
}
