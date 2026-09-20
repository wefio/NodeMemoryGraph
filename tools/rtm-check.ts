/**
 * Requirements traceability check over the authored RCP contracts, reported as evidence.
 *
 * Every assertion must resolve to a runnable check (`node-test:<route>` or a
 * package.json script) or be explicitly marked `documentedOnly`. A check that
 * no assertion claims is reported as an orphan: the gate may run it, but no
 * design claim rests on it.
 *
 * Binding is not evidence of anything. Resolving a check id says the check exists; it does not say the
 * check ran, nor that it ran over the tree in front of us. This report therefore keeps the inventory
 * separate from the standing of each assertion: `bound` is a count, and the standing of an assertion
 * comes from the execution evidence recorded by `agent:verify` - current, at the same revision, with the
 * command that carries it passed. An assertion whose evidence is from another revision is reported as
 * historical and is not counted as executed; one with no record at all is reported as not recorded, which
 * is a gap in the evidence and not a rejection of the claim.
 *
 * The report refuses to aggregate its way to a conclusion: it lists the assertions, and it judges each
 * risk class (strength, kind, stage) and each contract whose scope spans several routes on its own
 * evidence. Counts are inventory; the standing of each item is what is claimed, and no total is.
 *
 * This is the `rtm:check` of
 * docs/decisions/implemented/2026-09-08-requirements-traceability-matrix.md, as
 * extended by docs/decisions/implemented/2026-09-09-assertion-domain-and-strength.md
 * and docs/decisions/implemented/2026-09-20-rtm-evidence-aggregation.md.
 * It fails closed on an unresolvable check, an unresolvable assumption, a
 * contract that does not compile, and current execution evidence in which the
 * command carrying an assertion failed; the printed report is captured as the
 * check's evidence and therefore lands in the digest-bound receipt.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { compileContractFile } from "../src/rcp/contract.ts";
import { readRouteDeclarations, selectRoutes } from "../src/rcp/planner.ts";
import { resolveRouteTestFiles } from "../src/rcp/providers.ts";
import type {
  ContractAssertion,
  RepositoryContractIr,
  RouteDeclaration,
} from "../src/rcp/types.ts";

const NODE_TEST_PREFIX = "node-test:";
const ASSUMPTIONS_PATH = "docs/design/assumptions.yaml";
/** What `agent:verify` writes at the end of a run: the commands it ran, with their status. */
const EVIDENCE_PATH = ".nmg/verification/latest.json";

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

/** One command's recorded run, as the verification evidence kept it. */
interface CommandRun {
  status: string;
  reason?: string;
}

/** What the last `agent:verify` run actually executed, and over which revision. */
interface ExecutionEvidence {
  head: string;
  at: string;
  dirty: number;
  commands: Map<string, CommandRun>;
}

interface EvidenceFile {
  finishedAt?: string;
  report?: { git?: { head?: string; dirtyFiles?: unknown } };
  result?: { results?: { command?: string; status?: string; reason?: string }[] };
}

function commandsFrom(
  results: readonly { command?: string; status?: string; reason?: string }[],
): Map<string, CommandRun> {
  const commands = new Map<string, CommandRun>();
  for (const run of results) {
    if (typeof run.command !== "string") continue;
    commands.set(run.command, {
      status: run.status ?? "unknown",
      ...(run.reason ? { reason: run.reason } : {}),
    });
  }
  return commands;
}

/** Absent or unreadable evidence is absence of evidence, never a verdict: a fresh clone has no run
 *  recorded, and that says nothing about the claims. */
function readExecutionEvidence(root: string): ExecutionEvidence | undefined {
  const path = join(root, EVIDENCE_PATH);
  if (!existsSync(path)) return undefined;
  let parsed: EvidenceFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as EvidenceFile;
  } catch {
    return undefined;
  }
  const dirty = parsed.report?.git?.dirtyFiles;
  return {
    head: parsed.report?.git?.head ?? "unknown",
    at: parsed.finishedAt ?? "unknown",
    dirty: Array.isArray(dirty) ? dirty.length : 0,
    commands: commandsFrom(parsed.result?.results ?? []),
  };
}

function currentHead(root: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** A gate entry is written as the command a person would type; the evidence records the script. */
function scriptNameOf(entry: string): string {
  const match = /^npm run ([^\s]+)$/u.exec(entry.trim());
  return match?.[1] ?? entry.trim();
}

/** Which commands carry an assertion, and which route it belongs to when it names one. */
function commandsFor(
  check: string,
  routesById: Map<string, RouteDeclaration>,
): { commands: string[]; route?: string } {
  if (!check.startsWith(NODE_TEST_PREFIX)) return { commands: [scriptNameOf(check)] };
  const rest = check.slice(NODE_TEST_PREFIX.length);
  const hash = rest.indexOf("#");
  const routeId = hash === -1 ? rest : rest.slice(0, hash);
  const route = routesById.get(routeId);
  return {
    commands: (route?.verify.blocking ?? []).map(scriptNameOf),
    route: routeId,
  };
}

/** How one assertion stands, decided by its own evidence and never by a count. */
export type AssertionStanding =
  "executed" | "historical" | "not-recorded" | "not-run" | "documented-only" | "uncovered";

export interface RtmAssertionEvidence {
  contract: string;
  id: string;
  /** Strength, kind and stage as one class: the report judges each class separately. */
  riskClass: string;
  check: string;
  standing: AssertionStanding;
  /** What decided the standing: one line per command, or why there is nothing to read. */
  evidence: readonly string[];
  /** Commands whose recorded status in the last run was a failure. That is the only thing here that
   *  fails the gate: a command that was skipped says the assertion was not exercised, not that it is
   *  wrong, and a reading from another revision says nothing about this one. */
  failing: readonly string[];
  route?: string;
}

export interface RtmReport {
  contracts: number;
  assertions: number;
  /** Inventory: checks that resolve. Not a verdict, and never read as one. */
  bound: number;
  /** Assertions whose evidence claims a decision procedure, and those that only witness. */
  decision: number;
  witness: number;
  documentedOnly: number;
  assumptions: number;
  uncovered: string[];
  orphans: string[];
  errors: string[];
  /** The last recorded run, and whether it describes the revision in front of us. */
  execution?: { head: string; at: string; dirty: number; current: boolean };
  items: RtmAssertionEvidence[];
  /** Per risk class, judged on its own evidence. No class is compared with another. */
  riskClasses: { riskClass: string; standings: Record<AssertionStanding, number>; ids: string[] }[];
  /** Contracts whose scope spans more than one route: a cross-module change, judged on its own. */
  crossModule: {
    contract: string;
    routes: string[];
    ids: string[];
    executed: number;
    notRecorded: number;
  }[];
  unresolvedAssumptions: string[];
  /** What remains open: uncovered claims, orphan checks, declared gaps, unsatisfied assumptions. */
  counterexamples: string[];
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
  routesById: Map<string, RouteDeclaration>;
  evidence: ExecutionEvidence | undefined;
  head: string | undefined;
  contract: string;
}

function standingOf(
  commands: readonly string[],
  evidence: ExecutionEvidence | undefined,
  head: string | undefined,
): { standing: AssertionStanding; evidence: string[]; failing: string[] } {
  if (!evidence)
    return { standing: "not-recorded", evidence: ["no execution evidence recorded"], failing: [] };
  if (!commands.length)
    return {
      standing: "not-recorded",
      evidence: ["no command carries this check: the route declares none"],
      failing: [],
    };
  const lines: string[] = [];
  const failing: string[] = [];
  let notPassed = false;
  let absent = false;
  let otherRevision = false;
  for (const command of commands) {
    const run = evidence.commands.get(command);
    if (!run) {
      absent = true;
      lines.push(`${command}: no record in the last run`);
      continue;
    }
    lines.push(`${command}=${run.status}${run.reason ? ` (${run.reason})` : ""}`);
    if (run.status !== "passed") {
      notPassed = true;
      if (run.status === "failed") failing.push(command);
      continue;
    }
    if (evidence.head !== head) otherRevision = true;
  }
  if (notPassed) return { standing: "not-run", evidence: lines, failing };
  if (absent) return { standing: "not-recorded", evidence: lines, failing };
  if (otherRevision)
    return {
      standing: "historical",
      evidence: [...lines, `recorded at ${evidence.head}, this tree is at ${head ?? "unknown"}`],
      failing,
    };
  return { standing: "executed", evidence: lines, failing };
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
  const check = assertion.check ?? "";
  const riskClass = `${assertion.strength ?? "witness"}/${assertion.kind ?? "unspecified"}/${assertion.stage ?? "unspecified"}`;
  const base = {
    contract: contractId,
    id: assertion.id,
    riskClass,
    check,
    failing: [] as string[],
  };
  if (assertion.documentedOnly) {
    report.documentedOnly += 1;
    report.items.push({
      ...base,
      standing: "documented-only",
      evidence: ["declared as documented only: no check is claimed"],
    });
    return;
  }
  scan.referenced.add(check);
  if (!scan.resolvable(check)) {
    report.uncovered.push(`${contractId}:${assertion.id} -> ${check}`);
    report.items.push({
      ...base,
      standing: "uncovered",
      evidence: ["the check does not resolve to a script or a named test"],
    });
    return;
  }
  report.bound += 1;
  if (assertion.strength === "decision") report.decision += 1;
  else report.witness += 1;
  const { commands, route } = commandsFor(check, scan.routesById);
  const decided = standingOf(commands, scan.evidence, scan.head);
  report.items.push({
    ...base,
    ...(route ? { route } : {}),
    standing: decided.standing,
    evidence: decided.evidence,
    failing: decided.failing,
  });
}

function scanContract(
  contract: RepositoryContractIr,
  scan: AssertionScan,
  routes: RouteDeclaration[],
): void {
  for (const check of contract.verification.checks) scan.declared.add(check);
  scan.contract = contract.id;
  for (const assertion of contract.assertions) scanAssertion(contract.id, assertion, scan);
  const selected = selectRoutes(contract, routes);
  if (selected.length > 1) {
    const ids = contract.assertions.map((assertion) => `${contract.id}:${assertion.id}`).sort();
    const items = ids
      .map((id) => scan.report.items.find((item) => `${item.contract}:${item.id}` === id))
      .filter((item): item is RtmAssertionEvidence => item !== undefined);
    scan.report.crossModule.push({
      contract: contract.id,
      routes: selected.map((route) => route.id).sort(),
      ids,
      executed: items.filter((item) => item.standing === "executed").length,
      notRecorded: items.filter((item) => item.standing !== "executed").length,
    });
  }
}

const STANDINGS: readonly AssertionStanding[] = [
  "executed",
  "historical",
  "not-recorded",
  "not-run",
  "documented-only",
  "uncovered",
];

function emptyReport(): RtmReport {
  return {
    contracts: 0,
    assertions: 0,
    bound: 0,
    decision: 0,
    witness: 0,
    documentedOnly: 0,
    assumptions: 0,
    uncovered: [],
    orphans: [],
    errors: [],
    items: [],
    riskClasses: [],
    crossModule: [],
    unresolvedAssumptions: [],
    counterexamples: [],
  };
}

interface ScanInput {
  root: string;
  directory: string;
  routes: RouteDeclaration[];
  scripts: string[];
  registered: Set<string> | undefined;
  evidence: ExecutionEvidence | undefined;
  head: string | undefined;
  report: RtmReport;
}

/** Reads every contract file, records each assertion's standing, and returns what the final pass
 *  needs to report the claims that rest on nothing. */
function scanContracts(input: ScanInput): Pick<AssertionScan, "declared" | "referenced" | "unresolved"> {
  const scan: AssertionScan = {
    report: input.report,
    resolvable: createResolver(input.root, input.routes, input.scripts),
    registered: input.registered,
    declared: new Set(),
    referenced: new Set(),
    unresolved: new Set(),
    routesById: new Map(input.routes.map((route) => [route.id, route])),
    evidence: input.evidence,
    head: input.head,
    contract: "",
  };
  const files = readdirSync(input.directory)
    .filter((file) => /\.ya?ml$/u.test(file))
    .sort();
  for (const name of files) {
    const result = compileContractFile(join(input.directory, name));
    if (result.ok && result.contract) {
      input.report.contracts += 1;
      scanContract(result.contract, scan, input.routes);
      continue;
    }
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.severity === "error")
        input.report.errors.push(`${name}: ${diagnostic.message}`);
    }
  }
  return scan;
}

/** A current run in which the command carrying an assertion failed is the one execution fact that
 *  fails this gate. A skip is a gap in the evidence, and a reading from another revision says
 *  nothing about this one. */
function appendExecutionErrors(report: RtmReport): void {
  if (!report.execution?.current) return;
  for (const item of report.items) {
    if (item.standing === "not-run" && item.failing.length > 0)
      report.errors.push(
        `${item.contract}:${item.id}: ${item.failing.join(", ")} failed in the current run: ${item.evidence.join("; ")}`,
      );
  }
}

/** Per risk class, judged on its own evidence: no class is ever summed into another. */
function groupRiskClasses(items: readonly RtmAssertionEvidence[]) {
  const classes = new Map<string, RtmAssertionEvidence[]>();
  for (const item of items) {
    const group = classes.get(item.riskClass) ?? [];
    group.push(item);
    classes.set(item.riskClass, group);
  }
  return [...classes]
    .map(([riskClass, group]) => ({
      riskClass,
      standings: Object.fromEntries(
        STANDINGS.map((standing) => [
          standing,
          group.filter((item) => item.standing === standing).length,
        ]),
      ) as Record<AssertionStanding, number>,
      ids: group.map((item) => `${item.contract}:${item.id}`).sort(),
    }))
    .sort((left, right) => left.riskClass.localeCompare(right.riskClass));
}

/** What remains open, as attributable items rather than as a total. */
function openCounterexamples(
  report: RtmReport,
  orphans: readonly string[],
  assumptions: readonly string[],
): string[] {
  const open: string[] = [];
  for (const item of report.items) {
    if (item.standing === "uncovered")
      open.push(`uncovered: ${item.contract}:${item.id} -> ${item.check}`);
    if (item.standing === "documented-only")
      open.push(`declared gap: ${item.contract}:${item.id}`);
    if (item.standing === "not-recorded")
      open.push(`no execution evidence: ${item.contract}:${item.id}`);
  }
  for (const check of orphans) open.push(`orphan check: ${check}`);
  for (const id of assumptions) open.push(`unsatisfied assumption: ${id}`);
  return open.sort();
}

export function checkRtm(rootDirectory = process.cwd()): RtmReport {
  const root = resolve(rootDirectory);
  const report = emptyReport();
  const directory = join(root, ".rcp", "contracts");
  if (!existsSync(directory)) {
    report.errors.push(".rcp/contracts: missing");
    return report;
  }
  const registered = registeredAssumptions(root);
  if (registered === undefined) report.errors.push(`${ASSUMPTIONS_PATH}: missing`);
  report.assumptions = registered?.size ?? 0;
  let routes: RouteDeclaration[] = [];
  try {
    routes = readRouteDeclarations(root);
  } catch (cause) {
    report.errors.push(`agent-context.yaml: ${(cause as Error).message}`);
  }
  const evidence = readExecutionEvidence(root);
  const head = currentHead(root);
  if (evidence)
    report.execution = {
      head: evidence.head,
      at: evidence.at,
      dirty: evidence.dirty,
      current: head !== undefined && evidence.head === head,
    };
  const scan = scanContracts({
    root,
    directory,
    routes,
    scripts: scriptsOf(root),
    registered,
    evidence,
    head,
    report,
  });
  for (const id of [...scan.unresolved].sort()) {
    report.errors.push(
      `${ASSUMPTIONS_PATH}: '${id}' is assumed by an assertion but not registered there`,
    );
  }
  report.unresolvedAssumptions = [...scan.unresolved].sort();
  report.orphans = [...scan.declared].filter((check) => !scan.referenced.has(check)).sort();
  appendExecutionErrors(report);
  report.counterexamples = openCounterexamples(report, report.orphans, report.unresolvedAssumptions);
  report.riskClasses = groupRiskClasses(report.items);
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
    `rtm inventory: ${report.contracts} contracts, ${report.assertions} assertions, ` +
      `${report.bound} bound checks (${report.decision} decision / ${report.witness} witness), ` +
      `${report.documentedOnly} documented-only, ${report.uncovered.length} uncovered, ` +
      `${report.orphans.length} orphan checks\n`,
  );
  process.stdout.write(
    report.execution
      ? `rtm execution: ${report.execution.at} at ${report.execution.head} ` +
          `(${report.execution.current ? "this tree" : "another revision"}), ` +
          `${report.execution.dirty} file(s) dirty then\n`
      : `rtm execution: no run recorded at ${EVIDENCE_PATH}, so no assertion is counted as executed\n`,
  );
  process.stdout.write(
    `rtm standing: ${report.items.length} assertion(s), each decided on its own\n`,
  );
  for (const item of report.items) {
    process.stdout.write(
      `  ${item.contract}:${item.id} [${item.riskClass}] ${item.standing}` +
        `${item.check ? ` (${item.check})` : ""}: ${item.evidence.join("; ")}\n`,
    );
  }
  for (const group of report.riskClasses) {
    const counted = STANDINGS.filter((standing) => group.standings[standing] > 0)
      .map((standing) => `${group.standings[standing]} ${standing}`)
      .join(", ");
    process.stdout.write(`rtm risk class ${group.riskClass}: ${counted}\n`);
  }
  for (const entry of report.crossModule) {
    process.stdout.write(
      `rtm cross-module ${entry.contract}: routes ${entry.routes.join(", ")}; ` +
        `${entry.executed} of ${entry.ids.length} executed, ${entry.notRecorded} without execution evidence\n`,
    );
  }
  process.stdout.write(
    `rtm assumptions: ${report.assumptions} registered, ${report.unresolvedAssumptions.length} unresolved\n`,
  );
  process.stdout.write(
    `rtm counterexamples: ${report.counterexamples.length} open` +
      `${report.counterexamples.length ? ` (${report.counterexamples.join("; ")})` : ""}\n`,
  );
  process.stdout.write(
    `rtm: no overall verdict - the counts above are inventory, not a conclusion; each assertion's ` +
      `standing is decided by its own evidence, and each risk class and cross-module contract stands alone\n`,
  );
  if (report.errors.length > 0 || report.uncovered.length > 0) process.exitCode = 1;
}
