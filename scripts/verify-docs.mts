import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface DocumentationReport {
  files: number;
  errors: string[];
  warnings: string[];
}

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
  return text
    .split(/\r?\n/)
    .filter((line) => /^#{1,2}\s+\S/.test(line));
}

function hasHeading(text: string, names: string[]): boolean {
  const found = new Set(
    text
      .split(/\r?\n/)
      .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1].toLowerCase())
      .filter((value): value is string => Boolean(value)),
  );
  return names.some((name) => found.has(name.toLowerCase()));
}

function decisionCounterpart(path: string): string {
  return path.endsWith(".zh-CN.md")
    ? path.replace(/\.zh-CN\.md$/, ".md")
    : path.replace(/\.md$/, ".zh-CN.md");
}

function checkDecision(
  path: string,
  text: string,
  kind: string,
  report: DocumentationReport,
): void {
  const display = path.replaceAll("\\", "/");
  const status = /^\*\*Status:\*\*\s*(.+?)\s*$/im.exec(text)?.[1].toLowerCase();
  const expected = kind === "archived" ? "implemented" : kind;
  if (!status || !status.startsWith(expected)) {
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
    if (!hasHeading(text, alternatives)) {
      report.errors.push(`${display}: missing section '${alternatives.join(" / ")}'`);
    }
  }
  if (kind === "archived" && !/^\*\*Archived:\*\*\s*\d{4}-\d{2}-\d{2}/im.test(text)) {
    report.errors.push(`${display}: archived decisions need an Archived date`);
  }
  if (!existsSync(decisionCounterpart(path))) {
    report.warnings.push(`${display}: bilingual decision counterpart is missing`);
  }
}

function checkLocalLinks(
  root: string,
  path: string,
  text: string,
  report: DocumentationReport,
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
      report.errors.push(`${relative(root, path)}: broken local link '${match[1]}'`);
    }
  }
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
    const counts = pair.map((name) => headings(readFileSync(join(root, name), "utf8")).length);
    const largest = Math.max(...counts, 1);
    if (Math.abs(counts[0] - counts[1]) / largest > 0.4) {
      report.warnings.push(`${pair.join(" <-> ")}: heading structure differs materially`);
    }
  }

  for (const path of [...candidates].sort()) {
    const text = readFileSync(path, "utf8");
    const display = relative(root, path).replaceAll("\\", "/");
    report.files += 1;
    if (!/^#\s+\S/m.test(text)) report.errors.push(`${display}: missing H1`);
    checkLocalLinks(root, path, text, report);

    const parts = display.split("/");
    if (parts[0] === "docs" && parts[1] === "decisions" && lifecycle.has(parts[2])) {
      checkDecision(path, text, parts[2], report);
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
