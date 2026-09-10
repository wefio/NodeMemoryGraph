/**
 * Requirements traceability check over the authored RCP contracts.
 *
 * Every assertion must resolve to a runnable check (`node-test:<route>` or a
 * package.json script) or be explicitly marked `documentedOnly`. A check that
 * no assertion claims is reported as an orphan: the gate may run it, but no
 * design claim rests on it.
 *
 * The report says `bound`, never `verified`: a passing test is a witness at the
 * inputs it exercises, not a proof over the domain the assertion claims. Only an
 * assertion whose evidence is a decision procedure is counted as `proven`, and
 * every assertion has to name its domain (D) and the assumptions (A) it rests
 * on. `assumes` ids resolve to `docs/design/assumptions.yaml`; an id that
 * resolves nowhere is invented inline.
 *
 * This is the `rtm:check` of
 * docs/decisions/implemented/2026-09-08-requirements-traceability-matrix.md, as
 * extended by docs/decisions/implemented/2026-09-09-assertion-domain-and-strength.md.
 * It fails closed on an unresolvable check, an unresolvable assumption, and a
 * contract that does not compile; the coverage line is captured as the check's
 * evidence and therefore lands in the digest-bound receipt.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { compileContractFile } from "../src/rcp/contract.ts";
import { readRouteDeclarations } from "../src/rcp/planner.ts";
import { resolveRouteTestFiles } from "../src/rcp/providers.ts";
import type {
  ContractAssertion,
  RepositoryContractIr,
  RouteDeclaration,
} from "../src/rcp/types.ts";

const NODE_TEST_PREFIX = "node-test:";
const ASSUMPTIONS_PATH = "docs/design/assumptions.yaml";

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
    const names = namesFor(route);
    // A route that resolves to no file at all proves nothing, named or not.
    if (names.size === 0) return false;
    return hash === -1 ? true : names.has(rest.slice(hash + 1));
  };
}

export interface RtmReport {
  contracts: number;
  assertions: number;
  bound: number;
  proven: number;
  witness: number;
  documentedOnly: number;
  assumptions: number;
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

/** Ids declared by the assumption register, or `undefined` when it is absent. */
function registeredAssumptions(root: string): Set<string> | undefined {
  const path = join(root, ASSUMPTIONS_PATH);
  if (!existsSync(path)) return undefined;
  const parsed = parseYaml(readFileSync(path, "utf8")) as
    { assumptions?: { id?: unknown }[] } | undefined;
  const ids = new Set<string>();
  for (const entry of parsed?.assumptions ?? []) {
    if (typeof entry?.id === "string") ids.add(entry.id);
  }
  return ids;
}

interface AssertionScan {
  report: RtmReport;
  resolvable: (check: string) => boolean;
  registered: Set<string> | undefined;
  declared: Set<string>;
  referenced: Set<string>;
  unresolved: Set<string>;
}

function scanAssertion(
  contractId: string,
  assertion: ContractAssertion,
  scan: AssertionScan,
): void {
  const { report } = scan;
  report.assertions += 1;
  for (const id of assertion.assumes ?? []) {
    if (scan.registered && !scan.registered.has(id)) scan.unresolved.add(id);
  }
  if (assertion.documentedOnly) {
    report.documentedOnly += 1;
    return;
  }
  const check = assertion.check ?? "";
  scan.referenced.add(check);
  if (!scan.resolvable(check)) {
    report.uncovered.push(`${contractId}:${assertion.id} -> ${check}`);
    return;
  }
  report.bound += 1;
  if (assertion.strength === "decision") report.proven += 1;
  else report.witness += 1;
}

function scanContract(contract: RepositoryContractIr, scan: AssertionScan): void {
  for (const check of contract.verification.checks) scan.declared.add(check);
  for (const assertion of contract.assertions) scanAssertion(contract.id, assertion, scan);
}

export function checkRtm(rootDirectory = process.cwd()): RtmReport {
  const root = resolve(rootDirectory);
  const report: RtmReport = {
    contracts: 0,
    assertions: 0,
    bound: 0,
    proven: 0,
    witness: 0,
    documentedOnly: 0,
    assumptions: 0,
    uncovered: [],
    orphans: [],
    errors: [],
  };
  const directory = join(root, ".rcp", "contracts");
  if (!existsSync(directory)) {
    report.errors.push(".rcp/contracts: missing");
    return report;
  }
  const registered = registeredAssumptions(root);
  if (registered === undefined) report.errors.push(`${ASSUMPTIONS_PATH}: missing`);
  report.assumptions = registered?.size ?? 0;
  const scripts = scriptsOf(root);
  let routes: RouteDeclaration[] = [];
  try {
    routes = readRouteDeclarations(root);
  } catch (cause) {
    report.errors.push(`agent-context.yaml: ${(cause as Error).message}`);
  }
  const scan: AssertionScan = {
    report,
    resolvable: createResolver(root, routes, scripts),
    registered,
    declared: new Set(),
    referenced: new Set(),
    unresolved: new Set(),
  };
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
    report.contracts += 1;
    scanContract(result.contract, scan);
  }
  for (const id of [...scan.unresolved].sort()) {
    report.errors.push(
      `${ASSUMPTIONS_PATH}: '${id}' is assumed by an assertion but not registered there`,
    );
  }
  report.orphans = [...scan.declared].filter((check) => !scan.referenced.has(check)).sort();
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkRtm();
  for (const error of report.errors) process.stderr.write(`error: ${error}\n`);
  for (const uncovered of report.uncovered) {
    process.stderr.write(`error: assertion has no resolvable check: ${uncovered}\n`);
  }
  if (report.orphans.length > 0) {
    process.stdout.write(`note: checks claimed by no assertion: ${report.orphans.join(", ")}\n`);
  }
  process.stdout.write(
    `rtm: ${report.contracts} contracts, ${report.assertions} assertions, ${report.bound} bound ` +
      `(${report.proven} proven / decision, ${report.witness} witness), ` +
      `${report.documentedOnly} documented-only, ${report.uncovered.length} uncovered, ` +
      `${report.orphans.length} orphan checks\n`,
  );
  process.stdout.write(
    `rtm assumptions: ${report.assumptions} registered, ` +
      `${report.errors.filter((entry) => entry.includes("assumed by an assertion")).length} unresolved\n`,
  );
  if (report.errors.length > 0 || report.uncovered.length > 0) process.exitCode = 1;
}
