import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectAgentContext, type AgentContextReport } from "./repo-context.ts";
import { planNarrowVerify } from "./narrow-verify.ts";
import { compileContractFile } from "../src/rcp/contract.ts";
import { readRouteDeclarations } from "../src/rcp/planner.ts";
import {
  DefaultPolicyProvider,
  ExternalWorkspaceHarnessProvider,
  FileReceiptSink,
  LocalNpmVerifierProvider,
} from "../src/rcp/providers.ts";
import { reconcileOnce } from "../src/rcp/reconcile.ts";
import { isPathAllowed, LocalRepositoryProvider } from "../src/rcp/repository.ts";
import type { ReconciliationResult, RepositoryContractIr } from "../src/rcp/types.ts";
import {
  buildRouteVerificationPlan,
  executeVerificationPlan,
  npmCommandRunner,
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

export function discoverApplicableRcpContract(
  root: string,
  scopes: string[],
): RepositoryContractIr | null {
  if (!scopes.length) return null;
  const directory = join(root, ".rcp", "contracts");
  if (!existsSync(directory)) return null;
  const contracts = readdirSync(directory)
    .filter((name) => /\.(?:ya?ml|json)$/i.test(name))
    .sort()
    .map((name) => {
      const compiled = compileContractFile(join(directory, name));
      if (!compiled.ok || !compiled.contract) {
        const diagnostics = compiled.diagnostics.map((item) => item.message).join("; ");
        throw new Error(`invalid RCP contract ${name}: ${diagnostics || "compilation failed"}`);
      }
      return compiled.contract;
    })
    .filter((contract) => scopes.every((scope) => isPathAllowed(scope, contract.scope)));
  if (contracts.length > 1) {
    throw new Error(
      `multiple RCP contracts cover the selected scope: ${contracts.map((item) => item.id).join(", ")}`,
    );
  }
  return contracts[0] ?? null;
}

function parseArgs(args: string[]) {
  let root = process.cwd();
  let changed = false;
  let dryRun = false;
  let includeAdvisory = false;
  let json = false;
  let requireClean = false;
  let narrow = false;
  let timeoutMs = 30 * 60 * 1_000;
  let output: string | undefined;
  let help = false;
  const scopes: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--changed") changed = true;
    else if (argument === "--narrow") narrow = true;
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
    } else if (argument === "--root") root = args[++index] ?? root;
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
    narrow,
    dryRun,
    includeAdvisory,
    json,
    requireClean,
    timeoutMs,
    output: output
      ? resolve(resolvedRoot, output)
      : join(resolvedRoot, ".nmg", "verification", "latest.json"),
    scopes,
    help,
  };
}

const usage = `Usage: npm run agent:verify -- [paths...] [options]

Paths select matching verification routes directly and do not require Git.
With no paths, verification defaults to dirty Git paths.
When one RCP Contract fully and uniquely covers those paths, verification
automatically runs its workspace-ready reconciliation and records a receipt.
  --changed              derive scopes from dirty Git paths; requires Git inspection
  --scope <path>         legacy spelling for a path; positional paths are preferred
  --narrow               fast path: for a change cleanly owned by one non-shared route,
                         run that route's own tests + always-run checks instead of the
                         whole blocking suite; escalates to the full gate on shared paths
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

function formatResult(
  report: AgentContextReport,
  result: VerificationRunResult,
  rcp?: RcpEvidence,
): string {
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
  if (rcp) {
    lines.push(`RCP: ${rcp.contractId} ${rcp.status}`);
    if (rcp.receiptPath) lines.push(`RCP receipt: ${rcp.receiptPath}`);
  }
  return `${lines.join("\n")}\n`;
}

interface RcpEvidence {
  status: ReconciliationResult["status"];
  contractId: string;
  contractDigest: string;
  receiptPath?: string;
  conditions: ReconciliationResult["conditions"];
}

async function executeRcpVerification(
  report: AgentContextReport,
  contract: RepositoryContractIr,
  options: { root: string; timeoutMs: number; includeAdvisory: boolean; json: boolean },
): Promise<{ result: VerificationRunResult; rcp: RcpEvidence }> {
  const reconciliation = await reconcileOnce(
    {
      root: options.root,
      contract,
      routes: readRouteDeclarations(options.root),
      requestedMode: "apply",
      operationKey: "agent-verify",
      executionTimeoutMs: options.timeoutMs,
    },
    {
      repository: new LocalRepositoryProvider(),
      policy: new DefaultPolicyProvider(),
      harness: new ExternalWorkspaceHarnessProvider(),
      verifier: new LocalNpmVerifierProvider(options.timeoutMs, !options.json),
      receipts: new FileReceiptSink(join(options.root, ".rcp", "receipts")),
    },
  );
  const plan = buildVerificationPlan(report);
  const routesByCommand = new Map(plan.blocking.map((item) => [item.command, item.routes]));
  const blocking = (reconciliation.receipt?.checks ?? []).map((check) => ({
    command: check.name,
    classification: "blocking" as const,
    routes: routesByCommand.get(check.name) ?? reconciliation.workOrder.routes,
    status: check.status,
    exitCode: check.exitCode,
    durationMs: check.durationMs,
    reason: check.reason,
    output: check.evidence,
  }));
  const advisory = await executeVerificationPlan(
    { blocking: [], advisory: plan.advisory },
    {
      includeAdvisory: options.includeAdvisory,
      run: npmCommandRunner(options.root, options.json, options.timeoutMs),
    },
  );
  const results = [...blocking, ...advisory.results];
  return {
    result: {
      ok:
        (reconciliation.status === "verified" || reconciliation.status === "reused") &&
        advisory.ok,
      results,
    },
    rcp: {
      status: reconciliation.status,
      contractId: contract.id,
      contractDigest: contract.contractDigest,
      receiptPath: reconciliation.receiptPath,
      conditions: reconciliation.conditions,
    },
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";

/** Run an arbitrary command (npm script or node --test globs) and shape the
 *  result like the rest of the verification plan. */
function runCommand(
  label: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  classification: "blocking",
  routes: string[],
): VerificationCommandResult {
  const startedAt = Date.now();
  const child = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const ok = !child.error && !child.signal && child.status === 0;
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}${child.error?.message ?? ""}`;
  return {
    command: label,
    classification,
    routes,
    status: ok ? "passed" : "failed",
    exitCode: child.status ?? undefined,
    durationMs: Date.now() - startedAt,
    reason: ok ? undefined : child.error?.message ?? `exit ${child.status ?? "?"}`,
    output: ok ? undefined : output.slice(-8000),
  };
}

function npmArgv(name: string): string[] {
  if (process.env.npm_execpath) return [process.execPath, process.env.npm_execpath, "run", name];
  if (process.platform === "win32") return ["cmd.exe", "/d", "/s", "/c", `npm run ${name}`];
  return ["npm", "run", name];
}

/** Narrow fast path: always-run shared npm scripts, then the owning route's own
 *  tests via node --test. Returns the composed result (empty test set → shared
 *  only). */
function runNarrowVerify(
  root: string,
  plan: ReturnType<typeof planNarrowVerify>,
  timeoutMs: number,
  dryRun = false,
): VerificationRunResult {
  const route = plan.route;
  const results: VerificationCommandResult[] = [];
  const skipped = (command: string): VerificationCommandResult => ({
    command,
    classification: "blocking",
    routes: route ? [route.id] : [],
    status: "skipped",
    durationMs: 0,
    reason: "dry run",
  });
  for (const command of plan.shared) {
    results.push(
      dryRun ? skipped(command) : runCommand(command, npmArgv(command), root, timeoutMs, "blocking", route ? [route.id] : []),
    );
  }
  if (plan.testGlobs.length) {
    const label = `node --test (${route!.id})`;
    if (dryRun) {
      results.push(skipped(label));
    } else {
      const nodeArgs = [
        "--experimental-strip-types",
        "--test",
        "--test-concurrency=4",
        ...plan.testGlobs,
      ];
      results.push(
        runCommand(label, [process.execPath, ...nodeArgs], root, timeoutMs, "blocking", [route!.id]),
      );
    }
  }
  return { ok: results.every((item) => item.status !== "failed"), results };
}

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
    const contract = options.dryRun
      ? null
      : discoverApplicableRcpContract(options.root, report.scopes);
    // Narrow fast path (additive; the full gate stays the default and the
    // authority): only when the caller opts in AND the change is cleanly owned
    // by one non-shared route. Any shared/cross-cutting scope escalates to the
    // declared whole blocking set.
    const narrowPlan =
      !contract && options.narrow
        ? planNarrowVerify(report.routes, report.scopes)
        : null;
    let execution: Awaited<ReturnType<typeof executeRcpVerification>> | {
      result: VerificationRunResult;
      rcp?: undefined;
    };
    if (narrowPlan?.narrow) {
      execution = {
        result: runNarrowVerify(options.root, narrowPlan, options.timeoutMs, options.dryRun),
      };
    } else {
      if (narrowPlan && !narrowPlan.narrow && report.routes.length) {
        report.warnings.push(`--narrow escalated to full: ${narrowPlan.escalationReason}`);
      }
      execution = contract
        ? await executeRcpVerification(report, contract, options)
        : {
            result: await executeVerificationPlan(buildVerificationPlan(report), {
              includeAdvisory: options.includeAdvisory,
              dryRun: options.dryRun,
              run: npmCommandRunner(options.root, options.json, options.timeoutMs),
            }),
            rcp: undefined,
          };
    }
    const { result, rcp } = execution;
    const finishedAt = new Date().toISOString();
    const evidence = {
      schemaVersion: 1,
      runId: randomUUID(),
      startedAt,
      finishedAt,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      options: {
        changed: options.changed,
        narrow: options.narrow,
        dryRun: options.dryRun,
        includeAdvisory: options.includeAdvisory,
        requireClean: options.requireClean,
        timeoutMs: options.timeoutMs,
      },
      report,
      result,
      rcp,
    };
    persistEvidence(options.output, evidence);
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ report, ...result, rcp, evidencePath: options.output }, null, 2)}\n`
        : formatResult(report, result, rcp),
    );
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
