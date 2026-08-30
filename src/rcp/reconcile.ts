import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";

import { operationIdentity, planWorkOrder } from "./planner.ts";
import type {
  ForgeProvider,
  HarnessProvider,
  MemoryProvider,
  PolicyProvider,
  ReceiptSink,
  VerifierProvider,
} from "./providers.ts";
import { receiptId } from "./receipt.ts";
import {
  changedPaths,
  isPathAllowed,
  normalizeRepositoryPath,
  type RepositoryProvider,
} from "./repository.ts";
import type {
  ForgeObservation,
  HarnessResult,
  ObservedRepository,
  ReconciliationCondition,
  ReconciliationResult,
  RepositoryContractIr,
  RepositoryReceipt,
  RouteDeclaration,
  VerificationEvidence,
  WorkOrder,
} from "./types.ts";

export interface ControlPlaneProviders {
  repository: RepositoryProvider;
  policy: PolicyProvider;
  harness: HarnessProvider;
  verifier: VerifierProvider;
  receipts: ReceiptSink;
  memory?: MemoryProvider;
  forge?: ForgeProvider;
}

export interface ReconcileRequest {
  root: string;
  contract: RepositoryContractIr;
  routes: RouteDeclaration[];
  requestedMode?: "plan" | "apply";
  operationKey?: string;
  pullRequestNumber?: number;
  now?: () => Date;
  invocationId?: string;
}

interface PreparedReconciliation {
  now: () => Date;
  invocationId: string;
  conditions: ReconciliationCondition[];
  before: ObservedRepository;
  workOrder: WorkOrder;
  memoryDiagnostics: string[];
  identity: string;
}

export async function reconcileOnce(
  request: ReconcileRequest,
  providers: ControlPlaneProviders,
): Promise<ReconciliationResult> {
  const prepared = await prepareReconciliation(request, providers);
  if ("status" in prepared) return prepared;
  return applyReconciliation(request, providers, prepared);
}

async function prepareReconciliation(
  request: ReconcileRequest,
  providers: ControlPlaneProviders,
): Promise<PreparedReconciliation | ReconciliationResult> {
  const now = request.now ?? (() => new Date());
  const invocationId = request.invocationId ?? randomUUID();
  const conditions: ReconciliationCondition[] = [
    { type: "Compiled", status: "true", reason: "contract IR is valid" },
  ];
  const before = await providers.repository.observe({
    root: request.root,
    contract: request.contract,
  });
  conditions.push({
    type: "Observed",
    status: before.git.available ? "true" : "false",
    reason: before.git.available ? "repository observed" : (before.git.error ?? "Git unavailable"),
  });
  const workOrder = planWorkOrder({
    contract: request.contract,
    observation: before,
    routes: request.routes,
    operationKey: request.operationKey,
  });
  const memoryDiagnostics = await recallMemory(providers.memory, request.contract, workOrder);
  const requestedMode = request.requestedMode ?? "plan";
  const authorization = providers.policy.evaluate({
    contract: request.contract,
    workOrder,
    requestedMode,
  });
  conditions.push({
    type: "Authorized",
    status: authorization.allowed ? "true" : "false",
    reason: authorization.reason,
  });
  if (!authorization.allowed) {
    return {
      status: "blocked",
      contract: request.contract,
      observation: before,
      workOrder,
      conditions,
      memoryDiagnostics,
    };
  }
  if (requestedMode === "plan") {
    conditions.push({
      type: "Executed",
      status: "unknown",
      reason: "plan mode performs no mutation",
    });
    return {
      status: "planned",
      contract: request.contract,
      observation: before,
      workOrder,
      conditions,
      memoryDiagnostics,
    };
  }

  const identity = operationIdentity(workOrder);
  const existing = await providers.receipts.find(identity);
  if (existing) {
    conditions.push(
      { type: "Executed", status: "true", reason: "existing operation receipt reused" },
      {
        type: "Verified",
        status: existing.receipt.decision === "verified" ? "true" : "false",
        reason: `existing receipt decision: ${existing.receipt.decision}`,
      },
      { type: "Recorded", status: "true", reason: "append-only receipt already exists" },
    );
    return {
      status: "reused",
      contract: request.contract,
      observation: before,
      workOrder,
      conditions,
      receipt: existing.receipt,
      receiptPath: existing.path,
      memoryDiagnostics,
    };
  }

  return { now, invocationId, conditions, before, workOrder, memoryDiagnostics, identity };
}

async function applyReconciliation(
  request: ReconcileRequest,
  providers: ControlPlaneProviders,
  prepared: PreparedReconciliation,
): Promise<ReconciliationResult> {
  const { now, invocationId, conditions, before, workOrder, memoryDiagnostics, identity } =
    prepared;
  const verifierDigestBefore = await providers.verifier.definitionDigest({
    root: request.root,
    contract: request.contract,
    workOrder,
  });
  const startedAt = now().toISOString();
  const harness = await providers.harness.execute(workOrder);
  conditions.push({
    type: "Executed",
    status: harness.status === "completed" ? "true" : "false",
    reason: harness.summary,
  });
  const after = await providers.repository.observe({
    root: request.root,
    contract: request.contract,
  });
  const actual = submittedPaths(request.root, request.contract, before, after, harness);
  const scopeMatched = actual.every((path) => isPathAllowed(path, request.contract.scope));
  const verification = await providers.verifier.verify({
    root: request.root,
    contract: request.contract,
    workOrder,
  });
  const verifierStable = verifierDigestBefore === verification.verifierDigest;
  const forge = await observeForge(request, providers.forge);
  const forgeFailures = validateForge(forge, request.contract, after.git.commit);
  const diagnostics = reconciliationDiagnostics({
    before,
    after,
    harness,
    scopeMatched,
    verifierStable,
    forgeFailures,
  });
  const forgeMatched = forgeFailures.length === 0;
  const decision = receiptDecision(
    harness,
    verification,
    verifierStable,
    scopeMatched,
    forgeMatched,
  );
  conditions.push({
    type: "Verified",
    status: decision === "verified" ? "true" : "false",
    reason:
      decision === "verified"
        ? "independent checks, scope and forge identity are satisfied"
        : `verification decision: ${decision}`,
  });
  const receipt = buildReceipt({
    identity,
    contract: request.contract,
    before,
    after,
    invocationId,
    startedAt,
    finishedAt: now().toISOString(),
    harness,
    verification,
    actual,
    scopeMatched,
    forge,
    decision,
    diagnostics,
  });
  const stored = await providers.receipts.append(receipt);
  conditions.push({ type: "Recorded", status: "true", reason: "append-only receipt recorded" });
  memoryDiagnostics.push(...(await notifyMemory(providers.memory, receipt)));
  return {
    status: decision,
    contract: request.contract,
    observation: after,
    workOrder,
    conditions,
    receipt,
    receiptPath: stored.path,
    memoryDiagnostics,
  };
}

function reconciliationDiagnostics(input: {
  before: ObservedRepository;
  after: ObservedRepository;
  harness: HarnessResult;
  scopeMatched: boolean;
  verifierStable: boolean;
  forgeFailures: string[];
}): string[] {
  const diagnostics = [
    ...input.before.diagnostics,
    ...input.after.diagnostics,
    ...(input.harness.diagnostics ?? []),
  ];
  if (!input.scopeMatched)
    diagnostics.push("one or more changed files fall outside declared scope");
  if (!input.verifierStable) {
    diagnostics.push("verification definitions changed during harness execution");
  }
  diagnostics.push(...input.forgeFailures);
  return diagnostics;
}

async function recallMemory(
  memory: MemoryProvider | undefined,
  contract: RepositoryContractIr,
  workOrder: WorkOrder,
): Promise<string[]> {
  if (!memory?.recall) return [];
  try {
    await memory.recall({ contract, workOrder });
    return [];
  } catch (cause) {
    return [`memory recall degraded: ${errorMessage(cause)}`];
  }
}

async function notifyMemory(
  memory: MemoryProvider | undefined,
  receipt: RepositoryReceipt,
): Promise<string[]> {
  if (!memory?.notify) return [];
  try {
    await memory.notify({ receipt });
    return [];
  } catch (cause) {
    return [`memory notification degraded: ${errorMessage(cause)}`];
  }
}

function submittedPaths(
  root: string,
  contract: RepositoryContractIr,
  before: ObservedRepository,
  after: ObservedRepository,
  harness: HarnessResult,
): string[] {
  // An external-workspace harness reports work that already exists when apply
  // starts, so before/after content comparison alone would certify an empty
  // change. In that mode every current dirty path is part of the submitted
  // workspace and must pass the Contract scope gate. Process harnesses retain
  // delta attribution because the control plane observes them before execution.
  const contractInputPath = repositoryContractPath(root, contract.source.path);
  const submittedWorkspace = harness.provider.capabilities.includes("report-existing-workspace")
    ? after.git.dirtyFiles.filter((path) => path !== contractInputPath)
    : after.git.dirtyFiles.filter((path) => !before.git.dirtyFiles.includes(path));
  return [...new Set([...changedPaths(before, after), ...submittedWorkspace])].sort((left, right) =>
    left.localeCompare(right),
  );
}

async function observeForge(
  request: ReconcileRequest,
  forge: ForgeProvider | undefined,
): Promise<ForgeObservation | undefined> {
  if (!forge || request.pullRequestNumber === undefined) return undefined;
  return forge.observePullRequest({ root: request.root, number: request.pullRequestNumber });
}

function validateForge(
  forge: ForgeObservation | undefined,
  contract: RepositoryContractIr,
  commit: string | undefined,
): string[] {
  if (!forge) return [];
  const failures: string[] = [];
  if (commit && forge.headCommit !== commit) {
    failures.push("pull request head does not match the locally verified commit");
  }
  if (forge.contractId !== contract.id || forge.contractDigest !== contract.contractDigest) {
    failures.push("pull request body is not bound to the verified Contract identity");
  }
  if (!contract.verification.forgeChecks.length) {
    failures.push("Contract declares no required forge checks");
  }
  for (const name of contract.verification.forgeChecks) {
    const check = forge.checks.find((candidate) => candidate.name === name);
    if (!check) {
      failures.push(`required pull request check is missing: ${name}`);
    } else if (!forgeCheckPassed(check)) {
      failures.push(`required pull request check is pending or unsuccessful: ${name}`);
    }
  }
  return failures;
}

function receiptDecision(
  harness: HarnessResult,
  verification: VerificationEvidence,
  verifierStable: boolean,
  scopeMatched: boolean,
  forgeMatched: boolean,
): RepositoryReceipt["decision"] {
  if (harness.status === "blocked") return "blocked";
  return harness.status === "completed" &&
    verification.ok &&
    verifierStable &&
    scopeMatched &&
    forgeMatched
    ? "verified"
    : "failed";
}

interface BuildReceiptInput {
  identity: string;
  contract: RepositoryContractIr;
  before: ObservedRepository;
  after: ObservedRepository;
  invocationId: string;
  startedAt: string;
  finishedAt: string;
  harness: HarnessResult;
  verification: VerificationEvidence;
  actual: string[];
  scopeMatched: boolean;
  forge: ForgeObservation | undefined;
  decision: RepositoryReceipt["decision"];
  diagnostics: string[];
}

function buildReceipt(input: BuildReceiptInput): RepositoryReceipt {
  const partial: Omit<RepositoryReceipt, "receiptId"> = {
    receiptSchema: "repository.receipt/v1alpha1",
    operationIdentity: input.identity,
    contractId: input.contract.id,
    contractDigest: input.contract.contractDigest,
    observedRevisionBefore: input.before.observedRevision,
    observedRevisionAfter: input.after.observedRevision,
    commit: input.after.git.commit,
    invocationId: input.invocationId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    harness: {
      id: input.harness.provider.id,
      version: input.harness.provider.version,
      status: input.harness.status,
      summary: input.harness.summary,
    },
    verifier: {
      id: input.verification.provider.id,
      version: input.verification.provider.version,
      digest: input.verification.verifierDigest,
    },
    scope: {
      declared: input.contract.scope.include,
      excluded: input.contract.scope.exclude,
      actual: input.actual,
      matched: input.scopeMatched,
    },
    checks: input.verification.checks,
    forge: input.forge
      ? {
          provider: input.forge.provider.id,
          number: input.forge.number,
          url: input.forge.url,
          state: input.forge.state,
          isDraft: input.forge.isDraft,
          headRef: input.forge.headRef,
          baseRef: input.forge.baseRef,
          headCommit: input.forge.headCommit,
          contractId: input.forge.contractId,
          contractDigest: input.forge.contractDigest,
          requiredChecks: input.contract.verification.forgeChecks,
          checks: input.forge.checks,
        }
      : undefined,
    decision: input.decision,
    diagnostics: input.diagnostics,
  };
  return { ...partial, receiptId: receiptId(partial) };
}

function repositoryContractPath(root: string, sourcePath: string): string | undefined {
  const local = normalizeRepositoryPath(relative(resolve(root), resolve(sourcePath)));
  return local === ".." || local.startsWith("../") ? undefined : local;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function forgeCheckPassed(check: { status: string; conclusion?: string }): boolean {
  const status = check.status.toUpperCase();
  const conclusion = check.conclusion?.toUpperCase();
  if (conclusion) return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
  return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(status);
}
