import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

interface RouteConfig {
  id: string;
  paths: string[];
  owners: string[];
  tests: string[];
  verify: string[];
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
  warnings: string[];
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
  return parsed as AgentContextConfig;
}

function git(root: string): AgentContextReport["git"] {
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  const branch = run(["branch", "--show-current"]);
  const status = run(["status", "--short", "--untracked-files=all"]);
  if (branch.status !== 0 || status.status !== 0) {
    return { available: false, dirtyFiles: [] };
  }
  const dirtyFiles = status.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => normalizePath(line.slice(3).trim()));
  return { available: true, branch: branch.stdout.trim() || undefined, dirtyFiles };
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
    for (const command of route.verify) {
      if (!(command in scripts)) warnings.push(`${route.id}: missing npm script ${command}`);
    }
  }
  return warnings;
}

export function collectAgentContext(root: string, scopes: string[] = []): AgentContextReport {
  const resolvedRoot = resolve(root);
  const packageJson = JSON.parse(readFileSync(join(resolvedRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  };
  const config = readConfig(resolvedRoot);
  const normalizedScopes = scopes.map((scope) => {
    const path = resolve(resolvedRoot, scope);
    const local = relative(resolvedRoot, path);
    return normalizePath(local.startsWith("..") ? scope : local);
  });
  const selected = normalizedScopes.length
    ? config.routes.filter((route) =>
        normalizedScopes.some((scope) => route.paths.some((pattern) => matches(pattern, scope))),
      )
    : [];
  const scripts = packageJson.scripts ?? {};
  const guardrailState = guardrails(resolvedRoot);
  const report: AgentContextReport = {
    project: packageJson.name ?? "unknown",
    version: packageJson.version ?? "unknown",
    root: normalizePath(resolvedRoot),
    scopes: normalizedScopes,
    git: git(resolvedRoot),
    engines: packageJson.engines ?? {},
    routes: selected,
    availableRoutes: config.routes.map((route) => route.id),
    guardrails: guardrailState.active,
    canonical: {
      design: "docs/design/design.md",
      completion: "docs/design/completion-audit.md",
      todo: "docs/design/temporary-todo.md",
    },
    warnings: [...validateRoutes(resolvedRoot, selected, scripts), ...guardrailState.warnings],
  };
  if (normalizedScopes.length && !selected.length) {
    report.warnings.push(`no route matched: ${normalizedScopes.join(", ")}`);
  }
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
  if (!report.routes.length) {
    lines.push("", "## Available routes");
    for (const id of report.availableRoutes) lines.push(`- ${id}`);
    lines.push("", "Run again with `--scope <target-path>` for task-specific owners and checks.");
  }
  for (const route of report.routes) {
    lines.push("", `## Route: ${route.id}`);
    lines.push(`- Owners: ${route.owners.join(", ") || "none"}`);
    lines.push(`- Tests: ${route.tests.join(", ") || "none"}`);
    lines.push(`- Verify: ${route.verify.map((name) => `npm run ${name}`).join(", ") || "none"}`);
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
} {
  let root = process.cwd();
  let json = false;
  let check = false;
  const scopes: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") json = true;
    else if (argument === "--check") check = true;
    else if (argument === "--root") root = args[++index] ?? root;
    else if (argument === "--scope") {
      const scope = args[++index];
      if (!scope) throw new Error("--scope requires a path");
      scopes.push(scope);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return { root, scopes, json, check };
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
    const report = collectAgentContext(options.root, options.scopes);
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : formatAgentContext(report),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
