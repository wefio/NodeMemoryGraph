/**
 * One resolver for the legacy pointer index and colocated YAML definitions.
 * Corpus and schema: docs/design/documentation-governance.md.
 * A bounded miss is not evidence that a concept does not exist elsewhere.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

import { documentHeadingTitles } from "../scripts/document-hygiene.ts";

const GLOSSARY = "docs/glossary.yaml";
const DEFINITION_ROOT = "docs/design";
const STATUSES = new Set(["canonical", "proposed", "deprecated"]);
const TOP_FIELDS = new Set(["version", "conceptMap", "terms"]);
const TERM_FIELDS = new Set(["term", "aliases", "owner", "anchor", "status", "successor"]);
const DEFINITION_TOP_FIELDS = new Set(["version", "namespace", "terms", "references"]);
const DEFINITION_FIELDS = new Set([...TERM_FIELDS, "id", "definition"]);
const CONCEPT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const NAMESPACE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const REFERENCE_FIELDS = new Set(["term", "namespace"]);

interface TermEntry {
  term: string;
  aliases: string[];
  owner: string;
  anchor: string;
  status: string;
  successor?: string;
  id?: string;
  namespace?: string;
  definition?: string;
  source: string;
}

export interface TermQueryOptions {
  within?: string;
  namespace?: string;
}

export interface GlossaryReport {
  terms: number;
  scope: string;
  sources: string[];
  errors: string[];
}

export interface TermQueryReport {
  scope: string;
  sources: string[];
  errors: string[];
  matches: TermEntry[];
}

interface Catalog extends GlossaryReport {
  entries: TermEntry[];
}

interface TermReference {
  term: string;
  namespace?: string;
  source: string;
}

function isInside(directory: string, path: string): boolean {
  const suffix = relative(directory, path);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function definitionFiles(root: string, directory: string, errors: string[]): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "archived") continue;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${relative(root, path)}: symbolic links are outside the registered corpus`);
    } else if (entry.isDirectory()) {
      files.push(...definitionFiles(root, path, errors));
    } else if (entry.isFile() && entry.name.endsWith(".terms.yaml")) {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

function sourceFiles(root: string, scope: string, errors: string[]): string[] {
  const selected = resolve(root, scope);
  const docs = resolve(root, "docs");
  if (isAbsolute(scope) || !isInside(docs, selected)) {
    errors.push(`scope '${scope}' is outside the repository's registered docs corpus`);
    return [];
  }
  if (!existsSync(selected) || !statSync(selected).isDirectory()) {
    errors.push(`scope '${scope}' is not an existing directory`);
    return [];
  }
  const actual = realpathSync(selected);
  if (!isInside(root, actual)) {
    errors.push(`scope '${scope}' resolves outside the repository`);
    return [];
  }
  if (relative(selected, actual) !== "") {
    errors.push(`scope '${scope}' is a symbolic path outside the registered corpus`);
    return [];
  }
  if (relative(docs, selected).split(/[\\/]/).includes("archived")) {
    errors.push(`scope '${scope}': no registered sources in archived directories`);
    return [];
  }
  const legacy = resolve(root, GLOSSARY);
  const files = isInside(selected, legacy) && existsSync(legacy) ? [GLOSSARY] : [];
  const definitions = resolve(root, DEFINITION_ROOT);
  const start = isInside(selected, definitions) ? definitions : selected;
  if (isInside(definitions, start)) files.push(...definitionFiles(root, start, errors));
  if (files.length === 0) errors.push(`scope '${scope}': no registered sources`);
  return files;
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

function checkOwner(entry: TermEntry, label: string, root: string, errors: string[]): void {
  const path = resolve(root, entry.owner);
  if (entry.namespace !== undefined && isAbsolute(entry.owner)) {
    errors.push(`${label}: contract owner must be repository-relative`);
    return;
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    errors.push(`${label}: owner '${entry.owner}' is not an existing file`);
    return;
  }
  if (entry.namespace !== undefined && !isInside(root, realpathSync(path))) {
    errors.push(`${label}: contract owner resolves outside the repository`);
    return;
  }
  const headings = documentHeadingTitles(readFileSync(path, "utf8"));
  const matches =
    entry.namespace !== undefined
      ? headings.includes(entry.anchor)
      : headings.some((heading) => heading.includes(entry.anchor));
  if (!matches)
    errors.push(`${label}: anchor '${entry.anchor}' is not a heading in ${entry.owner}`);
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

function checkSuccessor(entry: TermEntry, label: string, errors: string[]): void {
  if (entry.status === "deprecated" && !entry.successor) {
    errors.push(`${label}: a deprecated term needs a 'successor'`);
  }
  if (entry.successor !== undefined && entry.status !== "deprecated") {
    errors.push(`${label}: 'successor' is only valid for a deprecated term`);
  }
}

function definitionMetadata(
  entry: TermEntry,
  raw: Record<string, unknown>,
  namespace: string | undefined,
  label: string,
  errors: string[],
): void {
  if (namespace === undefined) return;
  entry.namespace = namespace;
  entry.definition = stringField(raw, "definition", label, errors);
  if (raw.id === undefined) return;
  entry.id = stringField(raw, "id", label, errors);
  if (!CONCEPT_NAME.test(entry.id) || !entry.id.startsWith(`${namespace}.`)) {
    errors.push(`${label}: ID '${entry.id}' must belong to namespace '${namespace}'`);
  }
}

function parseTerm(
  raw: unknown,
  index: number,
  root: string,
  source: string,
  namespace: string | undefined,
  errors: string[],
): TermEntry | undefined {
  const label = `${source} terms[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${label}: must be a mapping`);
    return undefined;
  }
  const fields = namespace === undefined ? TERM_FIELDS : DEFINITION_FIELDS;
  for (const key of Object.keys(raw)) {
    if (!fields.has(key)) errors.push(`${label}: unknown field '${key}'`);
  }
  const term = stringField(raw, "term", label, errors);
  const owner = stringField(raw, "owner", label, errors);
  const anchor = stringField(raw, "anchor", label, errors);
  const status = stringField(raw, "status", label, errors);
  if (status && !STATUSES.has(status))
    errors.push(`${label}: status must be one of ${[...STATUSES].join(", ")}`);
  const entry: TermEntry = {
    term,
    owner,
    anchor,
    status,
    aliases: parseAliases(raw, label, errors),
    source,
  };
  if (raw.successor !== undefined) entry.successor = stringField(raw, "successor", label, errors);
  definitionMetadata(entry, raw, namespace, label, errors);
  checkSuccessor(entry, label, errors);
  if (owner && anchor) checkOwner(entry, label, root, errors);
  return term && owner && anchor && status ? entry : undefined;
}

function sourceMetadata(
  parsed: Record<string, unknown>,
  root: string,
  source: string,
  errors: string[],
): string | undefined {
  const legacy = source === GLOSSARY;
  const fields = legacy ? TOP_FIELDS : DEFINITION_TOP_FIELDS;
  for (const key of Object.keys(parsed)) {
    if (!fields.has(key)) errors.push(`${source}: unknown top-level field '${key}'`);
  }
  if (parsed.version !== (legacy ? 1 : 2))
    errors.push(`${source}: version must be ${legacy ? 1 : 2}`);
  if (legacy) {
    const map = stringField(parsed, "conceptMap", source, errors);
    if (map && !existsSync(resolve(root, map)))
      errors.push(`${source}: conceptMap '${map}' does not exist`);
    return undefined;
  }
  const namespace =
    parsed.namespace === undefined
      ? "repository"
      : stringField(parsed, "namespace", source, errors);
  if (!NAMESPACE.test(namespace)) errors.push(`${source}: malformed namespace '${namespace}'`);
  return namespace;
}

function parseReference(raw: unknown, source: string, errors: string[]): TermReference | undefined {
  const value = typeof raw === "string" ? { term: raw } : raw;
  const label = `${source}: term reference`;
  if (!isRecord(value)) {
    errors.push(`${label} must be a canonical word or a term/namespace mapping`);
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!REFERENCE_FIELDS.has(field)) errors.push(`${label}: unknown field '${field}'`);
  }
  const term = stringField(value, "term", label, errors);
  const namespace =
    value.namespace === undefined ? undefined : stringField(value, "namespace", label, errors);
  if (namespace !== undefined && !NAMESPACE.test(namespace)) {
    errors.push(`${label}: malformed namespace '${namespace}'`);
  }
  return term ? { term, namespace, source } : undefined;
}

function sourceReferences(
  parsed: Record<string, unknown>,
  source: string,
  errors: string[],
): TermReference[] {
  if (source === GLOSSARY || parsed.references === undefined) return [];
  if (!Array.isArray(parsed.references)) {
    errors.push(`${source}: references must be an array of canonical terms`);
    return [];
  }
  return parsed.references.flatMap((raw) => {
    const reference = parseReference(raw, source, errors);
    return reference ? [reference] : [];
  });
}

function sourceEntries(
  root: string,
  source: string,
  errors: string[],
  references: TermReference[],
): TermEntry[] {
  const path = resolve(root, source);
  if (!existsSync(path)) {
    errors.push(`${source}: missing`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    errors.push(`${source}: invalid YAML: ${(cause as Error).message}`);
    return [];
  }
  if (!isRecord(parsed)) {
    errors.push(`${source}: top level must be a mapping`);
    return [];
  }
  const namespace = sourceMetadata(parsed, root, source, errors);
  references.push(...sourceReferences(parsed, source, errors));
  const explicitUsage = namespace !== undefined && Array.isArray(parsed.references);
  if (!Array.isArray(parsed.terms) || (parsed.terms.length === 0 && !explicitUsage)) {
    errors.push(`${source}: terms must be a non-empty array unless references is explicit`);
    return [];
  }
  return parsed.terms.flatMap((raw, index) => {
    const entry = parseTerm(raw, index, root, source, namespace, errors);
    return entry ? [entry] : [];
  });
}

function checkUniqueness(entries: TermEntry[], errors: string[]): void {
  const ids = new Map<string, TermEntry>();
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.id) continue;
    if (ids.has(entry.id)) errors.push(`${entry.source}: duplicate ID '${entry.id}'`);
    ids.set(entry.id, entry);
  }
  for (const entry of entries) {
    const namespace = entry.namespace ?? "repository";
    for (const name of [entry.term, ...entry.aliases]) {
      const key = `${namespace}:${name.toLowerCase()}`;
      const existing = names.get(key);
      if (existing !== undefined)
        errors.push(
          `${entry.source}: '${name}' is already claimed by '${existing}' in namespace '${namespace}'`,
        );
      names.set(key, entry.term);
      const idOwner = ids.get(name.toLowerCase());
      if (idOwner && idOwner !== entry)
        errors.push(`${entry.source}: '${name}' shadows registered ID '${idOwner.id}'`);
    }
  }
}

function checkSuccessors(entries: TermEntry[], errors: string[]): void {
  for (const entry of entries) {
    if (!entry.successor) continue;
    const key = entry.successor.toLowerCase();
    const exists = entries.some(
      (candidate) =>
        candidate.id === entry.successor ||
        (candidate.term.toLowerCase() === key &&
          (candidate.namespace ?? "repository") === (entry.namespace ?? "repository")),
    );
    if (!exists)
      errors.push(
        `${entry.source}: '${entry.term}' successor '${entry.successor}' is not a declared term in the selected corpus`,
      );
  }
}

function checkReferences(
  entries: TermEntry[],
  references: TermReference[],
  errors: string[],
): void {
  const seen = new Map<string, Set<TermEntry>>();
  for (const reference of references) {
    const matches = entries.filter(
      (entry) =>
        entry.term.toLowerCase() === reference.term.toLowerCase() &&
        (reference.namespace === undefined ||
          (entry.namespace ?? "repository") === reference.namespace),
    );
    if (matches.length !== 1) {
      const reason = matches.length
        ? `ambiguous reference '${reference.term}': ${matches.map((entry) => entry.namespace ?? "repository").join(", ")}; qualify the namespace`
        : `reference '${reference.term}' is not registered in the selected corpus; widen the scope`;
      errors.push(`${reference.source}: ${reason}`);
      continue;
    }
    const used = seen.get(reference.source) ?? new Set<TermEntry>();
    if (used.has(matches[0]))
      errors.push(`${reference.source}: duplicate term reference '${reference.term}'`);
    used.add(matches[0]);
    seen.set(reference.source, used);
  }
}

function loadCatalog(rootDirectory: string, within = "docs"): Catalog {
  const root = resolve(rootDirectory);
  const errors: string[] = [];
  const sources = sourceFiles(root, within, errors);
  const references: TermReference[] = [];
  const entries = sources.flatMap((source) => sourceEntries(root, source, errors, references));
  checkUniqueness(entries, errors);
  checkSuccessors(entries, errors);
  checkReferences(entries, references, errors);
  if (sources.length > 0 && entries.length === 0 && references.length === 0) {
    errors.push(`scope '${within}': no registered definitions or term references`);
  }
  return { terms: entries.length, scope: within, sources, entries, errors };
}

export function checkGlossary(
  rootDirectory = process.cwd(),
  options: Pick<TermQueryOptions, "within"> = {},
): GlossaryReport {
  const { entries, ...report } = loadCatalog(rootDirectory, options.within);
  void entries;
  return report;
}

export function queryTerms(
  name: string,
  rootDirectory = process.cwd(),
  options: TermQueryOptions = {},
): TermQueryReport {
  const catalog = loadCatalog(rootDirectory, options.within);
  if (options.namespace !== undefined && options.namespace.trim() === "") {
    catalog.errors.push("query namespace must be non-empty");
  }
  const key = name.trim().toLowerCase();
  const matches = catalog.errors.length
    ? []
    : catalog.entries.filter((entry) => {
        if (options.namespace && (entry.namespace ?? "repository") !== options.namespace)
          return false;
        return (
          entry.id === key ||
          entry.term.toLowerCase() === key ||
          entry.aliases.some((alias) => alias.toLowerCase() === key)
        );
      });
  return { scope: catalog.scope, sources: catalog.sources, errors: catalog.errors, matches };
}

export function resolveTerm(name: string, rootDirectory = process.cwd()): TermEntry | undefined {
  const report = queryTerms(name, rootDirectory);
  return report.matches.length === 1 ? report.matches[0] : undefined;
}

function runCli(): void {
  const { values } = parseArgs({
    options: {
      resolve: { type: "string" },
      within: { type: "string" },
      namespace: { type: "string" },
    },
  });
  if (values.namespace !== undefined && values.resolve === undefined)
    throw new Error("--namespace requires --resolve");
  if (values.resolve === undefined) {
    const report = checkGlossary(process.cwd(), values);
    for (const error of report.errors) process.stderr.write(`error: ${error}\n`);
    process.stdout.write(`glossary: ${report.terms} terms, ${report.errors.length} errors\n`);
    process.stdout.write(
      `searched corpus: ${report.scope}; sources: ${report.sources.join(", ")}\n`,
    );
    if (report.errors.length) process.exitCode = 1;
    return;
  }
  const report = queryTerms(values.resolve, process.cwd(), values);
  if (report.errors.length) {
    for (const error of report.errors) process.stderr.write(`error: ${error}\n`);
    process.exitCode = 1;
  } else if (report.matches.length !== 1) {
    const reason = report.matches.length
      ? `ambiguous: ${report.matches.map((entry) => `${entry.namespace ?? "repository"}:${entry.id ?? entry.term}`).join(", ")}`
      : "not found in selected corpus";
    process.stderr.write(
      `error: ${reason}; within=${report.scope}; namespace=${values.namespace ?? "all"}; sources=${report.sources.join(", ")}\n`,
    );
    process.exitCode = 1;
  } else {
    const entry = report.matches[0];
    process.stdout.write(`${entry.term}\t${entry.owner}\t${entry.anchor}\n`);
    if (entry.id) process.stdout.write(`ID: ${entry.id}\n`);
    if (entry.definition !== undefined)
      process.stdout.write(
        `Namespace: ${entry.namespace}\nStatus: ${entry.status}\nDefinition: ${entry.definition}\nSource: ${entry.source}\n`,
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (cause) {
    process.stderr.write(`error: ${(cause as Error).message}\n`);
    process.exitCode = 1;
  }
}
