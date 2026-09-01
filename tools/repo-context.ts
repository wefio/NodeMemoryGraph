import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { digestRepositoryPaths, observeGitWorktree } from "../src/rcp/repository.ts";

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

export interface CapabilityConfig {
  id: string;
  aliases: string[];
  summary: string;
  paths: string[];
  entrypoints: string[];
  supports: string[];
}

interface AgentContextConfig {
  version: number;
  capabilities: CapabilityConfig[];
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
    error?: string;
  };
  engines: Record<string, string>;
  routes: RouteConfig[];
  availableRoutes: string[];
  capabilities: CapabilityConfig[];
  availableCapabilities: CapabilityConfig[];
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
  parsed.capabilities ??= [];
  if (!Array.isArray(parsed.capabilities)) {
    throw new Error("agent-context.yaml capabilities must be an array");
  }
  const capabilityNames = new Set<string>();
  for (const capability of parsed.capabilities) {
    if (!capability || typeof capability !== "object" || !textValue(capability.id)) {
      throw new Error("each capability must declare a non-empty id");
    }
    for (const field of ["aliases", "paths", "entrypoints", "supports"] as const) {
      if (!isStringArray(capability[field])) {
        throw new Error(`${capability.id}: ${field} must be a string array`);
      }
    }
    if (!capability.paths.length || !capability.entrypoints.length) {
      throw new Error(`${capability.id}: paths and entrypoints must not be empty`);
    }
    if (!textValue(capability.summary)) {
      throw new Error(`${capability.id}: summary must be non-empty`);
    }
    for (const name of [capability.id, ...capability.aliases]) {
      if (capabilityNames.has(name)) throw new Error(`duplicate capability name: ${name}`);
      capabilityNames.add(name);
    }
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
    const overlap = route.verify.blocking.find((command) =>
      route.verify.advisory.includes(command),
    );
    if (overlap) {
      throw new Error(`${route.id}: npm script ${overlap} cannot be both blocking and advisory`);
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

function validateCapabilities(
  root: string,
  capabilities: CapabilityConfig[],
  routes: RouteConfig[],
  scripts: Record<string, string>,
): string[] {
  const warnings: string[] = [];
  for (const capability of capabilities) {
    if (!capability.paths.some((path) => existsSync(join(root, path)))) {
      warnings.push(`${capability.id}: no declared path exists`);
    }
    if (
      !capability.paths.some((path) =>
        routes.some((route) => route.paths.some((pattern) => matches(pattern, path))),
      )
    ) {
      warnings.push(`${capability.id}: no route owns its declared paths`);
    }
    for (const entrypoint of capability.entrypoints) {
      const match = /^npm run ([^\s]+)(?:\s|$)/u.exec(entrypoint);
      if (match && !(match[1]! in scripts)) {
        warnings.push(`${capability.id}: missing npm script ${match[1]}`);
      }
    }
  }
  return warnings;
}

function git(root: string): AgentContextReport["git"] {
  const observation = observeGitWorktree(root);
  return {
    available: observation.available,
    branch: observation.branch,
    head: observation.commit,
    dirtyFiles: observation.dirtyFiles,
    error: observation.error,
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

function desiredRevision(
  routes: RouteConfig[],
  capabilities: CapabilityConfig[],
  scripts: Record<string, string>,
): string {
  const commands = new Set(
    routes.flatMap((route) => [...route.verify.blocking, ...route.verify.advisory]),
  );
  return digest(
    JSON.stringify({
      routes,
      capabilities,
      scripts: [...commands].sort().map((command) => [command, scripts[command] ?? null]),
    }),
  );
}

function observedRevision(root: string, scopes: string[]): string {
  return digestRepositoryPaths(root, scopes);
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
    message: warnings.length
      ? "Route declarations do not match the observed repository."
      : "Route declarations are valid for the selected scope.",
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
    return {
      status: "drifted",
      conditions,
      drifts,
      latestVerification: { path: ".nmg/verification/latest.json" },
    };
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
  options: { changed?: boolean; capabilities?: string[] } = {},
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
  const requestedCapabilities = options.capabilities ?? [];
  const selectedCapabilities = [
    ...new Map(
      requestedCapabilities.flatMap((name): Array<[string, CapabilityConfig]> => {
        const match = config.capabilities.find(
          (capability) => capability.id === name || capability.aliases.includes(name),
        );
        return match ? [[match.id, match]] : [];
      }),
    ).values(),
  ];
  const capabilityScopes = selectedCapabilities.flatMap((capability) => capability.paths);
  const requestedScopes = options.changed
    ? [...scopes, ...capabilityScopes, ...gitState.dirtyFiles]
    : [...scopes, ...capabilityScopes];
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
  const warnings = [
    ...validateRoutes(resolvedRoot, selected, scripts),
    ...validateCapabilities(resolvedRoot, selectedCapabilities, config.routes, scripts),
    ...guardrailState.warnings,
  ];
  for (const name of requestedCapabilities) {
    if (
      !selectedCapabilities.some(
        (capability) => capability.id === name || capability.aliases.includes(name),
      )
    ) {
      warnings.push(`unknown capability: ${name}`);
    }
  }
  if (normalizedScopes.length && !selected.length) {
    warnings.push(`no route matched: ${normalizedScopes.join(", ")}`);
  }
  if (options.changed && !gitState.available) {
    warnings.push(
      `--changed requires an available Git worktree${gitState.error ? `: ${gitState.error}` : ""}`,
    );
  }
  const state = {
    desiredRevision: desiredRevision(selected, selectedCapabilities, scripts),
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
    capabilities: selectedCapabilities,
    availableCapabilities: config.capabilities,
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
  const config = readConfig(resolvedRoot);
  return [
    ...validateRoutes(resolvedRoot, config.routes, packageJson.scripts ?? {}),
    ...validateCapabilities(
      resolvedRoot,
      config.capabilities,
      config.routes,
      packageJson.scripts ?? {},
    ),
    ...guardrails(resolvedRoot).warnings,
  ];
}

export function formatAgentContext(report: AgentContextReport): string {
  const lines = [
    `# Repository context: ${report.project}@${report.version}`,
    "",
    `- Root: ${report.root}`,
    `- Scope: ${report.scopes.length ? report.scopes.join(", ") : "not selected"}`,
    `- Git: ${
      report.git.available
        ? (report.git.branch ?? "detached")
        : `unavailable${report.git.error ? ` (${report.git.error})` : ""}`
    }`,
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
    lines.push(`- Evidence: ${evidence.path}${evidence.runId ? ` (${evidence.runId})` : ""}`);
  }
  if (!report.routes.length) {
    lines.push("", "## Available routes");
    for (const id of report.availableRoutes) lines.push(`- ${id}`);
    lines.push("", "Run again with `<target-path>` for task-specific owners and checks.");
  }
  if (!report.capabilities.length && report.availableCapabilities.length) {
    lines.push("", "## Available capabilities");
    for (const capability of report.availableCapabilities) {
      lines.push(`- capability:${capability.id} — ${capability.summary}`);
      lines.push(`  - Entrypoints: ${capability.entrypoints.join(", ") || "none"}`);
      lines.push(`  - Supports: ${capability.supports.join(", ") || "not enumerated"}`);
    }
  }
  for (const capability of report.capabilities) {
    lines.push("", `## Capability: ${capability.id}`);
    lines.push(`- Summary: ${capability.summary}`);
    lines.push(`- Entrypoints: ${capability.entrypoints.join(", ") || "none"}`);
    lines.push(`- Supports: ${capability.supports.join(", ") || "not enumerated"}`);
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
  capabilities: string[];
  help: boolean;
} {
  let root = process.cwd();
  let json = false;
  let check = false;
  let changed = false;
  let help = false;
  const scopes: string[] = [];
  const capabilities: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") json = true;
    else if (argument === "--check") check = true;
    else if (argument === "--changed") changed = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--root") root = args[++index] ?? root;
    else if (argument === "--scope") {
      const scope = args[++index];
      if (!scope) throw new Error("--scope requires a path");
      scopes.push(scope);
    } else if (argument.startsWith("-")) throw new Error(`unknown argument: ${argument}`);
    else if (argument.startsWith("capability:")) {
      const capability = argument.slice("capability:".length);
      if (!capability) throw new Error("capability: requires an id or alias");
      capabilities.push(capability);
    } else scopes.push(argument);
  }
  return { root, scopes, json, check, changed, capabilities, help };
}

const usage = `Usage: npm run agent:context -- [paths...] [options]

Paths select matching repository routes directly and do not require Git.
Use capability:<id-or-alias> to discover an existing repository capability.
  --changed       also derive scopes from dirty Git paths; requires Git inspection
  --scope <path>  legacy spelling for a path; positional paths are preferred
  --root <path>   inspect another repository root
  --json          emit structured JSON
  --check         validate all route declarations
`;

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage);
      process.exit(0);
    }
    if (options.check) {
      const warnings = validateAgentContext(options.root);
      if (warnings.length) throw new Error(warnings.join("\n"));
      process.stdout.write("agent-context routes are valid\n");
      process.exit(0);
    }
    const report = collectAgentContext(options.root, options.scopes, {
      changed: options.changed,
      capabilities: options.capabilities,
    });
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : formatAgentContext(report),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
