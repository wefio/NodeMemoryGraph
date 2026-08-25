import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectAgentContext, type AgentContextReport } from "./repo-context.ts";

export type VerificationClassification = "blocking" | "advisory";
export type VerificationStatus = "passed" | "failed" | "skipped";
export type VerificationFailureKind = "exit" | "spawn" | "timeout" | "signal" | "runner";

export interface VerificationPlanItem {
  command: string;
  classification: VerificationClassification;
  routes: string[];
}

export interface VerificationPlan {
  blocking: VerificationPlanItem[];
  advisory: VerificationPlanItem[];
}

export interface VerificationCommandResult extends VerificationPlanItem {
  status: VerificationStatus;
  exitCode?: number;
  durationMs: number;
  reason?: string;
  output?: string;
  errorKind?: VerificationFailureKind;
  signal?: NodeJS.Signals;
}

export interface VerificationRunResult {
  ok: boolean;
  results: VerificationCommandResult[];
}

type CommandRunner = (
  command: string,
  classification: VerificationClassification,
  routes: string[],
) => Promise<VerificationCommandResult>;

function collectPlanItems(
  report: AgentContextReport,
  classification: VerificationClassification,
): VerificationPlanItem[] {
  const commands = new Map<string, string[]>();
  for (const route of report.routes) {
    for (const command of route.verify[classification]) {
      const routes = commands.get(command) ?? [];
      routes.push(route.id);
      commands.set(command, routes);
    }
  }
  return [...commands].map(([command, routes]) => ({
    command,
    classification,
    routes,
  }));
}

export function buildVerificationPlan(report: AgentContextReport): VerificationPlan {
  return {
    blocking: collectPlanItems(report, "blocking"),
    advisory: collectPlanItems(report, "advisory"),
  };
}

export async function executeVerificationPlan(
  plan: VerificationPlan,
  options: {
    includeAdvisory?: boolean;
    dryRun?: boolean;
    run: CommandRunner;
  },
): Promise<VerificationRunResult> {
  const results: VerificationCommandResult[] = [];
  const execute = async (item: VerificationPlanItem) => {
    if (options.dryRun) {
      results.push({ ...item, status: "skipped", durationMs: 0, reason: "dry run" });
      return;
    }
    try {
      const result = await options.run(item.command, item.classification, item.routes);
      results.push({ ...result, ...item });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results.push({
        ...item,
        status: "failed",
        durationMs: 0,
        errorKind: "runner",
        reason,
        output: outputTail(reason),
      });
    }
  };

  for (const item of plan.blocking) await execute(item);
  if (options.includeAdvisory) {
    for (const item of plan.advisory) await execute(item);
  } else {
    for (const item of plan.advisory) {
      results.push({
        ...item,
        status: "skipped",
        durationMs: 0,
        reason: "advisory checks require --include-advisory",
      });
    }
  }

  return {
    ok: results.every(
      (result) => result.classification === "advisory" || result.status !== "failed",
    ),
    results,
  };
}

function outputTail(value: string, limit = 8_000): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= limit ? text : `[truncated]\n${text.slice(-limit)}`;
}

function npmRunner(root: string, quiet: boolean, timeoutMs: number): CommandRunner {
  return async (command, classification, routes) => {
    const started = performance.now();
    const npmEntry = process.env.npm_execpath;
    const executable = npmEntry
      ? process.execPath
      : process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : "npm";
    const args = npmEntry
      ? [npmEntry, "run", command]
      : process.platform === "win32"
        ? ["/d", "/s", "/c", `npm run ${command}`]
        : ["run", command];
    const result = spawnSync(executable, args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (!quiet) {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const errorKind: VerificationFailureKind | undefined =
      errorCode === "ETIMEDOUT"
        ? "timeout"
        : result.error
          ? "spawn"
          : result.signal
            ? "signal"
            : result.status !== 0
              ? "exit"
              : undefined;
    const exitCode = result.status ?? undefined;
    const reason =
      errorKind === "timeout"
        ? `command exceeded ${timeoutMs}ms timeout`
        : result.error?.message ??
          (result.signal
            ? `command terminated by ${result.signal}`
            : errorKind === "exit"
              ? `command exited with code ${exitCode ?? "unknown"}`
              : undefined);
    return {
      command,
      classification,
      routes,
      status: errorKind ? "failed" : "passed",
      exitCode,
      durationMs: Math.round(performance.now() - started),
      errorKind,
      signal: result.signal ?? undefined,
      reason,
      output: errorKind ? outputTail(`${stdout}${stderr}${result.error?.message ?? ""}`) : undefined,
    };
  };
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
  const scopes: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--changed") changed = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--include-advisory") includeAdvisory = true;
    else if (argument === "--json") json = true;
    else if (argument === "--require-clean") requireClean = true;
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
    } else throw new Error(`unknown argument: ${argument}`);
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
  };
}

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
    const startedAt = new Date().toISOString();
    const report = collectAgentContext(options.root, options.scopes, {
      changed: options.changed,
    });
    if (options.changed && !report.git.available) {
      throw new Error("--changed requires an available Git worktree");
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
      run: npmRunner(options.root, options.json, options.timeoutMs),
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
