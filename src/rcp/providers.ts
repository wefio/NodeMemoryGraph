import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, digestCanonical } from "./canonical.ts";
import { validateReceipt } from "./receipt.ts";
import { digestRepositoryPaths } from "./repository.ts";
import type {
  ForgeObservation,
  HarnessResult,
  ProviderDescriptor,
  RepositoryContractIr,
  ReconciliationAttempt,
  RepositoryReceipt,
  VerificationCheckResult,
  VerificationEvidence,
  WorkOrder,
} from "./types.ts";
import { runNpmScriptCheck } from "./verification.ts";

export interface HarnessProvider {
  readonly descriptor: ProviderDescriptor;
  execute(workOrder: WorkOrder): Promise<HarnessResult>;
}

export interface VerifierProvider {
  readonly descriptor: ProviderDescriptor;
  definitionDigest(request: {
    root: string;
    contract: RepositoryContractIr;
    workOrder: WorkOrder;
  }): Promise<string>;
  verify(request: {
    root: string;
    contract: RepositoryContractIr;
    workOrder: WorkOrder;
  }): Promise<VerificationEvidence>;
}

export interface PolicyProvider {
  readonly descriptor: ProviderDescriptor;
  evaluate(input: {
    contract: RepositoryContractIr;
    workOrder: WorkOrder;
    requestedMode: "plan" | "apply";
  }): { allowed: boolean; reason: string };
}

export interface ReceiptSink {
  readonly descriptor: ProviderDescriptor;
  find(operationIdentity: string): Promise<{ receipt: RepositoryReceipt; path?: string } | null>;
  append(receipt: RepositoryReceipt): Promise<{ path?: string }>;
  scan(): Promise<ReceiptScanEntry[]>;
  findIncomplete(attemptKey: string): Promise<ReconciliationAttempt | null>;
  beginAttempt(attempt: ReconciliationAttempt): Promise<{ path?: string }>;
  completeAttempt(attemptKey: string): Promise<void>;
}

export interface ReceiptScanEntry {
  path: string;
  valid: boolean;
  errors: string[];
  receipt?: RepositoryReceipt;
}

export interface MemoryProvider {
  readonly descriptor: ProviderDescriptor;
  recall?(input: { contract: RepositoryContractIr; workOrder: WorkOrder }): Promise<string[]>;
  notify?(input: { receipt: RepositoryReceipt }): Promise<void>;
}

export interface ForgeProvider {
  readonly descriptor: ProviderDescriptor;
  observePullRequest(input: { root: string; number: number }): Promise<ForgeObservation>;
  createDraftPullRequest?(input: {
    root: string;
    base: string;
    head: string;
    title: string;
    contractId: string;
    contractDigest: string;
    body?: string;
  }): Promise<ForgeObservation>;
  bindPullRequest?(input: {
    root: string;
    number: number;
    contractId: string;
    contractDigest: string;
    body?: string;
  }): Promise<ForgeObservation>;
}

export class DefaultPolicyProvider implements PolicyProvider {
  readonly descriptor: ProviderDescriptor = {
    id: "default-policy",
    version: "1",
    capabilities: ["authority-gate", "fail-closed-operations"],
    operations: ["evaluate"],
    authority: ["plan", "apply", "continuous"],
  };

  evaluate(input: {
    contract: RepositoryContractIr;
    workOrder: WorkOrder;
    requestedMode: "plan" | "apply";
  }): { allowed: boolean; reason: string } {
    if (input.requestedMode === "apply" && input.contract.authority.mode === "plan") {
      return { allowed: false, reason: "contract authority is plan-only" };
    }
    if (!input.workOrder.verificationChecks.length) {
      return { allowed: false, reason: "work order has no independent verification checks" };
    }
    return { allowed: true, reason: "contract authority and verification requirements satisfied" };
  }
}

export class ExternalWorkspaceHarnessProvider implements HarnessProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(id = "external-workspace", version = "1") {
    this.descriptor = {
      id,
      version,
      capabilities: ["consume-work-order", "report-existing-workspace"],
      operations: ["execute"],
      authority: ["apply"],
    };
  }

  async execute(workOrder: WorkOrder): Promise<HarnessResult> {
    return {
      provider: this.descriptor,
      status: "completed",
      summary: `workspace is ready for independent verification of ${workOrder.id}`,
      artifacts: ["workspace"],
    };
  }
}

export class ProcessHarnessProvider implements HarnessProvider {
  readonly descriptor: ProviderDescriptor;
  readonly executable: string;
  readonly args: string[];
  readonly timeoutMs: number;
  readonly cwd?: string;

  constructor(
    executable: string,
    args: string[] = [],
    id = "process-harness",
    version = "1",
    timeoutMs = 30 * 60 * 1_000,
    cwd?: string,
  ) {
    this.executable = executable;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.cwd = cwd;
    this.descriptor = {
      id,
      version,
      capabilities: ["consume-work-order", "bounded-process-execution"],
      operations: ["execute"],
      authority: ["apply"],
    };
  }

  async execute(workOrder: WorkOrder): Promise<HarnessResult> {
    const timeoutMs = Math.min(this.timeoutMs, workOrder.budget.timeoutMs);
    const result = spawnSync(this.executable, this.args, {
      encoding: "utf8",
      input: `${JSON.stringify(workOrder)}\n`,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      cwd: this.cwd,
    });
    const failed = result.error || result.signal || result.status !== 0;
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return {
      provider: this.descriptor,
      status: failed ? "failed" : "completed",
      summary: failed
        ? timedOut
          ? `harness timed out after ${timeoutMs}ms`
          : (result.error?.message ??
            (result.signal
              ? `harness terminated by ${result.signal}`
              : `harness exited with ${result.status}`))
        : result.stdout.trim() || `harness completed ${workOrder.id}`,
      diagnostics: result.stderr.trim() ? [result.stderr.trim()] : [],
      artifacts: failed ? [] : ["workspace"],
    };
  }
}

export class LocalNpmVerifierProvider implements VerifierProvider {
  readonly descriptor: ProviderDescriptor = {
    id: "local-npm-verifier",
    version: "1",
    capabilities: ["npm-script-verification", "command-provenance"],
    operations: ["verify"],
    authority: ["plan", "apply", "continuous"],
  };

  readonly timeoutMs: number;
  readonly streamOutput: boolean;

  constructor(timeoutMs = 30 * 60 * 1_000, streamOutput = false) {
    this.timeoutMs = timeoutMs;
    this.streamOutput = streamOutput;
  }

  async definitionDigest(request: {
    root: string;
    contract: RepositoryContractIr;
    workOrder: WorkOrder;
  }): Promise<string> {
    const scripts = readPackageScripts(request.root);
    return verifierDefinitionDigest(
      request.root,
      this.descriptor,
      request.workOrder.verificationChecks,
      scripts,
    );
  }

  async verify(request: {
    root: string;
    contract: RepositoryContractIr;
    workOrder: WorkOrder;
  }): Promise<VerificationEvidence> {
    const scripts = readPackageScripts(request.root);
    const verifierDigest = verifierDefinitionDigest(
      request.root,
      this.descriptor,
      request.workOrder.verificationChecks,
      scripts,
    );
    const checks: VerificationCheckResult[] = [];
    for (const name of request.workOrder.verificationChecks) {
      const definition = scripts[name];
      if (!definition) {
        checks.push({
          name,
          status: "failed",
          durationMs: 0,
          reason: `missing npm script: ${name}`,
        });
        continue;
      }
      checks.push(runNpmScriptCheck(request.root, name, this.timeoutMs, this.streamOutput));
    }
    return {
      provider: this.descriptor,
      verifierDigest,
      ok: checks.every((check) => check.status === "passed"),
      checks,
    };
  }
}

export class FileReceiptSink implements ReceiptSink {
  readonly descriptor: ProviderDescriptor = {
    id: "file-receipt-sink",
    version: "1",
    capabilities: ["append-only-receipts", "operation-identity-lookup"],
    operations: ["find", "append", "scan", "findIncomplete", "beginAttempt", "completeAttempt"],
    authority: ["plan", "apply", "continuous"],
  };

  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async find(
    operationIdentity: string,
  ): Promise<{ receipt: RepositoryReceipt; path?: string } | null> {
    if (!existsSync(this.directory)) return null;
    const prefix = `${this.operationDigest(operationIdentity)}-`;
    const matches = readdirSync(this.directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .sort()
      .reverse();
    for (const name of matches) {
      const path = join(resolve(this.directory), name);
      const inspected = this.inspect(path);
      if (!inspected.valid || !inspected.receipt) {
        throw new Error(`invalid receipt ${path}: ${inspected.errors.join("; ")}`);
      }
      const receipt = inspected.receipt;
      if (receipt.operationIdentity === operationIdentity && receipt.decision === "verified") {
        return { receipt, path };
      }
    }
    return null;
  }

  async append(receipt: RepositoryReceipt): Promise<{ path?: string }> {
    const validation = validateReceipt(receipt);
    if (!validation.valid) {
      throw new Error(`refusing to append invalid receipt: ${validation.errors.join("; ")}`);
    }
    const path = this.path(receipt.operationIdentity, receipt.receiptId);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, "utf8")) as RepositoryReceipt;
      if (canonicalJson(existing) === canonicalJson(receipt)) return { path };
      throw new Error(`receipt identity collision: ${receipt.receiptId}`);
    }
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
    return { path };
  }

  async scan(): Promise<ReceiptScanEntry[]> {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => this.inspect(join(resolve(this.directory), name)));
  }

  async findIncomplete(attemptKey: string): Promise<ReconciliationAttempt | null> {
    const path = this.attemptPath(attemptKey);
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as ReconciliationAttempt;
    if (
      value.attemptSchema !== "repository.attempt/v1alpha1" ||
      value.attemptKey !== attemptKey ||
      !value.operationIdentity ||
      !value.workOrderId ||
      !value.verifierDigest
    ) {
      throw new Error(`invalid in-flight attempt journal: ${path}`);
    }
    return value;
  }

  async beginAttempt(attempt: ReconciliationAttempt): Promise<{ path?: string }> {
    const path = this.attemptPath(attempt.attemptKey);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, "utf8")) as ReconciliationAttempt;
      if (canonicalJson(existing) === canonicalJson(attempt)) return { path };
      throw new Error(`in-flight attempt already exists: ${attempt.attemptKey}`);
    }
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(attempt, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
    return { path };
  }

  async completeAttempt(attemptKey: string): Promise<void> {
    const path = this.attemptPath(attemptKey);
    if (!existsSync(path)) return;
    unlinkSync(path);
  }

  private operationDigest(operationIdentity: string): string {
    return createHash("sha256").update(operationIdentity).digest("hex");
  }

  private path(operationIdentity: string, receiptId: string): string {
    const operation = this.operationDigest(operationIdentity);
    const receipt = createHash("sha256").update(receiptId).digest("hex");
    return join(resolve(this.directory), `${operation}-${receipt}.json`);
  }

  private attemptPath(attemptKey: string): string {
    const key = createHash("sha256").update(attemptKey).digest("hex");
    return join(resolve(this.directory), "inflight", `${key}.json`);
  }

  private inspect(path: string): ReceiptScanEntry {
    try {
      const receipt = JSON.parse(readFileSync(path, "utf8")) as RepositoryReceipt;
      const validation = validateReceipt(receipt);
      const expectedName = basename(this.path(receipt.operationIdentity, receipt.receiptId));
      const errors = [...validation.errors];
      if (basename(path) !== expectedName) errors.push("receipt filename does not match identity");
      return { path, valid: errors.length === 0, errors, receipt };
    } catch (cause) {
      return {
        path,
        valid: false,
        errors: [cause instanceof Error ? cause.message : String(cause)],
      };
    }
  }
}

export interface NmgMemoryClient {
  recall?(query: string): Promise<string[]>;
  notify?(event: { kind: string; content: string }): Promise<void>;
}

export class NmgMemoryProvider implements MemoryProvider {
  readonly descriptor: ProviderDescriptor = {
    id: "nmg-memory-adapter",
    version: "1",
    capabilities: ["optional-recall", "optional-coordination"],
    operations: ["recall", "notify"],
    authority: ["plan", "apply", "continuous"],
  };

  readonly client: NmgMemoryClient;

  constructor(client: NmgMemoryClient) {
    this.client = client;
  }

  async recall(input: { contract: RepositoryContractIr; workOrder: WorkOrder }): Promise<string[]> {
    if (!this.client.recall) return [];
    return this.client.recall(`${input.contract.intent}\n${input.workOrder.preserve.join("\n")}`);
  }

  async notify(input: { receipt: RepositoryReceipt }): Promise<void> {
    if (!this.client.notify) return;
    await this.client.notify({
      kind: "repository-receipt",
      content: `${input.receipt.contractId}:${input.receipt.decision}:${input.receipt.commit ?? "worktree"}`,
    });
  }
}

export class GitHubForgeProvider implements ForgeProvider {
  readonly descriptor: ProviderDescriptor = {
    id: "github-cli-forge",
    version: "1",
    capabilities: [
      "pull-request-observation",
      "draft-pull-request-creation",
      "contract-binding-update",
    ],
    operations: ["observePullRequest", "createDraftPullRequest", "bindPullRequest"],
    authority: ["plan", "apply", "continuous"],
  };
  readonly runner: (root: string, args: string[]) => string;

  constructor(runner: (root: string, args: string[]) => string = runGh) {
    this.runner = runner;
  }

  async observePullRequest(input: { root: string; number: number }): Promise<ForgeObservation> {
    const result = this.runner(input.root, [
      "pr",
      "view",
      String(input.number),
      "--json",
      "number,url,state,isDraft,headRefName,baseRefName,headRefOid,body,statusCheckRollup",
    ]);
    return forgeObservation(this.descriptor, JSON.parse(result) as GhPullRequest);
  }

  async createDraftPullRequest(input: {
    root: string;
    base: string;
    head: string;
    title: string;
    contractId: string;
    contractDigest: string;
    body?: string;
  }): Promise<ForgeObservation> {
    const body = forgeBindingBody(input.contractId, input.contractDigest, input.body);
    const url = this.runner(input.root, [
      "pr",
      "create",
      "--draft",
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      body,
    ]).trim();
    const result = this.runner(input.root, [
      "pr",
      "view",
      url,
      "--json",
      "number,url,state,isDraft,headRefName,baseRefName,headRefOid,body,statusCheckRollup",
    ]);
    return forgeObservation(this.descriptor, JSON.parse(result) as GhPullRequest);
  }

  async bindPullRequest(input: {
    root: string;
    number: number;
    contractId: string;
    contractDigest: string;
    body?: string;
  }): Promise<ForgeObservation> {
    const current = JSON.parse(
      this.runner(input.root, [
        "pr",
        "view",
        String(input.number),
        "--json",
        "number,url,state,isDraft,headRefName,baseRefName,headRefOid,body,statusCheckRollup",
      ]),
    ) as GhPullRequest;
    const body = forgeBindingBody(
      input.contractId,
      input.contractDigest,
      input.body ?? current.body ?? "",
    );
    this.runner(input.root, ["pr", "edit", String(input.number), "--body", body]);
    const result = this.runner(input.root, [
      "pr",
      "view",
      String(input.number),
      "--json",
      "number,url,state,isDraft,headRefName,baseRefName,headRefOid,body,statusCheckRollup",
    ]);
    return forgeObservation(this.descriptor, JSON.parse(result) as GhPullRequest);
  }
}

interface GhPullRequest {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  body?: string;
  statusCheckRollup?: Array<{
    name?: string;
    status?: string;
    conclusion?: string;
    context?: string;
    state?: string;
  }>;
}

function forgeObservation(provider: ProviderDescriptor, value: GhPullRequest): ForgeObservation {
  const binding = parseForgeBinding(value.body ?? "");
  return {
    provider,
    number: value.number,
    url: value.url,
    state: value.state,
    isDraft: value.isDraft,
    headRef: value.headRefName,
    baseRef: value.baseRefName,
    headCommit: value.headRefOid,
    contractId: binding.contractId,
    contractDigest: binding.contractDigest,
    checks: (value.statusCheckRollup ?? []).map((check) => ({
      name: check.name ?? check.context ?? "unknown",
      status: check.status ?? check.state ?? "UNKNOWN",
      conclusion: check.conclusion,
    })),
  };
}

export function forgeBindingBody(contractId: string, contractDigest: string, body = ""): string {
  const binding = [
    "<!-- nmg-rcp-binding",
    `contract-id: ${contractId}`,
    `contract-digest: ${contractDigest}`,
    "-->",
  ].join("\n");
  const prose = body.replace(/<!--\s*nmg-rcp-binding\s+[\s\S]*?-->\s*/gi, "").trim();
  return prose ? `${prose}\n\n${binding}\n` : `${binding}\n`;
}

function parseForgeBinding(body: string): { contractId?: string; contractDigest?: string } {
  const block = body.match(/<!--\s*nmg-rcp-binding\s+([\s\S]*?)-->/i)?.[1] ?? "";
  const contractId = block.match(/^\s*contract-id:\s*(\S+)\s*$/im)?.[1];
  const contractDigest = block.match(/^\s*contract-digest:\s*(sha256:[a-f0-9]+)\s*$/im)?.[1];
  return { contractId, contractDigest };
}

function runGh(root: string, args: string[]): string {
  const result = spawnSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      result.error?.message ?? result.stderr.trim() ?? `gh exited with ${result.status}`,
    );
  }
  return result.stdout;
}

function readPackageScripts(root: string): Record<string, string> {
  const packageJson = JSON.parse(readFileSync(join(resolve(root), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

function verifierDefinitionDigest(
  root: string,
  provider: ProviderDescriptor,
  checks: string[],
  scripts: Record<string, string>,
): string {
  const definitions = checks.map((name) => [name, scripts[name] ?? null]);
  const repositoryInputs = digestRepositoryPaths(root, [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ]);
  return digestCanonical({
    provider,
    definitions,
    repositoryInputs,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
  });
}
