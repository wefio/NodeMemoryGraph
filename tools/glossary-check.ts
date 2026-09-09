/**
 * Validate the repository terminology index (docs/glossary.yaml).
 *
 * The index is a pointer table: every term resolves to one heading in one
 * owning document. It exists so an Agent that cannot find a concept does not
 * conclude the concept is absent and build it again — see
 * docs/decisions/implemented/2026-09-08-repository-terminology-index.md.
 *
 * Fails closed on: unknown top-level or term fields, a missing owner file, an
 * anchor that is not a heading in the owner, two terms claiming the same
 * canonical name, an alias claimed twice or equal to another term's name, and a
 * `deprecated` term without a resolvable `successor`.
 *
 * `--resolve <name>` prints the owner and anchor for a term or alias, which is
 * the retrieval path: any spelling of a concept lands on the same home.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const GLOSSARY = "docs/glossary.yaml";
const STATUSES = new Set(["canonical", "proposed", "deprecated"]);
const TOP_FIELDS = new Set(["version", "conceptMap", "terms"]);
const TERM_FIELDS = new Set(["term", "aliases", "owner", "anchor", "status", "successor"]);

interface TermEntry {
  term: string;
  aliases: string[];
  owner: string;
  anchor: string;
  status: string;
  successor?: string;
}

export interface GlossaryReport {
  terms: number;
  errors: string[];
}

function readGlossary(directory: string): { text?: string; error?: string } {
  const path = resolve(directory, GLOSSARY);
  if (!existsSync(path)) return { error: `${GLOSSARY}: missing` };
  return { text: readFileSync(path, "utf8") };
}

function headings(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => /^#{1,6}\s+\S/u.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/u, "").trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label}: '${key}' must be a non-empty string`);
    return "";
  }
  return value.trim();
}

function checkOwner(
  owner: string,
  anchor: string,
  label: string,
  directory: string,
  errors: string[],
): void {
  if (!owner) return;
  const path = resolve(directory, owner);
  if (!existsSync(path) || !statSync(path).isFile()) {
    errors.push(`${label}: owner '${owner}' is not an existing file`);
    return;
  }
  if (anchor && !headings(readFileSync(path, "utf8")).some((h) => h.includes(anchor))) {
    errors.push(`${label}: anchor '${anchor}' is not a heading in ${owner}`);
  }
}

function parseAliases(raw: Record<string, unknown>, label: string, errors: string[]): string[] {
  if (!Array.isArray(raw.aliases)) {
    errors.push(`${label}: aliases must be an array of non-empty strings`);
    return [];
  }
  const aliases = raw.aliases.map((alias) => (typeof alias === "string" ? alias.trim() : ""));
  if (aliases.some((alias) => alias === "")) {
    errors.push(`${label}: aliases must be an array of non-empty strings`);
  }
  return aliases;
}

function checkSuccessor(
  status: string,
  successor: string | undefined,
  label: string,
  errors: string[],
): void {
  if (status === "deprecated" && !successor) {
    errors.push(`${label}: a deprecated term needs a 'successor'`);
  }
  if (successor !== undefined && status !== "deprecated") {
    errors.push(`${label}: 'successor' is only valid for a deprecated term`);
  }
}

function parseTerm(
  raw: unknown,
  index: number,
  directory: string,
  errors: string[],
): TermEntry | undefined {
  const label = `${GLOSSARY} terms[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${label}: must be a mapping`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!TERM_FIELDS.has(key)) errors.push(`${label}: unknown field '${key}'`);
  }
  const term = stringField(raw, "term", label, errors);
  const owner = stringField(raw, "owner", label, errors);
  const anchor = stringField(raw, "anchor", label, errors);
  const status = stringField(raw, "status", label, errors);
  if (status && !STATUSES.has(status)) {
    errors.push(`${label}: status must be one of ${[...STATUSES].join(", ")}`);
  }
  const aliases = parseAliases(raw, label, errors);
  const successor = typeof raw.successor === "string" ? raw.successor.trim() : undefined;
  checkSuccessor(status, successor, label, errors);
  checkOwner(owner, anchor, label, directory, errors);
  if (!term || !owner || !anchor || !status) return undefined;
  return { term, aliases, owner, anchor, status, successor };
}

function termEntries(parsed: unknown, directory: string, errors: string[]): TermEntry[] {
  if (!isRecord(parsed)) {
    errors.push(`${GLOSSARY}: top level must be a mapping`);
    return [];
  }
  for (const key of Object.keys(parsed)) {
    if (!TOP_FIELDS.has(key)) errors.push(`${GLOSSARY}: unknown top-level field '${key}'`);
  }
  if (parsed.version !== 1) errors.push(`${GLOSSARY}: version must be 1`);
  const conceptMap = stringField(parsed, "conceptMap", GLOSSARY, errors);
  if (conceptMap && !existsSync(resolve(directory, conceptMap))) {
    errors.push(`${GLOSSARY}: conceptMap '${conceptMap}' does not exist`);
  }
  if (!Array.isArray(parsed.terms) || parsed.terms.length === 0) {
    errors.push(`${GLOSSARY}: terms must be a non-empty array`);
    return [];
  }
  return parsed.terms.flatMap((raw, index): TermEntry[] => {
    const entry = parseTerm(raw, index, directory, errors);
    return entry ? [entry] : [];
  });
}

function checkUniqueness(entries: TermEntry[], errors: string[]): void {
  const names = new Map<string, string>();
  const claim = (name: string, owner: string, kind: string): void => {
    const key = name.toLowerCase();
    const existing = names.get(key);
    if (existing !== undefined) {
      errors.push(`${GLOSSARY}: '${name}' (${kind}) is already claimed by '${existing}'`);
      return;
    }
    names.set(key, owner);
  };
  for (const entry of entries) claim(entry.term, entry.term, "term");
  for (const entry of entries) {
    for (const alias of entry.aliases) claim(alias, entry.term, `alias of ${entry.term}`);
  }
}

function checkSuccessors(entries: TermEntry[], errors: string[]): void {
  const names = new Set(entries.map((entry) => entry.term.toLowerCase()));
  for (const entry of entries) {
    if (entry.successor && !names.has(entry.successor.toLowerCase())) {
      errors.push(
        `${GLOSSARY}: '${entry.term}' successor '${entry.successor}' is not a declared term`,
      );
    }
  }
}

export function checkGlossary(rootDirectory = process.cwd()): GlossaryReport {
  const directory = resolve(rootDirectory);
  const errors: string[] = [];
  const { text, error } = readGlossary(directory);
  if (error) return { terms: 0, errors: [error] };
  let parsed: unknown;
  try {
    parsed = parseYaml(text ?? "");
  } catch (cause) {
    return { terms: 0, errors: [`${GLOSSARY}: invalid YAML: ${(cause as Error).message}`] };
  }
  const entries = termEntries(parsed, directory, errors);
  checkUniqueness(entries, errors);
  checkSuccessors(entries, errors);
  return { terms: entries.length, errors };
}

export function resolveTerm(name: string, rootDirectory = process.cwd()): TermEntry | undefined {
  const directory = resolve(rootDirectory);
  const { text } = readGlossary(directory);
  if (text === undefined) return undefined;
  const entries = termEntries(parseYaml(text), directory, []);
  const key = name.trim().toLowerCase();
  return entries.find(
    (entry) =>
      entry.term.toLowerCase() === key ||
      entry.aliases.some((alias) => alias.toLowerCase() === key),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const nameIndex = process.argv.indexOf("--resolve");
  if (nameIndex !== -1) {
    const name = process.argv[nameIndex + 1] ?? "";
    const entry = resolveTerm(name);
    if (!entry) {
      process.stderr.write(`error: unknown term or alias '${name}'\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${entry.term}\t${entry.owner}\t${entry.anchor}\n`);
    }
  } else {
    const report = checkGlossary();
    for (const error of report.errors) process.stderr.write(`error: ${error}\n`);
    process.stdout.write(`glossary: ${report.terms} terms, ${report.errors.length} errors\n`);
    if (report.errors.length > 0) process.exitCode = 1;
  }
}
