import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

export interface DocumentationReport {
  files: number;
  errors: string[];
  warnings: string[];
  decisions: { implemented: number; open: number };
}

// Implements docs/README.md#ci-contract. That documented table owns policy;
// this file only translates its mechanically checkable rules into diagnostics.

const lifecycle = new Set(["proposed", "implemented", "rejected", "archived"]);

// Byte ceilings for standing rule documents that generative Agents read every
// session. Policy owner is docs/README.md#ci-contract (the byte-budget row).
// Budgets are set by the maintainer: rule/skill docs are capped at 2,000 words
// (~15,000 B at ~7.3 B/word, rounded); AGENTS.md and indexes at 5,000 B each.
// Raise a ceiling only when the content genuinely needs the space, never to
// absorb bloat.
const BYTE_BUDGETS: Record<string, number> = {
  "AGENTS.md": 5000,
  "skills/doc-maintenance/SKILL.md": 15000, // 2,000 words x ~7.3 B/word
  "skills/repo-development/SKILL.md": 15000, // 2,000 words x ~7.3 B/word
  "skills/nmg-memory/SKILL.md": 15000, // 2,000 words x ~7.3 B/word
  "skills/verification-traceability/SKILL.md": 15000, // 2,000 words x ~7.3 B/word
  "skills/script-reuse/SKILL.md": 15000, // 2,000 words x ~7.3 B/word
  "docs/decisions/README.md": 5000,
};
const publicPairs = [
  ["README.md", "README.zh-CN.md"],
  ["docs/README.md", "docs/README.zh-CN.md"],
  ["docs/decisions/README.md", "docs/decisions/README.zh-CN.md"],
  ["docs/postmortem/README.md", "docs/postmortem/README.zh-CN.md"],
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
  checkDecisionHeader(path, text, kind, report);
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
  if (kind === "implemented") {
    const proposalEra: string[][] = [
      ["Proposal", "提案"],
      ["Plan", "计划"],
      ["Acceptance criteria", "验收标准"],
    ];
    for (const banned of proposalEra) {
      if (sectionBody(text, banned) !== undefined) {
        report.errors.push(
          `${display}: implemented decision must not carry the proposal-era heading '${banned[0]}'`,
        );
      }
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

// The header block of a decision is the lines before its first section. It
// carries a closed set of fields so the vocabulary cannot drift: anything else
// is prose and belongs below the block.
const HEADER_FIELDS = new Set([
  "status",
  "approved",
  "supersedes",
  "superseded by",
  "relates to",
  "archived",
]);
/** How an implemented record was accepted. `unrecorded` is debt, like
 *  `documented-only`: accepted before the rule existed, without a recorded act. */
const APPROVAL_VALUES = ["explicit", "auto", "unrecorded"] as const;

function checkDecisionHeader(
  path: string,
  text: string,
  kind: string,
  report: DocumentationReport,
): void {
  const display = path.replaceAll("\\", "/");
  const lines = text.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^##\s+/.test(line));
  const header = firstSection === -1 ? lines : lines.slice(0, firstSection);
  const counts = new Map<string, { name: string; count: number }>();
  for (const line of header) {
    const name = /^\*\*([^*]+):\*\*/.exec(line)?.[1];
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = counts.get(key) ?? { name, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    if (!HEADER_FIELDS.has(key)) {
      report.errors.push(
        `${display}: unknown header field '**${name}:**'; header fields are ${[...HEADER_FIELDS].join(", ")}`,
      );
    }
  }
  for (const [key, entry] of counts) {
    if (entry.count > 1) {
      report.errors.push(
        `${display}: header field '**${entry.name}:**' appears ${entry.count} times`,
      );
    }
    if (key === "archived" && kind !== "archived") {
      report.errors.push(`${display}: '**Archived:**' is only valid in archived/`);
    }
  }
  if (!counts.has("status")) {
    report.errors.push(`${display}: missing required header field '**Status:**'`);
  }
  if (kind === "implemented") {
    const approved = header
      .map((line) => /^\*\*Approved:\*\*\s*(.+?)\s*$/i.exec(line)?.[1])
      .find((value) => value !== undefined);
    if (approved === undefined) {
      report.errors.push(
        `${display}: '**Approved:**' is required; one of ${APPROVAL_VALUES.join(", ")}`,
      );
    } else if (!APPROVAL_VALUES.some((allowed) => allowed === approved.toLowerCase())) {
      report.errors.push(
        `${display}: '**Approved:**' must be one of ${APPROVAL_VALUES.join(", ")}`,
      );
    }
  }
}

// A design document's header is the lines before its first section. The field
// set is closed and the status is an enum, because the free-form vocabulary it
// replaces had 21 distinct values across 19 documents and no machine could read
// a state from them. An absent status means the document is current: the tier
// holds current-state design, so only the exceptions have to say so.
const DESIGN_HEADER_FIELDS = new Set([
  "status",
  "created",
  "updated",
  "authority",
  "related",
  "supersedes",
  "superseded by",
]);
const DESIGN_STATUSES = ["draft", "current", "superseded"];

function checkDesignHeader(path: string, text: string, report: DocumentationReport): void {
  const display = path.replaceAll("\\", "/");
  const archived = /[/\\]docs[/\\]design[/\\]archived[/\\]/.test(path);
  const lines = text.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^##\s+/.test(line));
  const header = firstSection === -1 ? lines : lines.slice(0, firstSection);
  const counts = new Map<string, { name: string; count: number }>();
  for (const line of header) {
    const name = /^\*\*([^*]+):\*\*/.exec(line)?.[1];
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = counts.get(key) ?? { name, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    if (!DESIGN_HEADER_FIELDS.has(key)) {
      report.errors.push(
        `${display}: unknown header field '**${name}:**'; header fields are ${[...DESIGN_HEADER_FIELDS].join(", ")}`,
      );
    }
  }
  for (const entry of counts.values()) {
    if (entry.count > 1) {
      report.errors.push(
        `${display}: header field '**${entry.name}:**' appears ${entry.count} times`,
      );
    }
  }
  const status = header
    .map((line) => /^\*\*Status:\*\*\s*(.+?)\s*$/i.exec(line)?.[1])
    .find((value) => value !== undefined);
  const token = status === undefined ? undefined : /^[A-Za-z]+/.exec(status)?.[0].toLowerCase();
  if (token !== undefined && !DESIGN_STATUSES.includes(token)) {
    report.errors.push(`${display}: Status '${token}' is not one of ${DESIGN_STATUSES.join(", ")}`);
  }
  if (token === "superseded") {
    if (!counts.has("superseded by")) {
      report.errors.push(`${display}: a superseded design needs a '**Superseded by:**' link`);
    }
    if (!archived) {
      report.errors.push(`${display}: a superseded design belongs in docs/design/archived/`);
    }
  }
  if (archived && token !== "superseded") {
    report.errors.push(`${display}: documents in docs/design/archived/ must be superseded`);
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

// A post-mortem is a backward-looking failure record: what broke, the mechanism
// behind it, why every safety net missed it, and the guardrails that now catch
// the class. Its sections are the questions the record has to answer, so the tier
// cannot decay into a narrative pile, and its number is contiguous so the corpus
// stays countable. Policy owner: docs/README.md#ci-contract.
const POSTMORTEM_HEADER_FIELDS = new Set(["status"]);
const POSTMORTEM_STATUSES = ["open", "resolved"];
const POSTMORTEM_SECTIONS: string[][] = [
  ["Executive summary", "执行摘要"],
  ["Summary", "事件经过", "详细经过"],
  ["Impact", "影响"],
  ["Timeline", "时间线"],
  ["Root cause", "根本原因", "根因"],
  ["Guardrails added", "新增防护", "新增防线"],
  ["Lessons", "经验教训", "教训"],
];
// `0001-slug.md` names a record and `0001-slug.zh-CN.md` is its translation. Numbering
// and the index count records, so they read the English name; the naming rule accepts
// either, because a tier whose records are meant to be paired cannot reject the name it
// asks for. (It did: the Chinese counterpart was reported as misnamed, while the missing-
// translation notice went the other way.)
const POSTMORTEM_RECORD = /^docs\/postmortem\/(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const POSTMORTEM_TRANSLATION = /^docs\/postmortem\/(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.zh-CN\.md$/;

function isPostmortemFile(display: string): boolean {
  return POSTMORTEM_RECORD.test(display) || POSTMORTEM_TRANSLATION.test(display);
}

const POSTMORTEM_INDEX = new Set(["README.md", "README.zh-CN.md"]);

function postmortemCounterpart(path: string): string {
  return path.endsWith(".zh-CN.md")
    ? path.replace(/\.zh-CN\.md$/, ".md")
    : path.replace(/\.md$/, ".zh-CN.md");
}

/** The header block is the lines before the first section: a closed field set whose
 *  only member is `Status`. The name and its colon stay English even in a translation,
 *  so a localized field is an unknown field — and says so, rather than reporting the
 *  English field it replaced as missing. */
function checkPostmortemHeader(
  header: readonly string[],
  display: string,
  report: DocumentationReport,
): void {
  const counts = new Map<string, { name: string; count: number }>();
  for (const line of header) {
    const name = /^\*\*([^*]+)[:：]\*\*/.exec(line)?.[1];
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = counts.get(key) ?? { name, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    if (!POSTMORTEM_HEADER_FIELDS.has(key)) {
      report.errors.push(
        `${display}: unknown header field '**${name}:**'; header fields are ${[...POSTMORTEM_HEADER_FIELDS].join(", ")}`,
      );
    }
  }
  for (const entry of counts.values()) {
    if (entry.count > 1) {
      report.errors.push(
        `${display}: header field '**${entry.name}:**' appears ${entry.count} times`,
      );
    }
  }
  const status = header
    .map((line) => /^\*\*Status:\*\*\s*(.+?)\s*$/i.exec(line)?.[1])
    .find((value) => value !== undefined)
    ?.toLowerCase();
  if (status === undefined) {
    report.errors.push(
      `${display}: missing required header field '**Status:**' (the field name and its colon stay English in a translation; the sections are what may be translated)`,
    );
  } else if (!POSTMORTEM_STATUSES.some((allowed) => allowed === status)) {
    report.errors.push(
      `${display}: '**Status:**' must be one of ${POSTMORTEM_STATUSES.join(", ")}`,
    );
  }
}

function checkPostmortemRecord(
  path: string,
  text: string,
  display: string,
  report: DocumentationReport,
): void {
  const lines = text.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^##\s+/.test(line));
  checkPostmortemHeader(
    firstSection === -1 ? lines : lines.slice(0, firstSection),
    display,
    report,
  );
  for (const alternatives of POSTMORTEM_SECTIONS) {
    const body = sectionBody(text, alternatives);
    if (body === undefined) {
      report.errors.push(`${display}: missing section '${alternatives[0]}'`);
    } else if (!body) {
      report.errors.push(`${display}: empty section '${alternatives[0]}'`);
    }
  }
  if (path.endsWith(".zh-CN.md")) return;
  const counterpart = postmortemCounterpart(path);
  if (!existsSync(counterpart)) {
    report.warnings.push(`${display}: bilingual post-mortem counterpart is missing`);
    return;
  }
  checkPairedLinksAndHeadings(path, counterpart, display, report);
}

/** A file inside the tier is either a numbered record or a naming error. */
function checkPostmortemFile(
  path: string,
  text: string,
  display: string,
  report: DocumentationReport,
): void {
  if (POSTMORTEM_INDEX.has(basename(path))) return;
  if (!isPostmortemFile(display)) {
    report.errors.push(
      `${display}: a post-mortem record is named NNNN-kebab-case.md (with an optional .zh-CN translation) in docs/postmortem/`,
    );
    return;
  }
  checkPostmortemRecord(path, text, display, report);
}

/** A decision file also carries the counters `docs:check` prints, so the owner of a
 *  record is the only place that counts one. */
function checkDecisionFile(
  path: string,
  text: string,
  display: string,
  kind: string,
  report: DocumentationReport,
): void {
  checkDecision(path, text, kind, report);
  if (kind === "implemented" && !display.endsWith(".zh-CN.md")) {
    report.decisions.implemented += 1;
    const deferred = sectionBody(text, ["Deferred", "未完成项"]);
    if (deferred !== undefined && deferred.length > 0 && !/^none\.?$/i.test(deferred)) {
      report.decisions.open += 1;
    }
  }
  if (path.endsWith(".zh-CN.md")) return;
  checkPairedLinksAndHeadings(path, decisionCounterpart(path), display, report);
}

/** Numbers identify records, so one number may name one record and the run from
 *  `0001` may not have gaps. */
function checkPostmortemNumbers(
  numbers: ReadonlyMap<string, string[]>,
  report: DocumentationReport,
): void {
  for (const [number, files] of numbers) {
    if (files.length > 1) {
      report.errors.push(`docs/postmortem: number ${number} is used by ${files.sort().join(", ")}`);
    }
  }
  const used = new Set([...numbers.keys()].map(Number));
  for (let expected = 1; expected <= used.size; expected += 1) {
    if (used.has(expected)) continue;
    report.errors.push(
      `docs/postmortem: numbering must be contiguous from 0001; ${String(expected).padStart(4, "0")} is missing`,
    );
  }
}

/** The index is a checked copy: every record is listed exactly once, and a row that
 *  names no record fails through the contract-document link check. */
function checkPostmortemIndex(
  index: string,
  records: readonly string[],
  report: DocumentationReport,
): void {
  const listed = new Map<string, number>();
  const links = withoutCodeFences(readFileSync(index, "utf8"));
  for (const match of links.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "").split("#", 1)[0].split("?", 1)[0];
    const name = basename(target);
    if (!POSTMORTEM_RECORD.exec(`docs/postmortem/${name}`)) continue;
    listed.set(name, (listed.get(name) ?? 0) + 1);
  }
  for (const path of records) {
    const name = basename(path);
    const count = listed.get(name) ?? 0;
    if (count === 0) {
      report.errors.push(`docs/postmortem/README.md: '${name}' is not listed in the index`);
    } else if (count > 1) {
      report.errors.push(`docs/postmortem/README.md: '${name}' is listed ${count} times`);
    }
  }
}

/** The index is the one home for a record's failure class, so it is a checked
 *  copy rather than a free one: every record is listed exactly once, and the
 *  numbering is contiguous from 0001 so the corpus stays countable. */
function checkPostmortems(root: string, report: DocumentationReport): void {
  const directory = join(root, "docs", "postmortem");
  if (!existsSync(directory)) return;
  const records: string[] = [];
  const numbers = new Map<string, string[]>();
  for (const path of markdownFiles(directory)) {
    const display = relative(root, path).replaceAll("\\", "/");
    const match = POSTMORTEM_RECORD.exec(display);
    if (!match) continue;
    records.push(path);
    const number = match[1]!;
    numbers.set(number, [...(numbers.get(number) ?? []), display]);
  }
  checkPostmortemNumbers(numbers, report);
  const index = join(directory, "README.md");
  if (existsSync(index)) checkPostmortemIndex(index, records, report);
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
      "docs/postmortem/README.md",
      "docs/postmortem/README.zh-CN.md",
    ]).has(display)
  ) {
    return true;
  }
  if (/^docs\/decisions\/(proposed|implemented|rejected|archived)\/.+\.md$/.test(display)) {
    return true;
  }
  if (isPostmortemFile(display)) {
    return true;
  }
  return /^skills\/[^/]+\/SKILL\.md$/.test(display);
}

const PARTS_SHELF = "docs/guides/parts.md";
const COUNTEREXAMPLES_PATH = ".rcp/counterexamples.yaml";
const COUNTEREXAMPLE_STATUSES = ["open", "resolved", "unsubstantiated"] as const;

/**
 * Every part named in a `### `name(...)`` heading of the shelf must still be
 * exported from src/rcp. A rename is exactly the drift a reader would otherwise
 * pay for by opening the source instead of trusting the shelf.
 */
function checkPartsShelf(root: string, report: DocumentationReport): void {
  const directories = [join(root, "src", "rcp"), join(root, "tools", "parts")].filter(existsSync);
  if (directories.length === 0) return;
  const exported = new Set<string>();
  for (const directory of directories) {
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(directory, file), "utf8");
      for (const match of source.matchAll(
        /^export (?:async )?(?:function|const|class|interface|type) ([A-Za-z_][A-Za-z0-9_]*)/gm,
      )) {
        exported.add(match[1]!);
      }
    }
  }
  for (const rel of [PARTS_SHELF, PARTS_SHELF.replace(/\.md$/, ".zh-CN.md")]) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const named = new Set(
      [...readFileSync(path, "utf8").matchAll(/^### `([A-Za-z_][A-Za-z0-9_]*)\(/gm)].map(
        (match) => match[1]!,
      ),
    );
    for (const name of [...named].sort()) {
      if (!exported.has(name)) {
        report.errors.push(
          `${rel}: '${name}' is not exported from src/rcp or tools/parts; the shelf is stale`,
        );
      }
    }
  }
}

/** `.rcp/counterexamples.yaml` is the only home for an open challenge. An `open`
 *  entry must carry the input that shows the claim is false; `unsubstantiated`
 *  exists for a concern that cannot be reproduced, so it must not carry one. */
function checkCounterexamples(root: string, report: DocumentationReport): void {
  const path = join(root, COUNTEREXAMPLES_PATH);
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    report.errors.push(`${COUNTEREXAMPLES_PATH}: ${(cause as Error).message}`);
    return;
  }
  const entries = (parsed as { counterexamples?: unknown } | undefined)?.counterexamples;
  if (!Array.isArray(entries)) {
    report.errors.push(`${COUNTEREXAMPLES_PATH}: needs a 'counterexamples' list`);
    return;
  }
  const seen = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const where = `${COUNTEREXAMPLES_PATH}: counterexamples[${index}]`;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) report.errors.push(`${where}.id is required`);
    else if (seen.has(id)) report.errors.push(`${where}.id is duplicated: ${id}`);
    else seen.add(id);
    if (typeof entry.claim !== "string" || !entry.claim.trim()) {
      report.errors.push(`${where}.claim is required: name what was challenged`);
    }
    const status = typeof entry.status === "string" ? entry.status.trim() : "";
    if (!COUNTEREXAMPLE_STATUSES.some((allowed) => allowed === status)) {
      report.errors.push(`${where}.status must be one of ${COUNTEREXAMPLE_STATUSES.join(", ")}`);
      continue;
    }
    const reproducer = typeof entry.reproducer === "string" ? entry.reproducer.trim() : "";
    if (status === "unsubstantiated" && reproducer) {
      report.errors.push(`${where}: an unsubstantiated entry must not carry a reproducer`);
    }
    if (status !== "unsubstantiated" && !reproducer) {
      report.errors.push(`${where}: a ${status} entry needs a reproducer`);
    }
    const resolution = typeof entry.resolution === "string" ? entry.resolution.trim() : "";
    if (status === "resolved" && !resolution) {
      report.errors.push(`${where}: a resolved entry needs a resolution`);
    }
    if (status !== "resolved" && entry.resolution !== undefined) {
      report.errors.push(`${where}: only a resolved entry carries a resolution`);
    }
  }
}

export function verifyDocumentation(rootDirectory = process.cwd()): DocumentationReport {
  const root = resolve(rootDirectory);
  const report: DocumentationReport = {
    files: 0,
    errors: [],
    warnings: [],
    decisions: { implemented: 0, open: 0 },
  };
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
        `${display}: documentation content must live in design/, decisions/, experiments/, or postmortem/`,
      );
    }
    if (parts[0] === "docs" && parts[1] === "decisions" && lifecycle.has(parts[2])) {
      checkDecisionFile(path, text, display, parts[2], report);
    }
    if (parts[0] === "docs" && parts[1] === "design") {
      checkDesignHeader(path, text, report);
    }
    if (parts[0] === "docs" && parts[1] === "postmortem") {
      checkPostmortemFile(path, text, display, report);
    }
    const experimentName = parts[parts.length - 1];
    if (
      parts[0] === "docs" &&
      parts[1] === "experiments" &&
      parts.length >= 3 &&
      !new Set(["README.md", "README.zh-CN.md"]).has(experimentName) &&
      !/-\d{4}-\d{2}-\d{2}\.md$/.test(experimentName) &&
      !/-(results|notes)\.md$/.test(experimentName)
    ) {
      report.warnings.push(`${display}: experiment report filename should end in -YYYY-MM-DD.md`);
    }
  }
  checkPartsShelf(root, report);
  checkCounterexamples(root, report);
  checkPostmortems(root, report);
  for (const [rel, maxBytes] of Object.entries(BYTE_BUDGETS)) {
    const p = join(root, rel);
    if (!existsSync(p)) continue; // budget applies to present standing docs, not synthetic trees
    const size = statSync(p).size;
    if (size > maxBytes) {
      report.errors.push(
        `${rel}: ${size}B exceeds ${maxBytes}B byte budget (docs/README.md#ci-contract)`,
      );
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
  console.log(
    `decisions: ${report.decisions.implemented} implemented, ${report.decisions.open} with open items`,
  );
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const report = verifyDocumentation(process.cwd());
  printReport(report);
  if (report.errors.length > 0) process.exitCode = 1;
}
