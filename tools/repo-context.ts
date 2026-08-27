import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface VerificationConfig {
  blocking: string[];
  advisory: string[];
}

export interface RouteConfig {
  id: string;
  paths: string[];
  owners: string[];
  tests: string[];
  verify: VerificationConfig;
}

interface AgentContextConfig {
  version: number;
  routes: RouteConfig[];
}

export interface GuardrailSummary {
  id: string;
  status: string;
  reviewAfter?: string;
  reason?: string;
  exitCriteria?: string;
  path: string;
}

export interface AgentContextReport {
  project: string;
  version: string;
  root: string;
  scopes: string[];
  git: {
    branch?: string;
    head?: string;
    dirtyFiles: string[];
    available: boolean;
  };
  engines: Record<string, string>;
  routes: RouteConfig[];
  availableRoutes: string[];
  guardrails: GuardrailSummary[];
  canonical: {
    design: string;
    completion: string;
    todo: string;
  };
  state: RepositoryStateRevision;
  reconciliation: RepositoryReconciliation;
  warnings: string[];
}

export interface RepositoryStateRevision {
  desiredRevision: string;
  observedRevision: string;
}

export type ReconciliationStatus = "converged" | "drifted" | "unknown";

export interface ReconciliationCondition {
  type: "routing" | "verification";
  status: "true" | "false" | "unknown";
  message: string;
}

export interface ReconciliationDrift {
  kind: "routing" | "desired-state" | "observed-state" | "verification";
  severity: "blocking" | "advisory";
  message: string;
}

export interface RepositoryReconciliation {
  status: ReconciliationStatus;
  conditions: ReconciliationCondition[];
  drifts: ReconciliationDrift[];
  latestVerification?: {
    path: string;
    runId?: string;
    finishedAt?: string;
  };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function matches(pattern: string, scope: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedScope = normalizePath(scope);
  const wildcard = normalizedPattern.indexOf("*");
  if (wildcard < 0) return normalizedScope === normalizedPattern;
  const prefix = normalizedPattern.slice(0, wildcard).replace(/\/$/, "");
  return normalizedScope === prefix || normalizedScope.startsWith(`${prefix}/`);
}

function readConfig(root: string): AgentContextConfig {
  const parsed = parseYaml(
    readFileSync(join(root, "agent-context.yaml"), "utf8"),
  ) as Partial<AgentContextConfig>;
  if (parsed.version !== 1 || !Array.isArray(parsed.routes)) {
    throw new Error("agent-context.yaml must declare version: 1 and a routes array");
  }
  const ids = new Set<string>();
  for (const route of parsed.routes) {
    if (!route || typeof route !== "object" || !textValue(route.id)) {
      throw new Error("each route must declare a non-empty id");
    }
    if (ids.has(route.id)) throw new Error(`duplicate route id: ${route.id}`);
    ids.add(route.id);
  }
  for (const route of parsed.routes) {
    for (const field of ["paths", "owners", "tests"] as const) {
      if (!isStringArray(route[field])) {
        throw new Error(`${route.id}: ${field} must be a string array`);
      }
    }
    if (
      !route.verify ||
      !isStringArray(route.verify.blocking) ||
      !isStringArray(route.verify.advisory)
    ) {
      throw new Error(`${route.id}: verify must declare blocking and advisory script arrays`);
    }
    const overlap = route.verify.blocking.find((command) => route.verify.advisory.includes(command));
    if (overlap) {
      throw new Error(
        `${route.id}: npm script ${overlap} cannot be both blocking and advisory`,
      );
    }
  }
  return parsed as AgentContextConfig;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function git(root: string): AgentContextReport["git"] {
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  const branch = run(["branch", "--show-current"]);
  const head = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (branch.status !== 0 || status.status !== 0) {
    return { available: false, dirtyFiles: [] };
  }
  const entries = status.stdout.split("\0").filter(Boolean);
  const dirtyFiles: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const statusCode = entry.slice(0, 2);
    dirtyFiles.push(normalizePath(entry.slice(3)));
    if (statusCode.includes("R") || statusCode.includes("C")) index += 1;
  }
  return {
    available: true,
    branch: branch.stdout.trim() || undefined,
    head: head.status === 0 ? head.stdout.trim() || undefined : undefined,
    dirtyFiles,
  };
}

function guardrails(root: string): { active: GuardrailSummary[]; warnings: string[] } {
  const directory = join(root, "tests", "guardrails");
  if (!existsSync(directory)) return { active: [], warnings: [] };
  const result: GuardrailSummary[] = [];
  const warnings: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(directory, entry.name, "guardrail.yaml");
    if (!existsSync(manifest)) continue;
    const parsed = parseYaml(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    const id = textValue(parsed.id) ?? entry.name;
    const status = textValue(parsed.status) ?? "unknown";
    const summary = {
      id,
      status,
      reviewAfter: textValue(parsed.review_after),
      reason: textValue(parsed.reason),
      exitCriteria: textValue(parsed.exit_criteria),
      path: normalizePath(relative(root, manifest)),
    } satisfies GuardrailSummary;
    result.push(summary);
    if (status === "active") {
      if (!summary.reason) warnings.push(`guardrail ${id}: missing reason`);
      if (!summary.reviewAfter) warnings.push(`guardrail ${id}: missing review_after`);
      if (!summary.exitCriteria) warnings.push(`guardrail ${id}: missing exit_criteria`);
    }
  }
  return { active: result.filter((item) => item.status === "active"), warnings };
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateRoutes(
  root: string,
  routes: RouteConfig[],
  scripts: Record<string, string>,
): string[] {
  const warnings: string[] = [];
  for (const route of routes) {
    for (const owner of route.owners) {
      if (!existsSync(join(root, owner))) warnings.push(`${route.id}: missing owner ${owner}`);
    }
    for (const command of [...route.verify.blocking, ...route.verify.advisory]) {
      if (!(command in scripts)) warnings.push(`${route.id}: missing npm script ${command}`);
    }
  }
  return warnings;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function desiredRevision(routes: RouteConfig[], scripts: Record<string, string>): string {
  const commands = new Set(
    routes.flatMap((route) => [...route.verify.blocking, ...route.verify.advisory]),
  );
  return digest(
    JSON.stringify({
      routes,
      scripts: [...commands]
        .sort()
        .map((command) => [command, scripts[command] ?? null]),
    }),
  );
}

function updatePathDigest(hash: ReturnType<typeof createHash>, root: string, scope: string): void {
  const path = resolve(root, scope);
  const local = relative(root, path);
  if (local.startsWith("..")) {
    hash.update(`external:${scope}\0`);
    return;
  }
  if (!existsSync(path)) {
    hash.update(`missing:${scope}\0`);
    return;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    hash.update(`link:${scope}:${readlinkSync(path)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`directory:${scope}\0`);
    for (const entry of readdirSync(path, { withFileTypes: true })
      .filter((entry) => ![".git", ".nmg", "node_modules"].includes(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      updatePathDigest(hash, root, join(scope, entry.name));
    }
    return;
  }
  hash.update(`file:${scope}\0`);
  hash.update(readFileSync(path));
  hash.update("\0");
}

function observedRevision(root: string, scopes: string[]): string {
  const hash = createHash("sha256");
  for (const scope of [...scopes].sort()) updatePathDigest(hash, root, scope);
  return hash.digest("hex");
}

interface VerificationEvidence {
  runId?: string;
  finishedAt?: string;
  report?: {
    state?: RepositoryStateRevision;
  };
  result?: {
    results?: Array<{
      command?: string;
      classification?: string;
      status?: string;
    }>;
  };
}

function reconcile(
  root: string,
  routes: RouteConfig[],
  scopes: string[],
  warnings: string[],
  state: RepositoryStateRevision,
): RepositoryReconciliation {
  const conditions: ReconciliationCondition[] = [];
  const drifts: ReconciliationDrift[] = warnings.map((warning) => ({
    kind: "routing",
    severity: "blocking",
    message: warning,
  }));
  conditions.push({
    type: "routing",
    status: warnings.length ? "false" : routes.length || !scopes.length ? "true" : "unknown",
    message: warnings.length ? "Route declarations do not match the observed repository." : "Route declarations are valid for the selected scope.",
  });

  const evidencePath = join(root, ".nmg", "verification", "latest.json");
  if (!existsSync(evidencePath)) {
    conditions.push({
      type: "verification",
      status: "unknown",
      message: "No verification evidence has been recorded for this repository state.",
    });
    return { status: drifts.length ? "drifted" : "unknown", conditions, drifts };
  }

  let evidence: VerificationEvidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as VerificationEvidence;
  } catch {
    drifts.push({
      kind: "verification",
      severity: "blocking",
      message: "Latest verification evidence is unreadable.",
    });
    conditions.push({
      type: "verification",
      status: "false",
      message: "Latest verification evidence is unreadable.",
    });
    return { status: "drifted", conditions, drifts, latestVerification: { path: ".nmg/verification/latest.json" } };
  }

  const latestVerification = {
    path: ".nmg/verification/latest.json",
    runId: evidence.runId,
    finishedAt: evidence.finishedAt,
  };
  const verifiedState = evidence.report?.state;
  if (!verifiedState) {
    conditions.push({
      type: "verification",
      status: "unknown",
      message: "Latest verification evidence predates repository-state reconciliation.",
    });
    return {
      status: drifts.length ? "drifted" : "unknown",
      conditions,
      drifts,
      latestVerification,
    };
  }
  if (verifiedState.desiredRevision !== state.desiredRevision) {
    drifts.push({
      kind: "desired-state",
      severity: "blocking",
      message: "Route or verification declarations changed after the latest verification run.",
    });
  }
  if (verifiedState.observedRevision !== state.observedRevision) {
    drifts.push({
      kind: "observed-state",
      severity: "blocking",
      message: "The selected repository content changed after the latest verification run.",
    });
  }
  if (drifts.length) {
    conditions.push({
      type: "verification",
      status: "false",
      message: "Latest verification evidence does not describe the current repository state.",
    });
    return { status: "drifted", conditions, drifts, latestVerification };
  }

  const results = evidence.result?.results ?? [];
  const required = [...new Set(routes.flatMap((route) => route.verify.blocking))];
  const missingOrFailed = required.filter(
    (command) =>
      !results.some(
        (result) =>
          result.command === command &&
          result.classification === "blocking" &&
          result.status === "passed",
      ),
  );
  if (missingOrFailed.length) {
    drifts.push({
      kind: "verification",
      severity: "blocking",
      message: `Blocking verification is not satisfied: ${missingOrFailed.join(", ")}.`,
    });
    conditions.push({
      type: "verification",
      status: "false",
      message: "Matching evidence is missing one or more passing blocking checks.",
    });
    return { status: "drifted", conditions, drifts, latestVerification };
  }

  conditions.push({
    type: "verification",
    status: "true",
    message: "Latest evidence matches this repository state and satisfies all blocking checks.",
  });
  return { status: "converged", conditions, drifts, latestVerification };
}

export function collectAgentContext(
  root: string,
  scopes: string[] = [],
  options: { changed?: boolean } = {},
): AgentContextReport {
  const resolvedRoot = resolve(root);
  const packageJson = JSON.parse(readFileSync(join(resolvedRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  };
  const config = readConfig(resolvedRoot);
  const gitState = git(resolvedRoot);
  const requestedScopes = options.changed ? [...scopes, ...gitState.dirtyFiles] : scopes;
  const normalizedScopes = [
    ...new Set(
      requestedScopes.map((scope) => {
        const path = resolve(resolvedRoot, scope);
        const local = relative(resolvedRoot, path);
        return normalizePath(local.startsWith("..") ? scope : local);
      }),
    ),
  ];
  const selected = normalizedScopes.length
    ? config.routes.filter((route) =>
        normalizedScopes.some((scope) => route.paths.some((pattern) => matches(pattern, scope))),
      )
    : [];
  const scripts = packageJson.scripts ?? {};
  const guardrailState = guardrails(resolvedRoot);
  const warnings = [...validateRoutes(resolvedRoot, selected, scripts), ...guardrailState.warnings];
  if (normalizedScopes.length && !selected.length) {
    warnings.push(`no route matched: ${normalizedScopes.join(", ")}`);
  }
  if (options.changed && !gitState.available) {
    warnings.push("--changed requires an available Git worktree");
  }
  const state = {
    desiredRevision: desiredRevision(selected, scripts),
    observedRevision: observedRevision(resolvedRoot, normalizedScopes),
  };
  const report: AgentContextReport = {
    project: packageJson.name ?? "unknown",
    version: packageJson.version ?? "unknown",
    root: normalizePath(resolvedRoot),
    scopes: normalizedScopes,
    git: gitState,
    engines: packageJson.engines ?? {},
    routes: selected,
    availableRoutes: config.routes.map((route) => route.id),
    guardrails: guardrailState.active,
    canonical: {
      design: "docs/design/design.md",
      completion: "docs/design/completion-audit.md",
      todo: "docs/design/temporary-todo.md",
    },
    state,
    reconciliation: reconcile(resolvedRoot, selected, normalizedScopes, warnings, state),
    warnings,
  };
  return report;
}

export function validateAgentContext(root: string): string[] {
  const resolvedRoot = resolve(root);
  const packageJson = JSON.parse(readFileSync(join(resolvedRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return [
    ...validateRoutes(resolvedRoot, readConfig(resolvedRoot).routes, packageJson.scripts ?? {}),
    ...guardrails(resolvedRoot).warnings,
  ];
}

export function formatAgentContext(report: AgentContextReport): string {
  const lines = [
    `# Repository context: ${report.project}@${report.version}`,
    "",
    `- Root: ${report.root}`,
    `- Scope: ${report.scopes.length ? report.scopes.join(", ") : "not selected"}`,
    `- Git: ${report.git.available ? (report.git.branch ?? "detached") : "unavailable"}`,
    `- Dirty files: ${report.git.dirtyFiles.length}`,
  ];
  for (const file of report.git.dirtyFiles) lines.push(`  - ${file}`);
  lines.push("", "## Canonical state");
  lines.push(`- Design: ${report.canonical.design}`);
  lines.push(`- Completion: ${report.canonical.completion}`);
  lines.push(`- TODO: ${report.canonical.todo}`);
  lines.push("", "## Reconciliation");
  lines.push(`- Status: ${report.reconciliation.status}`);
  lines.push(`- Desired revision: ${report.state.desiredRevision.slice(0, 12)}`);
  lines.push(`- Observed revision: ${report.state.observedRevision.slice(0, 12)}`);
  for (const condition of report.reconciliation.conditions) {
    lines.push(`- ${condition.type}: ${condition.status} — ${condition.message}`);
  }
  if (report.reconciliation.latestVerification) {
    const evidence = report.reconciliation.latestVerification;
    lines.push(
      `- Evidence: ${evidence.path}${evidence.runId ? ` (${evidence.runId})` : ""}`,
    );
  }
  if (!report.routes.length) {
    lines.push("", "## Available routes");
    for (const id of report.availableRoutes) lines.push(`- ${id}`);
    lines.push("", "Run again with `--scope <target-path>` for task-specific owners and checks.");
  }
  for (const route of report.routes) {
    lines.push("", `## Route: ${route.id}`);
    lines.push(`- Owners: ${route.owners.join(", ") || "none"}`);
    lines.push(`- Tests: ${route.tests.join(", ") || "none"}`);
    lines.push(
      `- Blocking: ${route.verify.blocking.map((name) => `npm run ${name}`).join(", ") || "none"}`,
    );
    lines.push(
      `- Advisory: ${route.verify.advisory.map((name) => `npm run ${name}`).join(", ") || "none"}`,
    );
  }
  if (report.guardrails.length) {
    lines.push("", "## Active guardrails");
    for (const item of report.guardrails) {
      lines.push(
        `- ${item.id}${item.reviewAfter ? ` (review ${item.reviewAfter})` : ""}: ${item.path}`,
      );
    }
  }
  if (report.warnings.length) {
    lines.push("", "## Warnings");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(args: string[]): {
  root: string;
  scopes: string[];
  json: boolean;
  check: boolean;
  changed: boolean;
} {
  let root = process.cwd();
  let json = false;
  let check = false;
  let changed = false;
  const scopes: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") json = true;
    else if (argument === "--check") check = true;
    else if (argument === "--changed") changed = true;
    else if (argument === "--root") root = args[++index] ?? root;
    else if (argument === "--scope") {
      const scope = args[++index];
      if (!scope) throw new Error("--scope requires a path");
      scopes.push(scope);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return { root, scopes, json, check, changed };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.check) {
      const warnings = validateAgentContext(options.root);
      if (warnings.length) throw new Error(warnings.join("\n"));
      process.stdout.write("agent-context routes are valid\n");
      process.exit(0);
    }
    const report = collectAgentContext(options.root, options.scopes, {
      changed: options.changed,
    });
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : formatAgentContext(report),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
