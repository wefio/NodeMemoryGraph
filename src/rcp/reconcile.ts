import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";

import { attemptKey as workOrderAttemptKey, operationIdentity, planWorkOrder } from "./planner.ts";
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
  ReconciliationAttempt,
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
  recoverIncomplete?: boolean;
  executionTimeoutMs?: number;
}

interface PreparedReconciliation {
  now: () => Date;
  invocationId: string;
  conditions: ReconciliationCondition[];
  before: ObservedRepository;
  workOrder: WorkOrder;
  memoryDiagnostics: string[];
  identity: string;
  verifierDigestBefore: string;
  attemptKey: string;
  incompleteAttempt?: ReconciliationAttempt;
}

interface PreparationContext {
  now: () => Date;
  invocationId: string;
  conditions: ReconciliationCondition[];
  before: ObservedRepository;
  workOrder: WorkOrder;
  memoryDiagnostics: string[];
}

type Guarded<T> = { ok: true; value: T } | { ok: false; reason: string };

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
    executionTimeoutMs: request.executionTimeoutMs,
  });
  const memoryDiagnostics = await recallMemory(providers.memory, request.contract, workOrder);
  const context: PreparationContext = {
    now,
    invocationId,
    conditions,
    before,
    workOrder,
    memoryDiagnostics,
  };
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
    return terminalPreparation(request, context, "blocked");
  }
  if (requestedMode === "plan") {
    conditions.push({
      type: "Executed",
      status: "unknown",
      reason: "plan mode performs no mutation",
    });
    return terminalPreparation(request, context, "planned");
  }

  return prepareApplyReconciliation(request, providers, context);
}

async function prepareApplyReconciliation(
  request: ReconcileRequest,
  providers: ControlPlaneProviders,
  context: PreparationContext,
): Promise<PreparedReconciliation | ReconciliationResult> {
  const { before, workOrder } = context;
  if (!before.git.available) {
    return blockedPreparation(
      request,
      context,
      "Executed",
      "Git observation is required before apply",
    );
  }

  const verifierDigest = await guardProviderCall(
    () =>
      providers.verifier.definitionDigest({
        root: request.root,
        contract: request.contract,
        workOrder,
      }),
    "verifier definition unavailable",
  );
  if (!verifierDigest.ok) {
    return blockedPreparation(request, context, "Verified", verifierDigest.reason);
  }
  const verifierDigestBefore = verifierDigest.value;
  const identity = operationIdentity(workOrder, verifierDigestBefore);
  const attemptKey = workOrderAttemptKey(workOrder);
  const receiptLookup = await guardProviderCall(
    () => providers.receipts.find(identity),
    "invalid receipt evidence",
  );
  if (!receiptLookup.ok) {
    return blockedPreparation(request, context, "Recorded", receiptLookup.reason);
  }
  if (receiptLookup.value) {
    return reuseReceipt(request, providers.receipts, context, attemptKey, receiptLookup.value);
  }

  const attemptLookup = await guardProviderCall(
    () => providers.receipts.findIncomplete(attemptKey),
    "invalid in-flight attempt evidence",
  );
  if (!attemptLookup.ok) {
    return blockedPreparation(request, context, "Recorded", attemptLookup.reason);
  }
  const incompleteAttempt = attemptLookup.value;
  const attemptBlocker = incompleteAttemptBlocker(
    request,
    workOrder,
    attemptKey,
    incompleteAttempt,
  );
  if (attemptBlocker) {
    return blockedPreparation(request, context, attemptBlocker.type, attemptBlocker.reason);
  }

  return {
    ...context,
    identity,
    verifierDigestBefore,
    attemptKey,
    incompleteAttempt: incompleteAttempt ?? undefined,
  };
}

function terminalPreparation(
  request: ReconcileRequest,
  context: PreparationContext,
  status: "planned" | "blocked",
): ReconciliationResult {
  return {
    status,
    contract: request.contract,
    observation: context.before,
    workOrder: context.workOrder,
    conditions: context.conditions,
    memoryDiagnostics: context.memoryDiagnostics,
  };
}

function blockedPreparation(
  request: ReconcileRequest,
  context: PreparationContext,
  type: ReconciliationCondition["type"],
  reason: string,
): ReconciliationResult {
  context.conditions.push({ type, status: "false", reason });
  return terminalPreparation(request, context, "blocked");
}

async function guardProviderCall<T>(
  operation: () => Promise<T>,
  failure: string,
): Promise<Guarded<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (cause) {
    return { ok: false, reason: `${failure}: ${errorMessage(cause)}` };
  }
}

async function reuseReceipt(
  request: ReconcileRequest,
  receipts: ReceiptSink,
  context: PreparationContext,
  attemptKey: string,
  existing: NonNullable<Awaited<ReturnType<ReceiptSink["find"]>>>,
): Promise<ReconciliationResult> {
  try {
    await receipts.completeAttempt(attemptKey);
  } catch (cause) {
    context.memoryDiagnostics.push(`in-flight attempt cleanup degraded: ${errorMessage(cause)}`);
  }
  context.conditions.push(
    { type: "Executed", status: "true", reason: "existing operation receipt reused" },
    {
      type: "Verified",
      status: existing.receipt.decision === "verified" ? "true" : "false",
      reason: `existing receipt decision: ${existing.receipt.decision}`,
    },
    { type: "Recorded", status: "true", reason: "append-only receipt already exists" },
  );
  return {
    ...terminalPreparation(request, context, "blocked"),
    status: "reused",
    receipt: existing.receipt,
    receiptPath: existing.path,
  };
}

function incompleteAttemptBlocker(
  request: ReconcileRequest,
  workOrder: WorkOrder,
  attemptKey: string,
  attempt: ReconciliationAttempt | null,
): { type: ReconciliationCondition["type"]; reason: string } | undefined {
  if (!attempt) {
    return request.recoverIncomplete
      ? { type: "Executed", reason: "no incomplete attempt is available to recover" }
      : undefined;
  }
  const matchesRequest =
    attempt.attemptKey === attemptKey &&
    attempt.contractId === request.contract.id &&
    attempt.contractDigest === request.contract.contractDigest &&
    attempt.operationKey === workOrder.operationKey;
  if (!matchesRequest) {
    return {
      type: "Recorded",
      reason: "in-flight attempt does not match the active Contract and operation",
    };
  }
  return request.recoverIncomplete
    ? undefined
    : {
        type: "Executed",
        reason:
          "incomplete attempt exists; use explicit recovery to verify without replaying mutation",
      };
}

async function applyReconciliation(
  request: ReconcileRequest,
  providers: ControlPlaneProviders,
  prepared: PreparedReconciliation,
): Promise<ReconciliationResult> {
  const {
    now,
    invocationId,
    conditions,
    before,
    workOrder,
    memoryDiagnostics,
    identity,
    verifierDigestBefore,
    attemptKey,
    incompleteAttempt,
  } = prepared;
  const startedAt = incompleteAttempt?.startedAt ?? now().toISOString();
  if (!incompleteAttempt) {
    const attempt: ReconciliationAttempt = {
      attemptSchema: "repository.attempt/v1alpha1",
      attemptKey,
      operationIdentity: identity,
      contractId: request.contract.id,
      contractDigest: request.contract.contractDigest,
      operationKey: workOrder.operationKey,
      observedRevision: before.observedRevision,
      workOrderId: workOrder.id,
      verifierDigest: verifierDigestBefore,
      invocationId,
      startedAt,
    };
    try {
      await providers.receipts.beginAttempt(attempt);
    } catch (cause) {
      conditions.push({
        type: "Executed",
        status: "false",
        reason: `cannot record in-flight attempt: ${errorMessage(cause)}`,
      });
      return {
        status: "blocked",
        contract: request.contract,
        observation: before,
        workOrder,
        conditions,
        memoryDiagnostics,
      };
    }
  }
  const harness: HarnessResult = incompleteAttempt
    ? {
        provider: providers.harness.descriptor,
        status: "completed",
        summary: "recovering incomplete attempt by verifying the existing workspace without replay",
        artifacts: [],
      }
    : await executeHarness(providers.harness, workOrder);
  conditions.push({
    type: "Executed",
    status: harness.status === "completed" ? "true" : "false",
    reason: harness.summary,
  });
  const after = await observeAfter(request, providers.repository, before);
  const actual = submittedPaths(request.root, request.contract, before, after);
  const scopeMatched = actual.every((path) => isPathAllowed(path, request.contract.scope));
  const verification = await verifyAfter(
    request,
    providers.verifier,
    workOrder,
    verifierDigestBefore,
  );
  const verifierStable = verifierDigestBefore === verification.verifierDigest;
  const forgeResult = await observeForge(request, providers.forge);
  const forge = forgeResult.observation;
  const forgeFailures = [...forgeResult.failures, ...validateForge(forge, request.contract, after)];
  const provenanceMatched = after.git.available && forgeResult.failures.length === 0;
  const diagnostics = reconciliationDiagnostics({
    before,
    after,
    harness,
    scopeMatched,
    verifierStable,
    forgeFailures,
    provenanceMatched,
  });
  const forgeMatched = forgeFailures.length === 0;
  const decision = receiptDecision(
    harness,
    verification,
    verifierStable,
    scopeMatched,
    forgeMatched && provenanceMatched,
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
    workOrder,
  });
  let stored: Awaited<ReturnType<ReceiptSink["append"]>>;
  try {
    stored = await providers.receipts.append(receipt);
  } catch (cause) {
    conditions.push({
      type: "Recorded",
      status: "false",
      reason: `receipt storage failed: ${errorMessage(cause)}`,
    });
    return {
      status: "failed",
      contract: request.contract,
      observation: after,
      workOrder,
      conditions,
      receipt,
      memoryDiagnostics,
    };
  }
  try {
    await providers.receipts.completeAttempt(attemptKey);
  } catch (cause) {
    memoryDiagnostics.push(`in-flight attempt cleanup degraded: ${errorMessage(cause)}`);
  }
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

async function executeHarness(
  provider: HarnessProvider,
  workOrder: WorkOrder,
): Promise<HarnessResult> {
  try {
    return await provider.execute(workOrder);
  } catch (cause) {
    return {
      provider: provider.descriptor,
      status: "failed",
      summary: `harness provider failed: ${errorMessage(cause)}`,
      diagnostics: [errorMessage(cause)],
      artifacts: [],
    };
  }
}

async function observeAfter(
  request: ReconcileRequest,
  repository: RepositoryProvider,
  before: ObservedRepository,
): Promise<ObservedRepository> {
  try {
    return await repository.observe({ root: request.root, contract: request.contract });
  } catch (cause) {
    const failure = `post-execution repository observation failed: ${errorMessage(cause)}`;
    return {
      ...before,
      git: { available: false, dirtyFiles: [], error: failure },
      diagnostics: [...before.diagnostics, failure],
    };
  }
}

async function verifyAfter(
  request: ReconcileRequest,
  verifier: VerifierProvider,
  workOrder: WorkOrder,
  verifierDigestBefore: string,
): Promise<VerificationEvidence> {
  try {
    return await verifier.verify({
      root: request.root,
      contract: request.contract,
      workOrder,
    });
  } catch (cause) {
    const reason = `verifier provider failed: ${errorMessage(cause)}`;
    return {
      provider: verifier.descriptor,
      verifierDigest: verifierDigestBefore,
      ok: false,
      checks: workOrder.verificationChecks.map((name) => ({
        name,
        status: "failed",
        durationMs: 0,
        reason,
      })),
    };
  }
}

function reconciliationDiagnostics(input: {
  before: ObservedRepository;
  after: ObservedRepository;
  harness: HarnessResult;
  scopeMatched: boolean;
  verifierStable: boolean;
  forgeFailures: string[];
  provenanceMatched: boolean;
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
  if (!input.provenanceMatched) {
    diagnostics.push("repository or forge provenance could not be verified");
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
): string[] {
  // An external-workspace harness reports work that already exists when apply
  // starts, so before/after content comparison alone would certify an empty
  // change. In that mode every current dirty path is part of the submitted
  // workspace and must pass the Contract scope gate. Every harness verifies the
  // complete dirty workspace because a pre-existing out-of-scope change cannot
  // be attributed away from the bytes being certified.
  const contractInputPath = repositoryContractPath(root, contract.source.path);
  const submittedWorkspace = after.git.dirtyFiles.filter((path) => path !== contractInputPath);
  return [...new Set([...changedPaths(before, after), ...submittedWorkspace])].sort((left, right) =>
    left.localeCompare(right),
  );
}

async function observeForge(
  request: ReconcileRequest,
  forge: ForgeProvider | undefined,
): Promise<{ observation?: ForgeObservation; failures: string[] }> {
  if (!forge || request.pullRequestNumber === undefined) return { failures: [] };
  try {
    return {
      observation: await forge.observePullRequest({
        root: request.root,
        number: request.pullRequestNumber,
      }),
      failures: [],
    };
  } catch (cause) {
    return { failures: [`forge observation failed: ${errorMessage(cause)}`] };
  }
}

function validateForge(
  forge: ForgeObservation | undefined,
  contract: RepositoryContractIr,
  observation: ObservedRepository,
): string[] {
  if (!forge) return [];
  const failures: string[] = [];
  if (!observation.git.available || !observation.git.commit) {
    failures.push("Git commit is unavailable for pull request verification");
  } else if (observation.git.dirtyFiles.length) {
    failures.push("uncommitted workspace bytes cannot be bound to the pull request head");
  } else if (forge.headCommit !== observation.git.commit) {
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
  workOrder: WorkOrder;
}

function buildReceipt(input: BuildReceiptInput): RepositoryReceipt {
  const partial: Omit<RepositoryReceipt, "receiptId"> = {
    receiptSchema: "repository.receipt/v1alpha1",
    operationIdentity: input.identity,
    contractId: input.contract.id,
    contractDigest: input.contract.contractDigest,
    observedRevisionBefore: input.before.observedRevision,
    observedRevisionAfter: input.after.observedRevision,
    commit:
      input.after.git.available && input.after.git.dirtyFiles.length === 0
        ? input.after.git.commit
        : undefined,
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
    workOrder: {
      id: input.workOrder.id,
      routeDigest: input.workOrder.routeDigest,
      routes: input.workOrder.routes,
      verificationChecks: input.workOrder.verificationChecks,
      budget: input.workOrder.budget,
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
