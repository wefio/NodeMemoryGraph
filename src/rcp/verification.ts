import { execFile, spawnSync, type SpawnSyncReturns } from "node:child_process";

import type { RouteDeclaration, VerificationCheckResult } from "./types.ts";

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

export type CommandRunner = (
  command: string,
  classification: VerificationClassification,
  routes: string[],
) => Promise<VerificationCommandResult>;

export function buildRouteVerificationPlan(routes: RouteDeclaration[]): VerificationPlan {
  return {
    blocking: collectPlanItems(routes, "blocking"),
    advisory: collectPlanItems(routes, "advisory"),
  };
}

export async function executeVerificationPlan(
  plan: VerificationPlan,
  options: {
    includeAdvisory?: boolean;
    dryRun?: boolean;
    run: CommandRunner;
    parallel?: { commands: ReadonlySet<string>; concurrency: number };
  },
): Promise<VerificationRunResult> {
  const execute = async (item: VerificationPlanItem): Promise<VerificationCommandResult> => {
    if (options.dryRun) {
      return { ...item, status: "skipped", durationMs: 0, reason: "dry run" };
    }
    try {
      const result = await options.run(item.command, item.classification, item.routes);
      return { ...result, ...item };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return {
        ...item,
        status: "failed",
        durationMs: 0,
        errorKind: "runner",
        reason,
        output: outputTail(reason),
      };
    }
  };
  const results = await executeBlocking(plan.blocking, execute, options.parallel);
  if (options.includeAdvisory) {
    for (const item of plan.advisory) results.push(await execute(item));
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

async function executeBlocking(
  items: VerificationPlanItem[],
  execute: (item: VerificationPlanItem) => Promise<VerificationCommandResult>,
  parallel?: { commands: ReadonlySet<string>; concurrency: number },
): Promise<VerificationCommandResult[]> {
  const results: VerificationCommandResult[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index]!;
    if (!parallel?.commands.has(item.command)) {
      results.push(await execute(item));
      index += 1;
      continue;
    }
    const group: VerificationPlanItem[] = [];
    while (index < items.length && parallel.commands.has(items[index]!.command)) {
      group.push(items[index++]!);
    }
    const slots = new Array<VerificationCommandResult>(group.length);
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, parallel.concurrency), group.length) },
        async () => {
          while (next < group.length) {
            const slot = next++;
            slots[slot] = await execute(group[slot]!);
          }
        },
      ),
    );
    results.push(...slots);
  }
  return results;
}

export function npmCommandRunner(
  root: string,
  quiet: boolean,
  timeoutMs: number,
  remainingMs: () => number = () => timeoutMs,
  asyncCommands: ReadonlySet<string> = new Set(),
): CommandRunner {
  return async (command, classification, routes) => {
    const budget = remainingMs();
    if (budget <= 0) {
      return {
        command,
        classification,
        routes,
        status: "failed",
        durationMs: 0,
        reason: `verification exceeded ${timeoutMs}ms overall deadline`,
        errorKind: "timeout",
      };
    }
    const result = asyncCommands.has(command)
      ? await runNpmScriptCheckAsync(root, command, budget, !quiet)
      : runNpmScriptCheck(root, command, budget, !quiet);
    return {
      command,
      classification,
      routes,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      reason: result.reason,
      output: result.evidence,
      errorKind: failureKind(result.reason, result.exitCode),
    };
  };
}

function runNpmScriptCheckAsync(
  root: string,
  name: string,
  timeoutMs: number,
  streamOutput: boolean,
): Promise<VerificationCheckResult> {
  const started = performance.now();
  const { executable, args } = npmInvocation(name);
  return new Promise((resolveResult) => {
    execFile(
      executable,
      args,
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (streamOutput) streamCapturedOutput(stdout, stderr);
        const exitCode = typeof error?.code === "number" ? error.code : error ? undefined : 0;
        const reason = error
          ? error.killed && performance.now() - started >= timeoutMs - 10
            ? `command exceeded ${timeoutMs}ms timeout`
            : error.signal
              ? `command terminated by ${error.signal}`
              : error.message
          : undefined;
        resolveResult({
          name,
          status: error ? "failed" : "passed",
          durationMs: Math.round(performance.now() - started),
          exitCode,
          reason,
          evidence: error ? outputTail(`${stdout}${stderr}${error.message}`) : undefined,
        });
      },
    );
  });
}

export function runNpmScriptCheck(
  root: string,
  name: string,
  timeoutMs: number,
  streamOutput = false,
): VerificationCheckResult {
  const started = performance.now();
  const { executable, args } = npmInvocation(name);
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
  if (streamOutput) streamCapturedOutput(stdout, stderr);
  const failed = Boolean(result.error || result.signal || result.status !== 0);
  const reason = verificationFailureReason(result, timeoutMs, failed);
  return {
    name,
    status: failed ? "failed" : "passed",
    durationMs: Math.round(performance.now() - started),
    exitCode: result.status ?? undefined,
    reason,
    evidence: failed ? outputTail(`${stdout}${stderr}${result.error?.message ?? ""}`) : undefined,
  };
}

function npmInvocation(name: string): { executable: string; args: string[] } {
  const npmEntry = process.env.npm_execpath;
  if (npmEntry) return { executable: process.execPath, args: [npmEntry, "run", name] };
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `npm run ${name}`],
    };
  }
  return { executable: "npm", args: ["run", name] };
}

function streamCapturedOutput(stdout: string, stderr: string): void {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function verificationFailureReason(
  result: SpawnSyncReturns<string>,
  timeoutMs: number,
  failed: boolean,
): string | undefined {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ETIMEDOUT") return `command exceeded ${timeoutMs}ms timeout`;
  if (result.error) return result.error.message;
  if (result.signal) return `command terminated by ${result.signal}`;
  return failed ? `command exited with code ${result.status ?? "unknown"}` : undefined;
}

export function outputTail(value: string, limit = 8_000): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= limit ? text : `[truncated]\n${text.slice(-limit)}`;
}

function collectPlanItems(
  routes: RouteDeclaration[],
  classification: VerificationClassification,
): VerificationPlanItem[] {
  const commands = new Map<string, string[]>();
  for (const route of routes) {
    for (const command of route.verify[classification]) {
      const reasons = commands.get(command) ?? [];
      reasons.push(route.id);
      commands.set(command, reasons);
    }
  }
  return [...commands].map(([command, reasons]) => ({
    command,
    classification,
    routes: reasons,
  }));
}

function failureKind(
  reason: string | undefined,
  exitCode: number | undefined,
): VerificationFailureKind | undefined {
  if (!reason) return undefined;
  if (/timeout|exceeded/i.test(reason)) return "timeout";
  if (/terminated by/i.test(reason)) return "signal";
  if (exitCode !== undefined) return "exit";
  return "spawn";
}
