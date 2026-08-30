import { randomUUID } from "node:crypto";

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
import { changedPaths, isPathAllowed, type RepositoryProvider } from "./repository.ts";
import type {
  ReconciliationCondition,
  ReconciliationResult,
  RepositoryContractIr,
  RepositoryReceipt,
  RouteDeclaration,
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

export async function reconcileOnce(
  request: ReconcileRequest,
  providers: ControlPlaneProviders,
): Promise<ReconciliationResult> {
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
  const memoryDiagnostics: string[] = [];
  if (providers.memory?.recall) {
    try {
      await providers.memory.recall({ contract: request.contract, workOrder });
    } catch (cause) {
      memoryDiagnostics.push(`memory recall degraded: ${errorMessage(cause)}`);
    }
  }
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
  const actual = [
    ...new Set([
      ...changedPaths(before, after),
      ...after.git.dirtyFiles.filter((path) => !before.git.dirtyFiles.includes(path)),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const scopeMatched = actual.every((path) => isPathAllowed(path, request.contract.scope));
  const verification = await providers.verifier.verify({
    root: request.root,
    contract: request.contract,
    workOrder,
  });
  const verifierStable = verifierDigestBefore === verification.verifierDigest;
  let forge;
  if (providers.forge && request.pullRequestNumber !== undefined) {
    forge = await providers.forge.observePullRequest({
      root: request.root,
      number: request.pullRequestNumber,
    });
  }
  const diagnostics = [...before.diagnostics, ...after.diagnostics, ...(harness.diagnostics ?? [])];
  if (!scopeMatched) diagnostics.push("one or more changed files fall outside declared scope");
  if (!verifierStable)
    diagnostics.push("verification definitions changed during harness execution");
  const forgeFailures: string[] = [];
  if (forge) {
    if (after.git.commit && forge.headCommit !== after.git.commit) {
      forgeFailures.push("pull request head does not match the locally verified commit");
    }
    if (
      forge.contractId !== request.contract.id ||
      forge.contractDigest !== request.contract.contractDigest
    ) {
      forgeFailures.push("pull request body is not bound to the verified Contract identity");
    }
    if (!forge.checks.length || forge.checks.some((check) => !forgeCheckPassed(check))) {
      forgeFailures.push("pull request checks are missing, pending, or unsuccessful");
    }
  }
  diagnostics.push(...forgeFailures);
  const forgeMatched = forgeFailures.length === 0;
  const decision: RepositoryReceipt["decision"] =
    harness.status === "blocked"
      ? "blocked"
      : harness.status === "completed" &&
          verification.ok &&
          verifierStable &&
          scopeMatched &&
          forgeMatched
        ? "verified"
        : "failed";
  conditions.push({
    type: "Verified",
    status: decision === "verified" ? "true" : "false",
    reason:
      decision === "verified"
        ? "independent checks, scope and forge identity are satisfied"
        : `verification decision: ${decision}`,
  });
  const partialReceipt: Omit<RepositoryReceipt, "receiptId"> = {
    receiptSchema: "repository.receipt/v1alpha1",
    operationIdentity: identity,
    contractId: request.contract.id,
    contractDigest: request.contract.contractDigest,
    observedRevisionBefore: before.observedRevision,
    observedRevisionAfter: after.observedRevision,
    commit: after.git.commit,
    invocationId,
    startedAt,
    finishedAt: now().toISOString(),
    harness: {
      id: harness.provider.id,
      version: harness.provider.version,
      status: harness.status,
      summary: harness.summary,
    },
    verifier: {
      id: verification.provider.id,
      version: verification.provider.version,
      digest: verification.verifierDigest,
    },
    scope: {
      declared: request.contract.scope.include,
      excluded: request.contract.scope.exclude,
      actual,
      matched: scopeMatched,
    },
    checks: verification.checks,
    forge: forge
      ? {
          provider: forge.provider.id,
          number: forge.number,
          url: forge.url,
          state: forge.state,
          isDraft: forge.isDraft,
          headRef: forge.headRef,
          baseRef: forge.baseRef,
          headCommit: forge.headCommit,
          contractId: forge.contractId,
          contractDigest: forge.contractDigest,
          checks: forge.checks,
        }
      : undefined,
    decision,
    diagnostics,
  };
  const receipt: RepositoryReceipt = {
    ...partialReceipt,
    receiptId: receiptId(partialReceipt),
  };
  const stored = await providers.receipts.append(receipt);
  conditions.push({ type: "Recorded", status: "true", reason: "append-only receipt recorded" });
  if (providers.memory?.notify) {
    try {
      await providers.memory.notify({ receipt });
    } catch (cause) {
      memoryDiagnostics.push(`memory notification degraded: ${errorMessage(cause)}`);
    }
  }
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

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function forgeCheckPassed(check: { status: string; conclusion?: string }): boolean {
  const status = check.status.toUpperCase();
  const conclusion = check.conclusion?.toUpperCase();
  if (conclusion) return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
  return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(status);
}
