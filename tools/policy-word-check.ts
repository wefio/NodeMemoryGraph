import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { CLASSIFICATIONS, MECHANISM_PATHS, POLICY_WORDS } from "./policy-word-list.ts";
import type { ClassifiedSite } from "./policy-word-list.ts";

export interface PolicyWordHit {
  path: string;
  scope: string;
  word: string;
  line: number;
}

/** Match snake/kebab/camel names as words, not `patch` inside `dispatch`. */
export function policyWordsIn(text: string, words: readonly string[]): string[] {
  const separated = text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase();
  return words.flatMap((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const spelling = escaped.split("-").join("[\\s_-]+");
    const pattern = new RegExp(`(?<![a-z0-9])${spelling}(?![a-z0-9])`, "gu");
    return [...separated.matchAll(pattern)].map(() => word);
  });
}

function scopeName(node: ts.Node): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
    return node.name?.getText();
  return undefined;
}

function literalText(node: ts.Node): string | undefined {
  if (
    ts.isIdentifier(node) ||
    ts.isPrivateIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  )
    return node.text;
  return undefined;
}

/** Comments are not code; SQL and runtime text inside literals are inspected. */
export function collectPolicyWords(
  path: string,
  text: string,
  words = POLICY_WORDS,
): PolicyWordHit[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  // Parse failures must not become an empty (passing) inventory.
  const diagnostics: readonly ts.Diagnostic[] = (
    source as ts.SourceFile & {
      parseDiagnostics: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  if (diagnostics.length) throw new Error(`${path}: cannot inspect invalid TypeScript`);
  const hits: PolicyWordHit[] = [];
  function visit(node: ts.Node, parents: readonly string[]): void {
    const name = scopeName(node);
    const scopes = name ? [...parents, name] : parents;
    const value = literalText(node);
    if (value !== undefined) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      for (const word of policyWordsIn(value, words)) {
        hits.push({ path, scope: scopes.join(".") || "<module>", word, line });
      }
    }
    ts.forEachChild(node, (child) => visit(child, scopes));
  }
  visit(source, []);
  return hits;
}

function siteKey(site: Pick<PolicyWordHit, "path" | "scope" | "word">): string {
  return `${site.path}#${site.scope}:${site.word}`;
}

function validClassification(site: ClassifiedSite): boolean {
  return (
    !!site.reason.trim() &&
    ["mechanism", "policy", "undecided"].includes(site.classification) &&
    Number.isInteger(site.count) &&
    site.count > 0
  );
}

export function comparePolicyWords(
  hits: readonly PolicyWordHit[],
  sites: readonly ClassifiedSite[],
): string[] {
  const actual = new Map<string, PolicyWordHit[]>();
  for (const hit of hits) {
    const key = siteKey(hit);
    const group = actual.get(key) ?? [];
    group.push(hit);
    actual.set(key, group);
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const key = siteKey(site);
    if (seen.has(key)) errors.push(`${key}: duplicate classification`);
    seen.add(key);
    if (!validClassification(site)) errors.push(`${key}: invalid classification`);
    const group = actual.get(key) ?? [];
    if (group.length !== site.count) {
      errors.push(
        `${key}: classified ${site.count}, found ${group.length} (lines ${group.map((hit) => hit.line).join(", ") || "none"})`,
      );
    }
    actual.delete(key);
  }
  for (const [key, group] of actual)
    errors.push(
      `${key}: unclassified (${group.length} at lines ${group.map((hit) => hit.line).join(", ")})`,
    );
  return errors;
}

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((name) => {
      const child = resolve(path, name);
      return statSync(child).isDirectory() || child.endsWith(".ts") ? sourceFiles(child) : [];
    });
}

export function inspectMechanism(directory: string): {
  hits: PolicyWordHit[];
  files: number;
  errors: string[];
} {
  const files = MECHANISM_PATHS.flatMap((path) => sourceFiles(resolve(directory, path)));
  const hits = files.flatMap((path) =>
    collectPolicyWords(relative(directory, path).replaceAll("\\", "/"), readFileSync(path, "utf8")),
  );
  const errors = CLASSIFICATIONS.filter((site) => !POLICY_WORDS.includes(site.word)).map(
    (site) => `${siteKey(site)}: word outside the maintained list`,
  );
  errors.push(...comparePolicyWords(hits, CLASSIFICATIONS));
  return { hits, files: files.length, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectMechanism(process.cwd());
  console.log(
    `policy words: ${report.hits.length} occurrences in ${report.files} files, ${report.errors.length} errors`,
  );
  for (const error of report.errors) console.error(error);
  if (process.argv.includes("--list")) {
    for (const site of CLASSIFICATIONS) {
      const lines = report.hits
        .filter((hit) => siteKey(hit) === siteKey(site))
        .map((hit) => hit.line);
      console.log(
        `${siteKey(site)} ${site.classification} count=${site.count} lines=${lines.join(",")}: ${site.reason}`,
      );
    }
  }
  if (report.errors.length) process.exitCode = 1;
}
