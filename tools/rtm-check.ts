/**
 * Requirements traceability check over the authored RCP contracts.
 *
 * Every assertion must resolve to a runnable check (`node-test:<route>` or a
 * package.json script) or be explicitly marked `documentedOnly`. A check that
 * no assertion claims is reported as an orphan: the gate may run it, but no
 * design claim rests on it.
 *
 * This is the `rtm:check` of
 * docs/decisions/implemented/2026-09-08-requirements-traceability-matrix.md. It
 * fails closed on an unresolvable check and on a contract that does not
 * compile; the coverage line is captured as the check's evidence and therefore
 * lands in the digest-bound receipt.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileContractFile } from "../src/rcp/contract.ts";
import { readRouteDeclarations } from "../src/rcp/planner.ts";
import { resolveRouteTestFiles } from "../src/rcp/providers.ts";
import type { RouteDeclaration } from "../src/rcp/types.ts";

const NODE_TEST_PREFIX = "node-test:";

/** `node-test:<route>` claims route-level evidence; `node-test:<route>#<name>`
 *  claims one named test, which is what makes a claim traceable to a case
 *  instead of to a whole suite. */
const TEST_DECLARATION = /^\s*test\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/gmu;

function testNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(TEST_DECLARATION)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.push(name);
  }
  return names;
}

function createResolver(
  root: string,
  routes: RouteDeclaration[],
  scripts: string[],
): (check: string) => boolean {
  const cache = new Map<string, Set<string>>();
  const namesFor = (route: RouteDeclaration): Set<string> => {
    const cached = cache.get(route.id);
    if (cached) return cached;
    const names = new Set<string>();
    for (const file of resolveRouteTestFiles(root, route.tests)) {
      for (const name of testNamesIn(readFileSync(join(root, file), "utf8"))) names.add(name);
    }
    cache.set(route.id, names);
    return names;
  };
  return (check: string): boolean => {
    if (!check.startsWith(NODE_TEST_PREFIX)) return scripts.includes(check);
    const rest = check.slice(NODE_TEST_PREFIX.length);
    const hash = rest.indexOf("#");
    const route = routes.find((entry) => entry.id === (hash === -1 ? rest : rest.slice(0, hash)));
    if (!route) return false;
    return hash === -1 ? true : namesFor(route).has(rest.slice(hash + 1));
  };
}

export interface RtmReport {
  contracts: number;
  assertions: number;
  verified: number;
  documentedOnly: number;
  uncovered: string[];
  orphans: string[];
  errors: string[];
}

function scriptsOf(root: string): string[] {
  const path = join(root, "package.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
  return Object.keys(parsed.scripts ?? {});
}

export function checkRtm(rootDirectory = process.cwd()): RtmReport {
  const root = resolve(rootDirectory);
  const report: RtmReport = {
    contracts: 0,
    assertions: 0,
    verified: 0,
    documentedOnly: 0,
    uncovered: [],
    orphans: [],
    errors: [],
  };
  const directory = join(root, ".rcp", "contracts");
  if (!existsSync(directory)) {
    report.errors.push(".rcp/contracts: missing");
    return report;
  }
  const scripts = scriptsOf(root);
  let routes: RouteDeclaration[] = [];
  try {
    routes = readRouteDeclarations(root);
  } catch (cause) {
    report.errors.push(`agent-context.yaml: ${(cause as Error).message}`);
  }
  const resolvable = createResolver(root, routes, scripts);
  const declared = new Set<string>();
  const referenced = new Set<string>();
  const files = readdirSync(directory)
    .filter((file) => /\.ya?ml$/u.test(file))
    .sort();
  for (const name of files) {
    const result = compileContractFile(join(directory, name));
    if (!result.ok || !result.contract) {
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity === "error") report.errors.push(`${name}: ${diagnostic.message}`);
      }
      continue;
    }
    const contract = result.contract;
    report.contracts += 1;
    for (const check of contract.verification.checks) declared.add(check);
    for (const assertion of contract.assertions) {
      report.assertions += 1;
      if (assertion.documentedOnly) {
        report.documentedOnly += 1;
        continue;
      }
      const check = assertion.check ?? "";
      referenced.add(check);
      if (resolvable(check)) report.verified += 1;
      else report.uncovered.push(`${contract.id}:${assertion.id} -> ${check}`);
    }
  }
  report.orphans = [...declared].filter((check) => !referenced.has(check)).sort();
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkRtm();
  for (const error of report.errors) console.error(`error: ${error}`);
  for (const uncovered of report.uncovered) {
    console.error(`error: assertion has no resolvable check: ${uncovered}`);
  }
  if (report.orphans.length > 0) {
    console.log(`note: checks claimed by no assertion: ${report.orphans.join(", ")}`);
  }
  console.log(
    `rtm: ${report.contracts} contracts, ${report.assertions} assertions, ${report.verified} verified, ` +
      `${report.documentedOnly} documented-only, ${report.uncovered.length} uncovered, ` +
      `${report.orphans.length} orphan checks`,
  );
  if (report.errors.length > 0 || report.uncovered.length > 0) process.exitCode = 1;
}
