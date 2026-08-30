import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileContractFile } from "../contract.ts";
import { planWorkOrder, readRouteDeclarations } from "../planner.ts";
import {
  DefaultPolicyProvider,
  ExternalWorkspaceHarnessProvider,
  FileReceiptSink,
  GitHubForgeProvider,
  LocalNpmVerifierProvider,
  NmgMemoryProvider,
  ProcessHarnessProvider,
} from "../providers.ts";
import { validateReceipt } from "../receipt.ts";
import { reconcileOnce } from "../reconcile.ts";
import { LocalRepositoryProvider } from "../repository.ts";
import type { NmgMemoryClient } from "../providers.ts";
import type { RepositoryContractIr, RepositoryReceipt } from "../types.ts";

interface CliOptions {
  command: string;
  contractPath?: string;
  root: string;
  json: boolean;
  apply: boolean;
  workspaceReady: boolean;
  receiptDirectory: string;
  pullRequestNumber?: number;
  harnessCommand?: string;
  harnessArgs: string[];
  nmgMode: "disabled" | "optional" | "required";
  receiptPath?: string;
  operationKey?: string;
  baseRef: string;
  headRef?: string;
  title?: string;
  body?: string;
}

interface CliOptionState extends Omit<CliOptions, "receiptDirectory"> {
  receiptDirectory?: string;
}

export async function runRcpCli(args: string[]): Promise<number> {
  try {
    return await executeCommand(parseArgs(args));
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
}

async function executeCommand(options: CliOptions): Promise<number> {
  switch (options.command) {
    case "help":
      process.stdout.write(usage);
      return 0;
    case "receipt-verify":
      return verifyReceipt(options);
    case "forge-status":
      return observeForgeStatus(options);
    default:
      return executeContractCommand(options);
  }
}

function verifyReceipt(options: CliOptions): number {
  if (!options.receiptPath) throw new Error("receipt-verify requires a receipt path");
  const receipt = JSON.parse(readFileSync(options.receiptPath, "utf8")) as RepositoryReceipt;
  const validation = validateReceipt(receipt);
  emit(options.json, validation, validation.valid ? "receipt valid" : validation.errors.join("\n"));
  return validation.valid ? 0 : 1;
}

async function observeForgeStatus(options: CliOptions): Promise<number> {
  if (options.pullRequestNumber === undefined)
    throw new Error("forge-status requires --pr <number>");
  const observation = await new GitHubForgeProvider().observePullRequest({
    root: options.root,
    number: options.pullRequestNumber,
  });
  emit(options.json, observation, `${observation.url} ${observation.state}`);
  return 0;
}

async function executeContractCommand(options: CliOptions): Promise<number> {
  if (!options.contractPath) throw new Error(`${options.command} requires a contract path`);
  const compiled = compileContractFile(resolve(options.root, options.contractPath));
  if (!compiled.ok || !compiled.contract) {
    emit(options.json, compiled, formatDiagnostics(compiled.diagnostics));
    return 1;
  }
  switch (options.command) {
    case "compile":
      emit(options.json, compiled, `${compiled.contract.id} ${compiled.contract.contractDigest}`);
      return 0;
    case "forge-create":
      return createDraftPullRequest(options, compiled.contract);
    case "forge-bind":
      return bindPullRequest(options, compiled.contract);
    case "plan":
      return planContract(options, compiled.contract);
    case "reconcile":
      return reconcileContract(options, compiled.contract);
    default:
      throw new Error(`unknown command: ${options.command}`);
  }
}

async function createDraftPullRequest(
  options: CliOptions,
  contract: RepositoryContractIr,
): Promise<number> {
  const git = await new LocalRepositoryProvider().observe({ root: options.root, contract });
  const head = options.headRef ?? git.git.branch;
  if (!head)
    throw new Error("forge-create requires --head <branch> when Git has no current branch");
  const provider = new GitHubForgeProvider();
  if (!provider.createDraftPullRequest) throw new Error("forge provider cannot create Draft PRs");
  const observation = await provider.createDraftPullRequest({
    root: options.root,
    base: options.baseRef,
    head,
    title: options.title ?? contract.intent,
    contractId: contract.id,
    contractDigest: contract.contractDigest,
    body: options.body,
  });
  emit(options.json, observation, `${observation.url} ${observation.state}`);
  return 0;
}

async function bindPullRequest(
  options: CliOptions,
  contract: RepositoryContractIr,
): Promise<number> {
  if (options.pullRequestNumber === undefined) throw new Error("forge-bind requires --pr <number>");
  const provider = new GitHubForgeProvider();
  if (!provider.bindPullRequest) throw new Error("forge provider cannot update Contract bindings");
  const observation = await provider.bindPullRequest({
    root: options.root,
    number: options.pullRequestNumber,
    contractId: contract.id,
    contractDigest: contract.contractDigest,
    body: options.body,
  });
  emit(options.json, observation, `${observation.url} ${observation.contractDigest ?? "unbound"}`);
  return 0;
}

async function planContract(options: CliOptions, contract: RepositoryContractIr): Promise<number> {
  const repository = new LocalRepositoryProvider();
  const observation = await repository.observe({ root: options.root, contract });
  const workOrder = planWorkOrder({
    contract,
    observation,
    routes: readRouteDeclarations(options.root),
  });
  emit(options.json, { contract, observation, workOrder }, formatPlan(workOrder));
  return 0;
}

async function reconcileContract(
  options: CliOptions,
  contract: RepositoryContractIr,
): Promise<number> {
  if (options.apply && !options.workspaceReady && !options.harnessCommand) {
    throw new Error("apply requires --workspace-ready or --harness-command <executable>");
  }
  const harness = options.harnessCommand
    ? new ProcessHarnessProvider(options.harnessCommand, options.harnessArgs)
    : new ExternalWorkspaceHarnessProvider();
  const result = await reconcileOnce(
    {
      root: options.root,
      contract,
      routes: readRouteDeclarations(options.root),
      requestedMode: options.apply ? "apply" : "plan",
      pullRequestNumber: options.pullRequestNumber,
      operationKey: options.operationKey,
    },
    {
      repository: new LocalRepositoryProvider(),
      policy: new DefaultPolicyProvider(),
      harness,
      verifier: new LocalNpmVerifierProvider(),
      receipts: new FileReceiptSink(options.receiptDirectory),
      memory: memoryProvider(options.nmgMode, options.root),
      forge: options.pullRequestNumber === undefined ? undefined : new GitHubForgeProvider(),
    },
  );
  emit(options.json, result, formatResult(result));
  if (result.status === "blocked") return 2;
  return result.status === "failed" ? 1 : 0;
}

function parseArgs(args: string[]): CliOptions {
  const state = defaultCliOptionState(args[0] ?? "help");
  for (let index = 1; index < args.length; index += 1) {
    index = consumeArgument(args, index, state);
  }
  return resolveCliOptions(state);
}

function defaultCliOptionState(command: string): CliOptionState {
  return {
    command,
    root: process.cwd(),
    json: false,
    apply: false,
    workspaceReady: false,
    harnessArgs: [],
    nmgMode: "disabled",
    baseRef: "main",
  };
}

const flagOptionHandlers: Record<string, (state: CliOptionState) => void> = {
  "--json": (state) => (state.json = true),
  "--apply": (state) => (state.apply = true),
  "--workspace-ready": (state) => (state.workspaceReady = true),
};

const valueOptionHandlers: Record<
  string,
  (state: CliOptionState, value: string | undefined) => void
> = {
  "--root": (state, value) => (state.root = value ?? state.root),
  "--receipt-dir": (state, value) => (state.receiptDirectory = value),
  "--operation-key": (state, value) => (state.operationKey = value),
  "--base": (state, value) => (state.baseRef = value ?? state.baseRef),
  "--head": (state, value) => (state.headRef = value),
  "--title": (state, value) => (state.title = value),
  "--body": (state, value) => (state.body = value),
  "--harness-command": (state, value) => (state.harnessCommand = value),
  "--harness-arg": (state, value) => state.harnessArgs.push(value ?? ""),
};

function consumeArgument(args: string[], index: number, state: CliOptionState): number {
  const argument = args[index]!;
  const flagHandler = flagOptionHandlers[argument];
  if (flagHandler) {
    flagHandler(state);
    return index;
  }
  const valueHandler = valueOptionHandlers[argument];
  if (valueHandler) {
    valueHandler(state, args[index + 1]);
    return index + 1;
  }
  if (argument === "--pr") return consumePullRequestNumber(args, index, state);
  if (argument === "--nmg") return consumeNmgMode(args, index, state);
  if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
  if (state.command === "receipt-verify") state.receiptPath ??= argument;
  else state.contractPath ??= argument;
  return index;
}

function consumePullRequestNumber(args: string[], index: number, state: CliOptionState): number {
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("--pr requires a positive integer");
  }
  state.pullRequestNumber = value;
  return index + 1;
}

function consumeNmgMode(args: string[], index: number, state: CliOptionState): number {
  const value = args[index + 1];
  if (value !== "disabled" && value !== "optional" && value !== "required") {
    throw new Error("--nmg must be disabled, optional or required");
  }
  state.nmgMode = value;
  return index + 1;
}

function resolveCliOptions(state: CliOptionState): CliOptions {
  const root = resolve(state.root);
  return {
    ...state,
    root,
    receiptDirectory: resolve(root, state.receiptDirectory ?? ".rcp/receipts"),
    receiptPath: state.receiptPath ? resolve(root, state.receiptPath) : undefined,
  };
}

function memoryProvider(mode: CliOptions["nmgMode"], root: string): NmgMemoryProvider | undefined {
  if (mode === "disabled") return undefined;
  const client: NmgMemoryClient = {
    recall: async (query) => {
      const result = runNmg(root, [
        "search",
        query,
        "--project-dir",
        root,
        "--limit",
        "4",
        "--max-tier",
        "1",
        "--compact-json",
      ]);
      const parsed = JSON.parse(result) as {
        candidates?: Array<{ id?: string; statement?: string }>;
      };
      return (parsed.candidates ?? []).map(
        (candidate) => candidate.statement ?? candidate.id ?? "",
      );
    },
    notify: async (event) => {
      runNmg(root, [
        "board",
        "put",
        "repo-development",
        event.content,
        "--agent",
        "repository-control-plane",
        "--kind",
        "result",
        "--ttl-seconds",
        "86400",
        "--json",
      ]);
    },
  };
  if (mode === "required") {
    const result = spawnSync("nmg", ["daemon", "status", "--json"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error("required NMG provider is unavailable");
  }
  return new NmgMemoryProvider(client);
}

function runNmg(root: string, args: string[]): string {
  const result = spawnSync("nmg", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      result.error?.message ?? result.stderr.trim() ?? `nmg exited with ${result.status}`,
    );
  }
  return result.stdout;
}

function emit(json: boolean, value: unknown, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

function formatDiagnostics(
  diagnostics: Array<{ source: { path: string; line?: number }; message: string }>,
): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.source.path}${diagnostic.source.line ? `:${diagnostic.source.line}` : ""}: ${diagnostic.message}`,
    )
    .join("\n");
}

function formatPlan(order: {
  id: string;
  intent: string;
  allowedPaths: string[];
  verificationChecks: string[];
}): string {
  return [
    `${order.id}: ${order.intent}`,
    `scope: ${order.allowedPaths.join(", ")}`,
    `checks: ${order.verificationChecks.join(", ")}`,
  ].join("\n");
}

function formatResult(result: {
  status: string;
  workOrder: { id: string };
  receiptPath?: string;
  conditions: Array<{ type: string; status: string; reason: string }>;
}): string {
  return [
    `${result.workOrder.id}: ${result.status}`,
    ...result.conditions.map(
      (condition) => `${condition.type}=${condition.status}: ${condition.reason}`,
    ),
    ...(result.receiptPath ? [`receipt: ${result.receiptPath}`] : []),
  ].join("\n");
}

const usage = `Usage: nmg-rcp <command> [contract] [options]

Commands:
  compile <contract>       validate and normalize a repository Contract
  plan <contract>          observe the repository and emit a bounded WorkOrder
  reconcile <contract>     plan by default; use --apply to verify an executed change
  receipt-verify <path>    validate an immutable receipt
  forge-status --pr <n>    observe a GitHub pull request
  forge-create <contract>  create a Contract-bound Draft pull request
  forge-bind <contract>    update an existing pull request Contract binding

Options:
  --root <path>            repository root
  --json                   machine-readable output
  --apply                  execute the apply/verify/receipt phase
  --workspace-ready        treat the current workspace as the Agent result
  --harness-command <exe>  execute an external harness that consumes WorkOrder JSON
  --harness-arg <value>    repeatable external harness argument
  --receipt-dir <path>     append-only receipt directory (default .rcp/receipts)
  --pr <number>            bind verification to a GitHub pull-request head
  --operation-key <key>    distinguish independent idempotent reconciliation phases
  --base <branch>          Draft PR base branch (default main)
  --head <branch>          Draft PR head branch (default current branch)
  --title <text>           Draft PR title (default Contract intent)
  --body <text>            optional prose before the machine Contract binding
  --nmg <mode>             disabled (default), optional, or required
`;

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRcpCli(process.argv.slice(2));
}
