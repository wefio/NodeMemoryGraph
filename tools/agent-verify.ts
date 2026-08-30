import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectAgentContext, type AgentContextReport } from "./repo-context.ts";
import {
  buildRouteVerificationPlan,
  executeVerificationPlan,
  npmCommandRunner,
  type VerificationCommandResult,
  type VerificationRunResult,
} from "../src/rcp/verification.ts";
export {
  executeVerificationPlan,
  type VerificationClassification,
  type VerificationCommandResult,
  type VerificationFailureKind,
  type VerificationPlan,
  type VerificationPlanItem,
  type VerificationRunResult,
  type VerificationStatus,
} from "../src/rcp/verification.ts";

export function buildVerificationPlan(report: AgentContextReport) {
  return buildRouteVerificationPlan(report.routes);
}

function parseArgs(args: string[]) {
  let root = process.cwd();
  let changed = false;
  let dryRun = false;
  let includeAdvisory = false;
  let json = false;
  let requireClean = false;
  let timeoutMs = 30 * 60 * 1_000;
  let output: string | undefined;
  let help = false;
  const scopes: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--changed") changed = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--include-advisory") includeAdvisory = true;
    else if (argument === "--json") json = true;
    else if (argument === "--require-clean") requireClean = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--timeout-ms") {
      timeoutMs = Number(args[++index]);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout-ms requires a positive integer");
      }
    } else if (argument === "--output") {
      output = args[++index];
      if (!output) throw new Error("--output requires a path");
    }
    else if (argument === "--root") root = args[++index] ?? root;
    else if (argument === "--scope") {
      const scope = args[++index];
      if (!scope) throw new Error("--scope requires a path");
      scopes.push(scope);
    } else if (argument.startsWith("-")) throw new Error(`unknown argument: ${argument}`);
    else scopes.push(argument);
  }
  if (!changed && !scopes.length) changed = true;
  const resolvedRoot = resolve(root);
  return {
    root: resolvedRoot,
    changed,
    dryRun,
    includeAdvisory,
    json,
    requireClean,
    timeoutMs,
    output: output ? resolve(resolvedRoot, output) : join(resolvedRoot, ".nmg", "verification", "latest.json"),
    scopes,
    help,
  };
}

const usage = `Usage: npm run agent:verify -- [paths...] [options]

Paths select matching verification routes directly and do not require Git.
With no paths, verification defaults to dirty Git paths.
  --changed              derive scopes from dirty Git paths; requires Git inspection
  --scope <path>         legacy spelling for a path; positional paths are preferred
  --include-advisory     run advisory checks in addition to blocking checks
  --dry-run              print and persist the plan without running checks
  --require-clean        reject a dirty Git worktree
  --root <path>          verify another repository root
  --json                 emit structured JSON
`;

function persistEvidence(path: string, evidence: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function formatResult(report: AgentContextReport, result: VerificationRunResult): string {
  const lines = [
    `Verification scopes: ${report.scopes.join(", ") || "none"}`,
    `Routes: ${report.routes.map((route) => route.id).join(", ") || "none"}`,
  ];
  for (const item of result.results) {
    const detail = item.reason ? ` (${item.reason})` : ` (${item.durationMs}ms)`;
    lines.push(
      `- [${item.classification}] npm run ${item.command}: ${item.status}${detail} <- ${item.routes.join(", ")}`,
    );
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage);
      process.exit(0);
    }
    const startedAt = new Date().toISOString();
    const report = collectAgentContext(options.root, options.scopes, {
      changed: options.changed,
    });
    if (options.changed && !report.git.available) {
      throw new Error(
        `--changed requires an available Git worktree${report.git.error ? `: ${report.git.error}` : ""}`,
      );
    }
    if (options.requireClean && report.git.dirtyFiles.length) {
      throw new Error(`--require-clean found ${report.git.dirtyFiles.length} dirty files`);
    }
    if (report.scopes.length && !report.routes.length) {
      throw new Error(`no verification route matched: ${report.scopes.join(", ")}`);
    }
    const result = await executeVerificationPlan(buildVerificationPlan(report), {
      includeAdvisory: options.includeAdvisory,
      dryRun: options.dryRun,
      run: npmCommandRunner(options.root, options.json, options.timeoutMs),
    });
    const finishedAt = new Date().toISOString();
    const evidence = {
      schemaVersion: 1,
      runId: randomUUID(),
      startedAt,
      finishedAt,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      options: {
        changed: options.changed,
        dryRun: options.dryRun,
        includeAdvisory: options.includeAdvisory,
        requireClean: options.requireClean,
        timeoutMs: options.timeoutMs,
      },
      report,
      result,
    };
    persistEvidence(options.output, evidence);
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ report, ...result, evidencePath: options.output }, null, 2)}\n`
        : formatResult(report, result),
    );
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
