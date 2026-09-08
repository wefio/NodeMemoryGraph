import { canonicalJson, digestCanonical } from "./canonical.ts";
import type { RepositoryReceipt } from "./types.ts";

export interface ReceiptValidation {
  valid: boolean;
  errors: string[];
}

export function validateReceipt(receipt: RepositoryReceipt): ReceiptValidation {
  const errors: string[] = [];
  validateReceiptIdentity(receipt, errors);
  validateWorkOrderBinding(receipt, errors);
  validateGate(receipt, errors);
  if (receipt.decision === "verified") validateVerifiedDecision(receipt, errors);
  const expectedId = receiptId({ ...receipt, receiptId: "" });
  if (receipt.receiptId !== expectedId) errors.push("receiptId does not match canonical content");
  return { valid: errors.length === 0, errors };
}

function validateReceiptIdentity(receipt: RepositoryReceipt, errors: string[]): void {
  if (receipt.receiptSchema !== "repository.receipt/v1alpha1") {
    errors.push("unsupported receipt schema");
  }
  if (!receipt.contractId || !receipt.contractDigest) errors.push("missing contract identity");
  if (!receipt.observedRevisionBefore || !receipt.observedRevisionAfter) {
    errors.push("missing observed revision binding");
  }
  if (!receipt.verifier.id || !receipt.verifier.digest) errors.push("missing verifier identity");
}

function validateGate(receipt: RepositoryReceipt, errors: string[]): void {
  const gate = receipt.gate;
  if (!gate || (gate.mode !== "narrow" && gate.mode !== "full")) {
    errors.push("missing or invalid verification gate");
    return;
  }
  if (gate.fullGateRun !== (gate.mode === "full")) {
    errors.push("gate.fullGateRun does not match gate.mode");
  }
  if (receipt.workOrder?.gate?.mode !== gate.mode) {
    errors.push("receipt gate does not match its work order gate");
  }
}

function validateWorkOrderBinding(receipt: RepositoryReceipt, errors: string[]): void {
  if (!receipt.workOrder?.id || !receipt.workOrder.routeDigest) {
    errors.push("missing work order identity");
  }
  if (
    !Array.isArray(receipt.workOrder?.routes) ||
    !Array.isArray(receipt.workOrder?.verificationChecks)
  ) {
    errors.push("missing work order route/check binding");
  }
  const budget = receipt.workOrder?.budget;
  if (
    budget?.maxAttempts !== 1 ||
    !Number.isSafeInteger(budget?.timeoutMs) ||
    (budget?.timeoutMs ?? 0) <= 0
  ) {
    errors.push("missing or invalid work order budget");
  }
}

function validateVerifiedDecision(receipt: RepositoryReceipt, errors: string[]): void {
  if (!receipt.scope.matched) errors.push("actual scope does not match declared scope");
  if (receipt.harness.status !== "completed") {
    errors.push("verified receipt has incomplete harness");
  }
  if (!receipt.checks.length || receipt.checks.some((check) => check.status !== "passed")) {
    errors.push("verified receipt requires every check to pass");
  }
  if (receipt.forge && (!receipt.commit || receipt.forge.headCommit !== receipt.commit)) {
    errors.push("verified forge receipt is not bound to its commit");
  }
}

export function receiptId(
  receipt: Omit<RepositoryReceipt, "receiptId"> | RepositoryReceipt,
): string {
  const value = JSON.parse(canonicalJson(receipt)) as Record<string, unknown>;
  delete value.receiptId;
  return digestCanonical(value);
}
