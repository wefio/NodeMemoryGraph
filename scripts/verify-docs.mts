import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

export interface DocumentationReport {
  files: number;
  errors: string[];
  warnings: string[];
}

// Implements docs/README.md#ci-contract. That documented table owns policy;
// this file only translates its mechanically checkable rules into diagnostics.

const lifecycle = new Set(["proposed", "implemented", "rejected", "archived"]);
const publicPairs = [
  ["README.md", "README.zh-CN.md"],
  ["docs/README.md", "docs/README.zh-CN.md"],
  ["docs/decisions/README.md", "docs/decisions/README.zh-CN.md"],
];

function markdownFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function withoutCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

function headings(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /^#{1,2}\s+\S/.test(line));
}

function sectionBody(text: string, names: string[]): string | undefined {
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[index])?.[1].toLowerCase();
    if (!heading || !accepted.has(heading)) continue;
    const body: string[] = [];
    for (
      let cursor = index + 1;
      cursor < lines.length && !/^##\s+/.test(lines[cursor]);
      cursor += 1
    ) {
      body.push(lines[cursor]);
    }
    return body.join("\n").trim();
  }
  return undefined;
}

function decisionCounterpart(path: string): string {
  return path.endsWith(".zh-CN.md")
    ? path.replace(/\.zh-CN\.md$/, ".md")
    : path.replace(/\.md$/, ".zh-CN.md");
}

function decisionSlug(path: string): string {
  return basename(path)
    .replace(/\.zh-CN\.md$/, "")
    .replace(/\.md$/, "");
}

function linksToFile(text: string, targetPath: string): boolean {
  const target = basename(targetPath);
  return [...withoutCodeFences(text).matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)].some(
    (match) => basename(match[1].trim().replace(/^<|>$/g, "").split("#", 1)[0]) === target,
  );
}

function checkPairedLinksAndHeadings(
  leftPath: string,
  rightPath: string,
  display: string,
  report: DocumentationReport,
): void {
  if (!existsSync(leftPath) || !existsSync(rightPath)) return;
  const left = readFileSync(leftPath, "utf8");
  const right = readFileSync(rightPath, "utf8");
  if (!linksToFile(left, rightPath) || !linksToFile(right, leftPath)) {
    report.warnings.push(`${display}: bilingual pair must link to each other`);
  }
  const counts = [headings(left).length, headings(right).length];
  const largest = Math.max(...counts, 1);
  if (Math.abs(counts[0] - counts[1]) / largest > 0.4) {
    report.warnings.push(`${display}: heading structure differs materially`);
  }
}

function checkSkillEntry(path: string, text: string, report: DocumentationReport): void {
  const display = path.replaceAll("\\", "/");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!frontmatter) {
    report.errors.push(`${display}: Skill entry needs YAML frontmatter`);
    return;
  }
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter);
  } catch {
    report.errors.push(`${display}: Skill frontmatter must be valid YAML`);
    return;
  }
  const record =
    metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const expectedName = basename(dirname(path));
  if (name !== expectedName) {
    report.errors.push(`${display}: Skill name must match directory '${expectedName}'`);
  }
  if (!description) report.errors.push(`${display}: Skill description must be non-empty`);
}

function checkDecision(
  path: string,
  text: string,
  kind: string,
  report: DocumentationReport,
): void {
  const display = path.replaceAll("\\", "/");
  const status = /^\*\*Status:\*\*\s*(.+?)\s*$/im.exec(text)?.[1].toLowerCase();
  const expected = kind;
  if (status !== expected) {
    report.errors.push(`${display}: Status must match lifecycle '${expected}'`);
  }

  const required: string[][] =
    kind === "proposed"
      ? [
          ["Problem", "问题"],
          ["Proposal", "提案"],
          ["Alternatives considered", "考虑过的替代方案"],
          ["Acceptance criteria", "验收标准"],
          ["Risks", "风险"],
        ]
      : kind === "rejected"
        ? [
            ["Problem", "问题"],
            ["Proposal", "提案"],
            ["Alternatives considered", "考虑过的替代方案"],
          ]
        : [
            ["Problem", "问题"],
            ["Decision", "决策"],
            ["Alternatives considered", "考虑过的替代方案"],
            ["Consequences", "后果"],
          ];
  for (const alternatives of required) {
    const body = sectionBody(text, alternatives);
    if (body === undefined) {
      report.errors.push(`${display}: missing section '${alternatives.join(" / ")}'`);
    } else if (!body) {
      report.errors.push(`${display}: empty section '${alternatives.join(" / ")}'`);
    }
  }
  if (kind === "archived" && !/^\*\*Archived:\*\*\s*\d{4}-\d{2}-\d{2}/im.test(text)) {
    report.errors.push(`${display}: archived decisions need an Archived date`);
  }
  if (!existsSync(decisionCounterpart(path))) {
    report.warnings.push(`${display}: bilingual decision counterpart is missing`);
  }

  const relationship = /^\*\*(Supersedes|Superseded by):\*\*\s*\[[^\]]+\]\(([^)]+)\)\s*$/gim;
  for (const match of text.matchAll(relationship)) {
    const target = resolve(dirname(path), match[2].split("#", 1)[0]);
    if (!existsSync(target)) continue;
    const targetText = readFileSync(target, "utf8");
    const reciprocalLabel =
      match[1].toLowerCase() === "supersedes" ? "Superseded by" : "Supersedes";
    const reciprocal = new RegExp(
      `^\\*\\*${reciprocalLabel}:\\*\\*\\s*\\[[^\\]]+\\]\\(([^)]+)\\)\\s*$`,
      "gim",
    );
    const reciprocated = [...targetText.matchAll(reciprocal)].some(
      (candidate) => resolve(dirname(target), candidate[1].split("#", 1)[0]) === resolve(path),
    );
    if (!reciprocated) {
      report.warnings.push(`${display}: '${match[1]}' link is not reciprocated by ${match[2]}`);
    }
  }
}

function checkLocalLinks(
  root: string,
  path: string,
  text: string,
  report: DocumentationReport,
  strict: boolean,
): void {
  const clean = withoutCodeFences(text);
  const link = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of clean.matchAll(link)) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (
      !target ||
      target.startsWith("#") ||
      target.startsWith("/") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      continue;
    }
    target = target.split("#", 1)[0].split("?", 1)[0];
    try {
      target = decodeURIComponent(target);
    } catch {
      report.errors.push(`${relative(root, path)}: invalid encoded link '${match[1]}'`);
      continue;
    }
    const resolved = resolve(dirname(path), target);
    if (!existsSync(resolved)) {
      const message = `${relative(root, path)}: broken local link '${match[1]}'`;
      (strict ? report.errors : report.warnings).push(message);
    }
  }
}

function isContractDocument(display: string): boolean {
  if (new Set(["README.md", "README.zh-CN.md"]).has(display)) return true;
  if (
    new Set([
      "docs/README.md",
      "docs/README.zh-CN.md",
      "docs/design/design.md",
      "docs/design/completion-audit.md",
      "docs/decisions/README.md",
      "docs/decisions/README.zh-CN.md",
    ]).has(display)
  ) {
    return true;
  }
  if (/^docs\/decisions\/(proposed|implemented|rejected|archived)\/.+\.md$/.test(display)) {
    return true;
  }
  return /^skills\/[^/]+\/SKILL\.md$/.test(display);
}

export function verifyDocumentation(rootDirectory = process.cwd()): DocumentationReport {
  const root = resolve(rootDirectory);
  const report: DocumentationReport = { files: 0, errors: [], warnings: [] };
  const candidates = new Set<string>();
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const path = join(root, name);
    if (existsSync(path)) candidates.add(path);
  }
  for (const directory of ["docs", "skills"]) {
    for (const path of markdownFiles(join(root, directory))) candidates.add(path);
  }

  for (const pair of publicPairs) {
    const missing = pair.filter((name) => !existsSync(join(root, name)));
    if (missing.length > 0) {
      report.errors.push(`missing public bilingual document: ${missing.join(", ")}`);
      continue;
    }
    checkPairedLinksAndHeadings(
      join(root, pair[0]),
      join(root, pair[1]),
      pair.join(" <-> "),
      report,
    );
  }

  const decisionLocations = new Map<string, Set<string>>();
  for (const path of candidates) {
    const display = relative(root, path).replaceAll("\\", "/");
    const match = /^docs\/decisions\/(proposed|implemented|rejected|archived)\/([^/]+\.md)$/.exec(
      display,
    );
    if (!match) continue;
    const slug = decisionSlug(path);
    const locations = decisionLocations.get(slug) ?? new Set<string>();
    locations.add(match[1]);
    decisionLocations.set(slug, locations);
    if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      report.errors.push(`${display}: decision filename must be YYYY-MM-DD-kebab-case.md`);
    }
  }
  for (const [slug, locations] of decisionLocations) {
    if (locations.size > 1) {
      report.errors.push(
        `docs/decisions: '${slug}' exists in multiple lifecycle directories: ${[...locations].sort().join(", ")}`,
      );
    }
  }

  for (const path of [...candidates].sort()) {
    const text = readFileSync(path, "utf8");
    const display = relative(root, path).replaceAll("\\", "/");
    const strict = isContractDocument(display);
    report.files += 1;
    if (!/^#\s+\S/m.test(text)) {
      (strict ? report.errors : report.warnings).push(`${display}: missing H1`);
    }
    checkLocalLinks(root, path, text, report, strict);

    if (/^skills\/[^/]+\/SKILL\.md$/.test(display)) {
      checkSkillEntry(path, text, report);
    }

    const parts = display.split("/");
    if (
      parts[0] === "docs" &&
      parts.length === 2 &&
      !new Set(["README.md", "README.zh-CN.md", "AGENTS.md"]).has(parts[1])
    ) {
      report.warnings.push(
        `${display}: documentation content must live in design/, decisions/, or experiments/`,
      );
    }
    if (parts[0] === "docs" && parts[1] === "decisions" && lifecycle.has(parts[2])) {
      checkDecision(path, text, parts[2], report);
      if (!path.endsWith(".zh-CN.md")) {
        const counterpart = decisionCounterpart(path);
        checkPairedLinksAndHeadings(path, counterpart, display, report);
      }
    }
    if (
      parts[0] === "docs" &&
      parts[1] === "experiments" &&
      parts.length === 3 &&
      !/-\d{4}-\d{2}-\d{2}\.md$/.test(parts[2]) &&
      !/-(results|notes)\.md$/.test(parts[2])
    ) {
      report.warnings.push(`${display}: experiment report filename should end in -YYYY-MM-DD.md`);
    }
  }
  return report;
}

function printReport(report: DocumentationReport): void {
  for (const warning of report.warnings) console.warn(`warning: ${warning}`);
  for (const error of report.errors) console.error(`error: ${error}`);
  console.log(
    `docs: ${report.files} files, ${report.errors.length} errors, ${report.warnings.length} warnings`,
  );
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const report = verifyDocumentation(process.cwd());
  printReport(report);
  if (report.errors.length > 0) process.exitCode = 1;
}
